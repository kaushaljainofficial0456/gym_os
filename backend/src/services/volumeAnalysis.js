// ============================================================
// WEEKLY VOLUME ANALYSIS — estimated training-volume contribution.
// Weighting is a transparent, configurable heuristic — NOT a medical
// claim. PRIMARY involvement counts 1.0 set, SECONDARY 0.5.
//   chest(PRIMARY) 4 sets  -> 4.0
//   triceps(SECONDARY) 4    -> 2.0
// Targets come from muscles.target_sets_min/max (trainer guidance).
// ============================================================
import { daysAgoIso, round1 } from '../utils/time.js';
import { getExerciseMuscles, MUSCLES } from './muscles.js';

export const ROLE_WEIGHT = { PRIMARY: 1.0, SECONDARY: 0.5 };

// Configurable by the caller; overrides muscle table defaults.
export const DEFAULT_TARGETS = Object.fromEntries(MUSCLES.map(m => [m.id, [m.min, m.max]]));

export function statusFor(sets, [lo, hi]) {
  if (sets < lo) return 'UNDERTRAINED';
  if (sets > hi) return 'HIGH_VOLUME';
  return 'BALANCED';
}

// sets done for a workout log: prefer completed per-set rows, else sets_done
async function setsForLog(db, log) {
  const rows = await db.q1(
    `SELECT COUNT(*) AS n FROM exercise_set_logs WHERE workout_log_id = ? AND completed = 1`, [log.id]);
  if (rows?.n > 0) return rows.n;
  return log.sets_done || 0;
}

export async function weeklyVolume(db, clientId, { days = 7, targets = DEFAULT_TARGETS } = {}) {
  const since = daysAgoIso(days);
  const logs = await db.q(
    `SELECT wl.id, wl.exercise_id, wl.date, wl.sets_done FROM workout_logs wl
      WHERE wl.client_id = ? AND wl.date >= ? ORDER BY wl.date`, [clientId, since]);

  const perMuscle = new Map();  // muscleId -> { sets, min, max, name, region, view }
  const perMovement = new Map();
  let totalSets = 0, weightedTotal = 0;

  for (const log of logs) {
    const sets = await setsForLog(db, log);
    if (!sets) continue;
    totalSets += sets;
    const ex = log.exercise_id
      ? await db.q1('SELECT movement, name FROM exercise_library WHERE id = ?', [log.exercise_id])
      : null;
    const muscles = await getExerciseMuscles(db, log.exercise_id);
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
