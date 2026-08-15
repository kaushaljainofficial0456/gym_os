// ============================================================
// CALORIE MODEL — the ONLY backend service responsible for
// calorie estimation (workout energy expenditure).
//
//   workout → feature extraction → calorieModel → estimate
//                                     ↓
//                        workout persistence → API response
//
// The service NEVER owns route handling and NEVER writes to the
// database by itself: it returns an estimate and callers persist it
// via persistCalorieResult(). The backend remains the sole writer —
// an ML provider can never touch PostgreSQL directly.
//
// Providers (env CALORIE_MODEL_PROVIDER, default 'baseline'):
//   baseline — deterministic MET-based heuristic. Clearly a baseline,
//              NOT ML. Always available.
//   mock     — fixed demo values for UI/test development only.
//   ml       — Sambhav's model. Not implemented yet; falls back to
//              baseline until configured, so the API never breaks.
//
// The frontend never learns which provider ran — only the persistence
// layer records it (workouts.calorie_provider). Do not expose model
// credentials or provider internals in any API response.
//
// INPUT CONTRACT (schema_version '0.1'): see docs/calorie-model-contract.md
// ============================================================
import { dayKey } from '../../utils/time.js';

export const CALORIE_SCHEMA_VERSION = '0.1';
export const BASELINE_MODEL_VERSION = 'skos-cal-baseline-v1';
export const MOCK_MODEL_VERSION = 'skos-cal-mock-v1';
export const DEFAULT_BODY_WEIGHT_KG = 70;

// MET (metabolic equivalent) for resistance training by effort level.
// Standard references: light ~3.0, moderate ~4.5, vigorous ~6.0.
export const INTENSITY_MET = { light: 3.0, moderate: 4.5, hard: 6.0 };

const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

export function resolveProvider() {
  const p = String(process.env.CALORIE_MODEL_PROVIDER || 'baseline').toLowerCase();
  return ['baseline', 'mock', 'ml'].includes(p) ? p : 'baseline';
}

// ------------------------------------------------------------------
// ESTIMATE — public entry point. Always returns a well-formed result;
// never throws for provider reasons (an unavailable ML provider falls
// back to baseline).
// ------------------------------------------------------------------
export function estimateWorkoutCalories(input = {}) {
  const provider = resolveProvider();
  if (provider === 'mock') return mockEstimate();
  if (provider === 'ml') {
    try {
      const r = mlEstimate(input);
      if (r && Number.isFinite(r.estimated_active_kcal)) return { ...r, provider: 'ml', schema_version: CALORIE_SCHEMA_VERSION };
    } catch (e) {
      // fall through to baseline — the API must never break on ML availability
    }
    return { ...baselineEstimate(input), provider: 'baseline', note: 'ml provider unavailable — baseline fallback' };
  }
  return baselineEstimate(input);
}

// ------------------------------------------------------------------
// BASELINE provider — deterministic MET heuristic (labeled, not ML).
//   active kcal = MET × 3.5 × body_weight_kg ÷ 200 × duration_min
// Range is ±15%. When a measured duration is absent the duration is
// estimated from completed sets (never claimed as measured).
// ------------------------------------------------------------------
export function baselineEstimate(input = {}) {
  const bw = pos(input?.user?.body_weight_kg) || DEFAULT_BODY_WEIGHT_KG;
  const intensity = normalizeIntensity(input?.session?.intensity_rating);
  const met = INTENSITY_MET[intensity] ?? INTENSITY_MET.moderate;
  const durationMin = pos(input?.session?.duration_minutes) ?? estimateDurationMinutes(input);
  const active = (met * 3.5 * bw) / 200 * durationMin;
  return {
    schema_version: CALORIE_SCHEMA_VERSION,
    estimated_active_kcal: Math.round(active),
    lower_kcal: Math.round(active * 0.85),
    upper_kcal: Math.round(active * 1.15),
    model_version: BASELINE_MODEL_VERSION,
    provider: 'baseline',
    method: 'MET heuristic: MET × 3.5 × body_weight_kg ÷ 200 × duration_min (baseline, not ML)'
  };
}

