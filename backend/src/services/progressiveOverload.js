// ============================================================
// PROGRESSIVE OVERLOAD — next-target suggestion (v2, set-aware).
// Uses ACTUAL per-set performance (exercise_set_logs) when available,
// falling back to the legacy aggregate workout_logs.
// Logic (trainer-configurable):
//   1. Compare the last two sessions by best weight and rep coverage.
//   2. Last session matched/beat the previous best weight AND every
//      completed set hit the prescribed reps  -> suggest weight + increment.
//   3. Weight maintained but reps fell short    -> keep weight, +1 rep target.
//   4. Weight dropped or sets incomplete        -> hold (repeat the load).
// Increment: default 2.5 kg barbell / 5% (rounded) dumbbell, overridable.
// Recommendations are labelled as suggestions, not guarantees.
// ============================================================
import { round1 } from '../utils/time.js';

export async function getExerciseHistory(db, clientId, exerciseId, limit = 8) {
  // prefer per-set history
  const rows = await db.q(
    `SELECT wl.id AS log_id, wl.date, es.set_number, es.actual_reps, es.actual_weight, es.completed
       FROM exercise_set_logs es
       JOIN workout_logs wl ON wl.id = es.workout_log_id
      WHERE wl.client_id = ? AND wl.exercise_id = ?
      ORDER BY wl.date ASC, es.set_number ASC
      LIMIT ?`, [clientId, exerciseId, limit * 12]);
  if (rows.length) {
    const sessions = [];
    const byLog = new Map();
    for (const r of rows) {
      if (!byLog.has(r.log_id)) byLog.set(r.log_id, { date: r.date, sets: [] });
      if (r.completed && (Number(r.actual_weight) > 0 || Number(r.actual_reps) > 0)) {
        byLog.get(r.log_id).sets.push({ reps: Number(r.actual_reps) || 0, weight: Number(r.actual_weight) || 0 });
      }
    }
    for (const s of byLog.values()) if (s.sets.length) sessions.push(s);
    if (sessions.length) return sessions.slice(-limit);
  }
  const agg = await db.q(
    `SELECT date, weight, reps, sets_done FROM workout_logs
      WHERE client_id = ? AND exercise_id = ?
      ORDER BY date ASC LIMIT ?`, [clientId, exerciseId, limit]);
  return agg.map(a => ({
    date: a.date,
    sets: Array.from({ length: a.sets_done || 1 }, () => ({ reps: a.reps || 0, weight: a.weight || 0 }))
  }));
}

export async function suggestNextTarget(db, clientId, exerciseId, options = {}) {
  const history = await getExerciseHistory(db, clientId, exerciseId);
  if (!history.length) return null;

  const last = history[history.length - 1];
  const prev = history[history.length - 2];

  const bestOf = (session) => session.sets.reduce(
    (b, s) => (s.weight > b.weight || (s.weight === b.weight && s.reps > b.reps) ? s : b),
    { weight: 0, reps: 0 });

  const lastBest = bestOf(last);
  const prevBest = prev ? bestOf(prev) : null;

  const dumbbell = (options.isDumbbell ?? false) || /dumbbell/i.test(options.exerciseName || '');
  const increment = options.weightIncrement
    ? Number(options.weightIncrement)
    : dumbbell ? Math.max(1, round1(lastBest.weight * 0.05)) : 2.5;

  const prescReps = options.prescribedReps ? Number(options.prescribedReps) : null;
  const prescSets = options.prescribedSets ? Number(options.prescribedSets) : last.sets.length;
  const avgReps = last.sets.length ? last.sets.reduce((s, x) => s + x.reps, 0) / last.sets.length : 0;
  const hitReps = prescReps ? last.sets.every(s => s.reps >= prescReps) : avgReps >= 5;
  const completedAll = last.sets.length >= prescSets;
  const matchedPrev = !prevBest || lastBest.weight >= prevBest.weight;

  let suggested = { weight: lastBest.weight, reps: Math.max(1, Math.round(lastBest.reps)) };
  let rationale;
  let progress = false;

  if (last.sets.length === 0 || lastBest.reps <= 0) {
    rationale = 'No completed sets in the last session — hold the load.';
  } else if (!prevBest) {
    rationale = 'First session logged — repeat the same load to establish a baseline before progressing.';
  } else if (matchedPrev && hitReps && completedAll) {
    suggested.weight = round1((lastBest.weight + increment) * 2) / 2;
    suggested.reps = prescReps || lastBest.reps;
    progress = true;
    rationale = `All ${last.sets.length} sets hit ${prescReps || lastBest.reps} reps at ${lastBest.weight}kg — progress weight by ${increment}kg.`;
  } else if (matchedPrev && !hitReps) {
    suggested.reps = Math.max(1, Math.ceil(avgReps) + 1);
    rationale = `Weight maintained but reps fell short (avg ${round1(avgReps)}) — add a rep before adding weight.`;
  } else if (!matchedPrev) {
    rationale = `Weight dropped vs the previous session (${lastBest.weight}kg vs ${prevBest.weight}kg) — repeat at the same load.`;
  } else {
    rationale = 'Incomplete session — hold the load and finish all prescribed sets first.';
  }

  return {
    exerciseId,
    current: { weight: lastBest.weight, reps: lastBest.reps, date: last.date, sets: last.sets.length },
    suggested,
    increment: progress ? increment : 0,
    rationale,
    progress,
    sessions: history.slice(-5).map(s => ({ date: s.date, sets: s.sets })),
    data: { sessions: history.slice(-5), prescribedReps: prescReps, prescribedSets: prescSets }
  };
}
