// ============================================================
// SK OS MEMORY / CONTEXT — /intelligence/context.js
// Retrieves REAL client context from the database for contextual
// questions ("How much protein have I eaten?", "What did I bench
// last week?", "Why am I plateauing?"). Every number is measured
// or calculated from actual rows — nothing is invented. Answers
// carry provenance labels (MEASURED / CALCULATED / ESTIMATED /
// RECOMMENDATION).
// ============================================================
import { dayKey, daysAgo } from '../../utils/time.js';

function weekAgoKey(tz) {
  return dayKey(daysAgo(7), tz);
}

const GOAL_LABEL = { FAT_LOSS: 'fat loss', MUSCLE_GAIN: 'muscle gain', RECOMP: 'recomposition', STRENGTH: 'strength', GENERAL: 'general fitness' };

// --- protein / calories eaten today ---
export async function todayNutrition(db, client, tz) {
  const d = dayKey(new Date(), tz);
  const logs = await db.q('SELECT * FROM meal_logs WHERE client_id = ? AND date = ?', [client.id, d]);
  const totals = logs.reduce((a, l) => ({
    calories: a.calories + (l.calories || 0),
    protein: a.protein + (l.protein || 0),
    carbs: a.carbs + (l.carbs || 0),
    fat: a.fat + (l.fat || 0)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const plan = await db.q1('SELECT * FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [client.id]);
  return { date: d, meals: logs.length, totals, plan: plan ? { calories: plan.calories, protein: plan.protein } : null };
}

// --- last week's performance for one exercise ---
export async function lastPerformance(db, clientId, exerciseName, tz) {
  const weekAgo = weekAgoKey(tz);
  const rows = await db.q(
    `SELECT wl.date, wl.weight, wl.reps, wl.sets_done, el.name
       FROM workout_logs wl
       LEFT JOIN exercise_library el ON el.id = wl.exercise_id
      WHERE wl.client_id = ? AND wl.date >= ?
        AND (LOWER(el.name) LIKE LOWER(?) OR LOWER(wl.notes) LIKE LOWER(?))
      ORDER BY wl.date DESC LIMIT 8`,
    [clientId, weekAgo, `%${exerciseName}%`, `%${exerciseName}%`]);
  return rows;
}

// --- weight trend (plateau / gain / loss) ---
export async function weightTrend(db, client) {
  const rows = await db.q(
    'SELECT * FROM weight_logs WHERE client_id = ? ORDER BY date ASC',
    [client.id]);
  if (!rows.length) return null;
  const series = rows.map((r) => ({ date: r.date, weight: r.weight }));
  const first = series[0].weight;
  const last = series[series.length - 1].weight;
  const recent = series.slice(-4);
  const drift = recent.length > 1 ? recent[recent.length - 1].weight - recent[0].weight : 0;
  const twoWeek = series.slice(-14);
  const trend = twoWeek.length > 1 ? twoWeek[twoWeek.length - 1].weight - twoWeek[0].weight : 0;
  return {
    series, first, last, drift: Math.round(drift * 10) / 10,
    trend: Math.round(trend * 10) / 10,
    plateau: Math.abs(trend) < 0.5 && series.length >= 3,
    direction: trend < -0.4 ? 'losing' : trend > 0.4 ? 'gaining' : 'stable',
    target: client.target_weight ?? null, goal: client.goal,
    goalLabel: GOAL_LABEL[client.goal] || client.goal
  };
}

// --- today's training: schedule + plan + recent volume ---
export async function todayTraining(db, client, tz) {
  const d = dayKey(new Date(), tz);
  // Monday-based day-of-week index (0=Mon .. 6=Sun)
  const dow = (new Date().getDay() + 6) % 7;
  const dayName = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'][dow];
  // client's own planner schedule
  const today = await db.q1(
    `SELECT cws.day_of_week, cw.id AS workout_id, cw.name AS workout_name
       FROM client_workout_schedule cws
       LEFT JOIN client_workouts cw ON cw.id = cws.workout_id
      WHERE cws.client_id = ? AND cws.day_of_week = ?`, [client.id, dow]);
  // assigned program workouts for today
  // training_days uses 0=Sun..6=Sat — convert from the Monday-based dow
  const sundayDow = (dow + 1) % 7;
  const programDay = await db.q1(
    `SELECT td.id, td.name, tp.name AS program_name
       FROM training_days td
       JOIN training_programs tp ON tp.id = td.program_id
      WHERE tp.client_id = ? AND tp.active = 1 AND td.day_of_week = ?`,
    [client.id, sundayDow]);
  // recent volume (last 7 days)
  const weekAgo = weekAgoKey(tz);
  const logs = await db.q(
    'SELECT date, weight, reps, sets_done FROM workout_logs WHERE client_id = ? AND date >= ?',
    [client.id, weekAgo]);
  return { date: d, dayName, schedule: today, programDay, loggedWorkouts: logs.length, weekVolumeSets: logs.reduce((a, l) => a + (l.sets_done || 0), 0) };
}

// --- profile context used for AI coach framing ---
export async function clientProfileContext(db, client) {
  const profile = await db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [client.id]);
  const equipment = (() => {
    try { return profile?.equipment ? JSON.parse(profile.equipment) : []; } catch { return []; }
  })();
  return {
    name: client.name || 'client',
    goal: GOAL_LABEL[client.goal] || client.goal,
    currentWeight: client.current_weight, targetWeight: client.target_weight,
    experience: profile?.experience || null,
    equipment: Array.isArray(equipment) ? equipment : [],
    waterTargetL: profile?.water_target_l ?? 3,
    sleepTargetH: profile?.sleep_target_h ?? 8
  };
}