// ------------------------------------------------------------------
// MOCK provider — fixed demo values, clearly labeled. UI/test only.
// ------------------------------------------------------------------
function mockEstimate() {
  return {
    schema_version: CALORIE_SCHEMA_VERSION,
    estimated_active_kcal: 300,
    lower_kcal: 250,
    upper_kcal: 350,
    model_version: MOCK_MODEL_VERSION,
    provider: 'mock',
    note: 'mock provider — fixed demo values, not a real estimate'
  };
}

// ------------------------------------------------------------------
// ML provider — Sambhav's integration point.
// Implement by replacing this body (or the whole file's provider
// wiring) with a call into the trained model, keeping the SAME output
// shape: { estimated_active_kcal, lower_kcal, upper_kcal, model_version }.
// The service stays the single choke point — routes and frontend do
// not change when the model lands.
// ------------------------------------------------------------------
function mlEstimate(/* input */) {
  throw new Error('calorie ml provider not implemented yet — using baseline fallback');
}

// ------------------------------------------------------------------
// Feature extraction — builds the structured INPUT contract from
// ACTUAL per-set data (exercise_set_logs). Planned workload from
// workout_exercises is NEVER used as actual calorie workload.
// ------------------------------------------------------------------
export function buildWorkoutCalorieInput({ client, workout, exercises = [], setsByExercise = {}, durationSeconds = null, bodyWeightKg = null } = {}) {
  const allSets = [];
  const mapped = exercises.map((we) => {
    const lib = we.library || null;
    const completed = (setsByExercise[we.id] || []).filter((s) => s.completed !== 0 && s.completed !== false);
    for (const s of completed) allSets.push(s);
    return {
      exercise_id: we.exercise_id || we.name || null,
      exercise_type: lib?.ex_type || we.ex_type || 'compound',
      muscle_group: normalizeMuscleName(lib?.primary_muscle || we.primary_muscle || null),
      equipment: lib?.equipment || we.equipment || null,
      movement_pattern: lib?.movement || we.movement || null,
      compound_or_isolation: classifyCompound(lib?.ex_type || we.ex_type, lib?.movement || we.movement),
      completed_sets: completed.map((s, i) => ({
        set_number: s.set_number ?? i + 1,
        reps: pos(s.actual_reps) ?? 0,
        weight_kg: pos(s.actual_weight) ?? 0,
        rir: s.rir ?? null,
        rest_seconds: s.rest_seconds ?? null,
        completed: 1
      }))
    };
  });

  const durationMin = pos(durationSeconds) != null ? Math.round((durationSeconds / 60) * 10) / 10 : null;
  return {
    schema_version: CALORIE_SCHEMA_VERSION,
    user: {
      age_years: client?.age != null ? Number(client.age) : null,
      sex: client?.sex ? String(client.sex).toLowerCase() : null,
      height_cm: pos(client?.height_cm),
      body_weight_kg: pos(bodyWeightKg)
    },
    session: {
      workout_id: workout?.id || null,
      duration_seconds: pos(durationSeconds),
      duration_minutes: durationMin,
      intensity_rating: inferIntensity(allSets)
    },
    exercises: mapped
  };
}

// Total completed sets across the input (skipped exercises contribute 0).
export function completedSetCount(input) {
  return (input?.exercises || []).reduce((n, e) => n + (e.completed_sets || []).length, 0);
}

// Estimate duration from completed sets when no measured duration exists.
// Reuses the same per-set math as the old session preview so behavior is
// consistent. The result is an ESTIMATE, never presented as measured.
export function estimateDurationMinutes(input = {}) {
  const sets = (input?.exercises || []).flatMap((e) => e.completed_sets || []);
  if (!sets.length) return 30;
  const rests = sets.map((s) => pos(s.rest_seconds)).filter(Number.isFinite);
  const avgRest = rests.length ? rests.reduce((a, b) => a + b, 0) / rests.length : 90;
  return Math.max(15, Math.round(sets.length * (1.6 + avgRest / 60)));
}

