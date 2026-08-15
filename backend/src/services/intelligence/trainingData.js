// ============================================================
// TRAINING-DATA EXTRACTION — read-only bridge between the running
// system and the ML training pipeline (Sambhav).
//
//   completed workouts → actual exercise_set_logs → client
//   profile → library metadata → buildWorkoutCalorieInput
//                       ↓
//            JSONL dataset (features + provenance)
//
// Guarantees (see docs/training-data-contract.md):
//   * READ-ONLY — never writes to the database
//   * features are produced by the SAME contract-0.2 choke point
//     (buildWorkoutCalorieInput) the routes use, so the dataset
//     cannot drift from docs/calorie-model-contract.md
//   * actual completed sets only; is_synthesized=1 sets are
//     dropped BEFORE aggregation and counted, never workload
//   * skipped exercises contribute 0 workload
//   * duration carries MEASURED values only (null when no
//     started_at) — estimates are never written into features
//   * the label slot is null — no reliable ground truth exists;
//     persisted baseline estimates are surfaced separately and
//     are NOT training labels (contract doc §4)
//   * no PII: names, emails, notes, instructions are never read
//     into the output — only opaque app tokens are exported
// ============================================================
import { dayKey } from '../../utils/time.js';
import { buildWorkoutCalorieInput, resolveBodyWeight } from './calorieModel.js';

export const TRAINING_SCHEMA_VERSION = '0.2';
export const DEFAULT_BATCH_SIZE = 100;

// Async generator over the dataset: yields one record per completed
// workout with ≥ 1 real completed set. `db` is the shared adapter
// (q / q1 surface). Workouts are paged by completed_at so memory
// stays bounded on large databases.
//
// Optional `stats` object is mutated with counts (scanned, written,
// noRealSets, ambiguous, failed) for the CLI summary — never payloads.
export async function* extractTrainingDataset(db, { limit = DEFAULT_BATCH_SIZE, offset = 0, stats = null } = {}) {
  // Stats fields are defined once the object is passed, so callers can
  // rely on them being numbers (0 when nothing was counted).
  if (stats) {
    stats.scanned = stats.scanned || 0;
    stats.written = stats.written || 0;
    stats.noRealSets = stats.noRealSets || 0;
    stats.ambiguous = stats.ambiguous || 0;
    stats.failed = stats.failed || 0;
  }
  let cursor = offset;
  for (;;) {
    const workouts = await db.q(
      `SELECT id, org_id, client_id, scheduled_date, status, completed_at, started_at,
              estimated_active_kcal, lower_kcal, upper_kcal, model_version,
              schema_version, calorie_provider
         FROM workouts
        WHERE status = 'completed' AND completed_at IS NOT NULL
        ORDER BY completed_at, id
        LIMIT ? OFFSET ?`,
      [limit, cursor]);
    if (!workouts.length) return;
    for (const w of workouts) {
      if (stats) stats.scanned = (stats.scanned || 0) + 1;
      let out;
      try {
        out = await buildWorkoutRecord(db, w);
      } catch (e) {
        // Never let one bad workout kill the export. Safe correlation
        // metadata only — opaque workout id + truncated message.
        if (stats) stats.failed = (stats.failed || 0) + 1;
        console.warn('[sk-os] training-data: skipped workout', {
          workout_id: w.id, error: String(e?.message || e).slice(0, 300)
        });
        continue;
      }
      if (!out) continue;
      if (out.skip === 'no_real_sets') { if (stats) stats.noRealSets = (stats.noRealSets || 0) + 1; continue; }
      if (out.skip === 'ambiguous_name_only') { if (stats) stats.ambiguous = (stats.ambiguous || 0) + 1; continue; }
      if (stats) stats.written = (stats.written || 0) + 1;
      yield out.record;
    }
    cursor += limit;
  }
}

