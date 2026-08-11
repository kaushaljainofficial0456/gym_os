// ============================================================
// PERSONAL RECORDS — computed only from COMPLETED sets with real
// weight/reps. Tracks heaviest weight, best reps at that weight,
// estimated 1RM (Epley: w * (1 + reps/30)) and best set volume.
// Recommendations are labelled as estimates, not guarantees.
// ============================================================
import { id, now } from '../ids.js';

export const PR_TYPES = [
  { type: 'heaviest_weight', label: 'Heaviest weight' },
  { type: 'best_reps', label: 'Most reps at weight' },
  { type: 'est_1rm', label: 'Estimated 1RM' },
  { type: 'best_volume', label: 'Best set volume' }
];

const EPS = 1e-9;

// sets: [{ actual_weight, actual_reps, completed }] — only completed count.
export function computePRCandidates(sets) {
  const done = (sets || []).filter(s => s.completed !== 0 && s.completed !== false && Number(s.actual_weight) > 0 && Number(s.actual_reps) >= 1);
  if (!done.length) return null;
  let heaviest = { w: 0, r: 0 };
  for (const s of done) {
    const w = Number(s.actual_weight), r = Number(s.actual_reps);
    if (w > heaviest.w) heaviest = { w, r };
    else if (w === heaviest.w && r > heaviest.r) heaviest = { w, r };
  }
  const oneRepMax = Math.max(...done.map(s => Number(s.actual_weight) * (1 + Number(s.actual_reps) / 30)));
  const bestVolume = Math.max(...done.map(s => Number(s.actual_weight) * Number(s.actual_reps)));
  return {
    heaviest_weight: { value: heaviest.w, weight: heaviest.w, reps: heaviest.r },
    best_reps: { value: heaviest.r, weight: heaviest.w, reps: heaviest.r },
    est_1rm: { value: round2(oneRepMax), weight: heaviest.w, reps: heaviest.r },
    best_volume: { value: round2(bestVolume), weight: null, reps: null }
  };
}

// Baseline from existing workout history (used when no PR rows exist yet,
// so pre-existing performance isn't ignored on first evaluation).
// Aggregate logs carry best weight/reps — volume/1RM are approximate.
async function historyBaseline(db, clientId, exerciseId, beforeDate) {
  const h = await db.q1(
    `SELECT MAX(weight) AS max_w, MAX(reps) AS max_r FROM workout_logs
      WHERE client_id = ? AND exercise_id = ? AND date < ?`,
    [clientId, exerciseId, beforeDate]);
  if (!h?.max_w || h.max_w <= 0) return {};
  return {
    heaviest_weight: { value: h.max_w },
    best_reps: { value: h.max_r || 0 },
    est_1rm: { value: round2(h.max_w * (1 + (h.max_r || 1) / 30)) },
    best_volume: { value: round2(h.max_w * (h.max_r || 0)) }
  };
}

// Returns new PRs: [{ type, label, value, previous, weight, reps, date }]
export async function evaluatePRs(db, clientId, exerciseId, sets, date) {
  const candidates = computePRCandidates(sets);
  if (!candidates) return [];
  const prs = [];
  const existing = await db.q(
    'SELECT type, value FROM personal_records WHERE client_id = ? AND exercise_id = ?', [clientId, exerciseId]);
  const existingByType = new Map(existing.map(e => [e.type, e.value]));
  const baseline = existing.length === 0 ? await historyBaseline(db, clientId, exerciseId, date) : {};
  for (const { type, label } of PR_TYPES) {
    const cand = candidates[type];
    if (!cand) continue;
    const prev = existingByType.get(type) ?? baseline[type]?.value;
    if (prev === undefined || cand.value > prev + EPS) {
      const prevValue = prev !== undefined ? prev : null;
      await db.run(
        `INSERT INTO personal_records (id, client_id, exercise_id, type, value, weight, reps, date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (client_id, exercise_id, type) DO UPDATE SET
           value = excluded.value, weight = excluded.weight, reps = excluded.reps, date = excluded.date, created_at = excluded.created_at`,
        [id('pr_'), clientId, exerciseId, type, cand.value, cand.weight, cand.reps, date, now()]);
      prs.push({ type, label, value: cand.value, previous: prevValue, weight: cand.weight, reps: cand.reps, date });
    }
  }
  return prs;
}

function round2(v) { return Math.round(v * 100) / 100; }
