// ============================================================
// WEEKLY VOLUME ANALYSIS — estimated training-volume contribution.
// Weighting is a transparent, configurable heuristic — NOT a medical
// claim. PRIMARY involvement counts 1.0 set, SECONDARY 0.5.
//   chest(PRIMARY) 4 sets  -> 4.0
//   triceps(SECONDARY) 4    -> 2.0
// Targets come from muscles.target_sets_min/max (trainer guidance).
// ============================================================
import { daysAgoIso, round1 } from '../utils/time.js';
import { normalizeMuscle, MUSCLES } from './muscles.js';

export const ROLE_WEIGHT = { PRIMARY: 1.0, SECONDARY: 0.5 };

// Configurable by the caller; overrides muscle table defaults.
export const DEFAULT_TARGETS = Object.fromEntries(MUSCLES.map(m => [m.id, [m.min, m.max]]));

export function statusFor(sets, [lo, hi]) {
  if (sets < lo) return 'UNDERTRAINED';
  if (sets > hi) return 'HIGH_VOLUME';
  return 'BALANCED';
}

// Fallback muscle derivation from legacy string columns — mirrors the fallback
// inside muscles.getExerciseMuscles, kept pure here so weeklyVolume can batch
// ALL muscle lookups in one query instead of one per log (N+1 fix).
function deriveMusclesFallback(primary, secondary) {
  const out = [];
  const p = normalizeMuscle(primary);
  if (p) {
    const m = MUSCLES.find((x) => x.id === p);
    out.push({ role: 'PRIMARY', id: p, name: m?.name, region: m?.region, view: m?.view });
  }
  if (secondary) {
    for (const name of String(secondary).split(',')) {
      const id = normalizeMuscle(name.trim());
      if (id && id !== p) {
        const m = MUSCLES.find((x) => x.id === id);
        out.push({ role: 'SECONDARY', id, name: m?.name, region: m?.region, view: m?.view });
      }
    }
  }
  return out;
}

export async function weeklyVolume(db, clientId, { days = 7, targets = DEFAULT_TARGETS } = {}) {
  const since = daysAgoIso(days);
  const logs = await db.q(
    `SELECT wl.id, wl.exercise_id, wl.date, wl.sets_done FROM workout_logs wl
      WHERE wl.client_id = ? AND wl.date >= ? ORDER BY wl.date`, [clientId, since]);

  const logIds = logs.map((l) => l.id);
  const exerciseIds = [...new Set(logs.map((l) => l.exercise_id).filter(Boolean))];
  const inQ = (n) => n.map(() => '?').join(',');

  // Batch 1: completed per-set counts for ALL logs in one query (kills the N+1).
  const setCountRows = logIds.length
    ? await db.q(
        `SELECT workout_log_id, COUNT(*) AS n FROM exercise_set_logs
          WHERE workout_log_id IN (${inQ(logIds)}) AND completed = 1 GROUP BY workout_log_id`, logIds)
    : [];
  const setsByLog = new Map(setCountRows.map((r) => [r.workout_log_id, Number(r.n)]));

  // Batch 2: exercise metadata + muscle roles in two queries (kills per-log lookups).
  const exRows = exerciseIds.length
    ? await db.q(
        `SELECT id, movement, name, primary_muscle, secondary_muscles FROM exercise_library
          WHERE id IN (${inQ(exerciseIds)})`, exerciseIds)
    : [];
  const exById = new Map(exRows.map((e) => [e.id, e]));
  const muscleRows = exerciseIds.length
    ? await db.q(
        `SELECT em.exercise_id, em.role, m.id, m.name, m.region, m.view
           FROM exercise_muscles em JOIN muscles m ON m.id = em.muscle_id
          WHERE em.exercise_id IN (${inQ(exerciseIds)})`, exerciseIds)
    : [];
  const musclesByEx = new Map();
  for (const r of muscleRows) {
    if (!musclesByEx.has(r.exercise_id)) musclesByEx.set(r.exercise_id, []);
    musclesByEx.get(r.exercise_id).push({ role: r.role, id: r.id, name: r.name, region: r.region, view: r.view });
  }

  const perMuscle = new Map();  // muscleId -> { sets, min, max, name, region, view }
  const perMovement = new Map();
  let totalSets = 0, weightedTotal = 0;

  for (const log of logs) {
    // prefer completed per-set rows; else the aggregate sets_done
    const sets = setsByLog.get(log.id) ?? log.sets_done ?? 0;
    if (!sets) continue;
    totalSets += sets;
    const ex = log.exercise_id ? exById.get(log.exercise_id) || null : null;
    const muscles = musclesByEx.get(log.exercise_id) || deriveMusclesFallback(ex?.primary_muscle, ex?.secondary_muscles);
    for (const m of muscles) {
      const w = ROLE_WEIGHT[m.role] || 0.5;
      const contrib = sets * w;
      weightedTotal += contrib;
      const cur = perMuscle.get(m.id) || { sets: 0, min: targets[m.id]?.[0] ?? 6, max: targets[m.id]?.[1] ?? 14, name: m.name, region: m.region, view: m.view };
      cur.sets += contrib;
      perMuscle.set(m.id, cur);
    }
    if (ex?.movement) {
      perMovement.set(ex.movement, (perMovement.get(ex.movement) || 0) + sets);
    } else if (log.exercise_id) {
      const id = normalizeMovement(ex?.name || '');
      perMovement.set(id, (perMovement.get(id) || 0) + sets);
    }
  }

  const muscles = [...perMuscle.entries()].map(([id, v]) => ({
    id,
    name: v.name,
    region: v.region,
    view: v.view,
    sets: round1(v.sets),
    min: v.min,
    max: v.max,
    status: statusFor(v.sets, [v.min, v.max])
  })).sort((a, b) => b.sets - a.sets);

  const movements = [...perMovement.entries()]
    .map(([movement, sets]) => ({ movement, sets }))
    .sort((a, b) => b.sets - a.sets);

  return {
    days,
    muscles,
    movements,
    totalSets,
    weightedTotal: round1(weightedTotal),
    note: 'Estimated training volume contribution (primary sets count 1.0, secondary 0.5). Training guidance, not a medical claim.'
  };
}

function normalizeMovement(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('squat') || n.includes('leg press')) return 'squat';
  if (n.includes('deadlift') || n.includes('rdl') || n.includes('hinge')) return 'hinge';
  if (n.includes('lunge')) return 'lunge';
  if (n.includes('row') || n.includes('pull') || n.includes('lat')) return 'vertical_pull';
  if (n.includes('press') || n.includes('bench') || n.includes('push-up')) return 'horizontal_push';
  if (n.includes('curl')) return 'isolation';
  if (n.includes('plank') || n.includes('crunch')) return 'core';
  return 'compound';
}