// Build one dataset record for a completed workout, or a { skip }
// marker when the workout has nothing usable to train on.
//   { record }                      → exported
//   { skip: 'no_real_sets' }        → zero real completed sets (all synthesized / none)
//   { skip: 'ambiguous_name_only' } → multiple name-only exercises make
//                                     set attribution impossible — never guess
export async function buildWorkoutRecord(db, w) {
  // Planned exercises + canonical library metadata (same join the
  // routes use to feed the calorie input).
  const planned = await db.q(
    `SELECT we.*, el.ex_type, el.movement, el.equipment AS lib_equipment,
            el.primary_muscle AS lib_primary_muscle
       FROM workout_exercises we
       LEFT JOIN exercise_library el ON el.id = we.exercise_id
      WHERE we.workout_id = ?
      ORDER BY we.position`, [w.id]);

  // Actual per-set rows for the workout (via workout_logs join).
  const setRows = await db.q(
    `SELECT es.*
       FROM exercise_set_logs es
       JOIN workout_logs wl ON es.workout_log_id = wl.id
      WHERE wl.workout_id = ?
      ORDER BY es.exercise_id, es.set_number`, [w.id]);

  // ---- attribution: set rows → planned exercise ----
  // Set rows carry the LIBRARY exercise id (not the workout_exercise
  // id the client logs against). Group by library id and map each
  // group to the first matching planned exercise. Name-only rows
  // (exercise_id IS NULL) are attributed by exclusion; when several
  // name-only exercises exist the workout is skipped rather than
  // guessed. Duplicate library exercises in one workout collapse
  // into a single per-exercise entry (session totals are unaffected).
  const byLib = new Map(); // library id (or 'nameonly') -> real set rows
  let synthesizedExcluded = 0;
  for (const s of setRows) {
    if (s.is_synthesized) { synthesizedExcluded++; continue; } // never training workload
    if (s.completed === 0 || s.completed === false) continue;  // incomplete — not workload
    const key = s.exercise_id ?? 'nameonly';
    if (!byLib.has(key)) byLib.set(key, []);
    byLib.get(key).push(s);
  }

  const nameOnly = planned.filter((e) => !e.exercise_id);
  if (nameOnly.length > 1 && byLib.has('nameonly')) return { skip: 'ambiguous_name_only' };

  const reps = [];           // planned-exercise objects for the choke point
  const setsByExercise = {}; // keyed by workout_exercise id
  const claimed = new Set(); // library ids already represented
  for (const e of planned) {
    const libKey = e.exercise_id ?? 'nameonly';
    if (libKey !== 'nameonly') {
      if (claimed.has(e.exercise_id)) continue; // duplicate library exercise — collapse
      claimed.add(e.exercise_id);
    }
    const sets = byLib.get(libKey) || [];
    reps.push({
      id: e.id,
      exercise_id: e.exercise_id,
      name: e.name,
      ex_type: e.ex_type,
      movement: e.movement,
      equipment: e.lib_equipment,
      primary_muscle: e.lib_primary_muscle,
      library: { ex_type: e.ex_type, movement: e.movement, equipment: e.lib_equipment, primary_muscle: e.lib_primary_muscle }
    });
    if (sets.length) setsByExercise[e.id] = sets;
  }

  const realSets = Object.values(setsByExercise).reduce((n, s) => n + s.length, 0);
  if (!realSets) return { skip: 'no_real_sets' }; // nothing usable to train on

  const client = await db.q1('SELECT age, sex, height_cm FROM clients WHERE id = ?', [w.client_id]);
  const durationSeconds = measuredDurationSeconds(w);
  const sessionDay = w.scheduled_date || (w.completed_at ? dayKey(new Date(w.completed_at)) : dayKey());
  const bodyWeightKg = await resolveBodyWeight(db, w.client_id, sessionDay);

  // The single feature-engineering choke point — the running routes
  // call exactly this function with the same shapes.
  const input = buildWorkoutCalorieInput({
    client: client || undefined,
    workout: w,
    exercises: reps,
    setsByExercise,
    durationSeconds,
    bodyWeightKg
  });

  return {
    record: {
      schema_version: TRAINING_SCHEMA_VERSION,
      workout_id: w.id,
      client_id: w.client_id,
      org_id: w.org_id,
      completed_at: w.completed_at,
      scheduled_date: w.scheduled_date,
      duration_measured: durationSeconds != null,
      synthesized_sets_excluded: synthesizedExcluded,
      // EXACT contract-0.2 input payload (docs/calorie-model-contract.md §2).
      features: input,
      // Reserved label slot — no reliable ground truth exists yet.
      // Never fabricated (contract doc §4).
      label: { kcal: null, source: null, ground_truth: false },
      // Persisted estimate at completion time — baseline/mock/model
      // OUTPUT, explicitly NOT ground truth.
      baseline_estimate: w.estimated_active_kcal != null
        ? {
            kcal: w.estimated_active_kcal,
            model_version: w.model_version || null,
            provider: w.calorie_provider || null
          }
        : null
    }
  };
}

// Measured duration only: completed_at − started_at (server-authoritative).
// No started_at (e.g. NL-logged sessions) → null — never an estimate.
function measuredDurationSeconds(w) {
  if (!w.started_at || !w.completed_at) return null;
  const ms = Date.parse(w.completed_at) - Date.parse(w.started_at);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null;
}