// ------------------------------------------------------------------
// Body weight at workout time (Phase 11).
//   Preference order (documented in docs/TEAM-CONTRACT.md):
//     1. nearest weight_logs entry at/before the workout day
//     2. clients.current_weight
//     3. clients.start_weight
//     4. clients.target_weight
//   Returns null when nothing is available — callers may pass the
//   service's DEFAULT_BODY_WEIGHT_KG at estimation time.
// ------------------------------------------------------------------
export async function resolveBodyWeight(db, clientId, workoutDate) {
  const d = workoutDate || dayKey();
  const log = await db.q1(
    `SELECT weight FROM weight_logs WHERE client_id = ? AND date <= ? ORDER BY date DESC, created_at DESC LIMIT 1`,
    [clientId, d]);
  if (log?.weight) return Number(log.weight);
  const c = await db.q1('SELECT current_weight, start_weight, target_weight FROM clients WHERE id = ?', [clientId]);
  if (!c) return null;
  return c.current_weight || c.start_weight || c.target_weight || null;
}

// Persist a calorie result onto the workout row (backend-only writer).
export async function persistCalorieResult(db, workoutId, result) {
  await db.run(
    `UPDATE workouts SET
       estimated_active_kcal = ?, lower_kcal = ?, upper_kcal = ?,
       model_version = ?, schema_version = ?, calorie_provider = ?, calorie_estimated_at = ?
     WHERE id = ?`,
    [result?.estimated_active_kcal ?? null, result?.lower_kcal ?? null, result?.upper_kcal ?? null,
     result?.model_version ?? null, result?.schema_version ?? null, result?.provider ?? null,
     new Date().toISOString(), workoutId]);
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------
function normalizeIntensity(rating) {
  const r = String(rating || '').toLowerCase();
  if (['light', 'easy', 'low'].includes(r)) return 'light';
  if (['hard', 'vigorous', 'high', 'intense'].includes(r)) return 'hard';
  return 'moderate';
}

// Derive an intensity rating from actual set RIRs (RIR 0-1 ≈ hard,
// 2-3 ≈ moderate, 4+ ≈ light). No RIR data → moderate.
function inferIntensity(sets) {
  const rirs = sets.map((s) => pos(s.rir)).filter(Number.isFinite);
  if (!rirs.length) return 'moderate';
  const avg = rirs.reduce((a, b) => a + b, 0) / rirs.length;
  if (avg <= 1) return 'hard';
  if (avg <= 3) return 'moderate';
  return 'light';
}

// Normalize a legacy muscle string (e.g. "CHEST" / "UPPER CHEST") to a
// canonical lowercase id. Kept local to avoid a muscles.js import cycle;
// mirrors the ALIASES table in services/muscles.js.
function normalizeMuscleName(name) {
  if (!name) return null;
  const n = String(name).toUpperCase().trim();
  const MAP = {
    'CHEST': 'chest', 'UPPER CHEST': 'upper_chest', 'SHOULDERS': 'shoulders',
    'SIDE DELTS': 'side_delts', 'REAR DELTS': 'rear_delts', 'DELTS': 'shoulders',
    'TRICEPS': 'triceps', 'BICEPS': 'biceps', 'FOREARMS': 'forearms',
    'TRAPS': 'traps', 'LATS': 'lats', 'UPPER BACK': 'upper_back',
    'LOWER BACK': 'lower_back', 'GLUTES': 'glutes', 'HAMSTRINGS': 'hamstrings',
    'QUADS': 'quads', 'CALVES': 'calves', 'CORE': 'core', 'ABS': 'abs',
    'ABDOMINALS': 'core', 'POSTERIOR CHAIN': 'posterior_chain', 'FRONT DELTS': 'shoulders'
  };
  return MAP[n] || n.toLowerCase() || null;
}

// compound vs isolation — from ex_type when explicit, else inferred
// from the movement pattern.
function classifyCompound(exType, movement) {
  if (exType === 'isolation') return 'isolation';
  if (exType === 'compound') return 'compound';
  const m = String(movement || '');
  if (m && !['isolation', 'carry', 'core'].includes(m)) return 'compound';
  return 'isolation';
}
