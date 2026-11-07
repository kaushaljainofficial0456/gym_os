// ============================================================
// AI CONTEXT ENGINE — /intelligence/aiContext.js
// Builds a COMPACT, domain-scoped context object for the AI coach
// from the client's REAL database rows. Only data the authenticated
// client (or their authorized trainer/owner) may see is ever
// included — context is built from client_id + org_id and nothing
// crosses tenants. Every number is MEASURED/CALCULATED; nothing is
// invented. Used by the recommendation engines AND as the prompt
// context for the LLM.
// ============================================================
import { dayKey, daysAgo } from '../../utils/time.js';

const GOAL_LABEL = { FAT_LOSS: 'fat loss', MUSCLE_GAIN: 'muscle gain', RECOMP: 'recomposition', STRENGTH: 'strength', GENERAL: 'general fitness', ENDURANCE: 'endurance', HABIT: 'habit building' };

const weekAgoKey = (tz) => dayKey(daysAgo(7), tz);

// ---------------- profile ----------------
export async function profileCtx(db, client) {
  const profile = await db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [client.id]);
  let equipment = [];
  try { equipment = profile?.equipment ? JSON.parse(profile.equipment) : []; } catch { /* keep [] */ }
  let exclusions = [];
  try { exclusions = profile?.food_exclusions ? String(profile.food_exclusions).split(',').map((s) => s.trim()).filter(Boolean) : []; } catch { /* keep [] */ }
  let injuries = [];
  try { injuries = profile?.injuries ? String(profile.injuries).split(',').map((s) => s.trim()).filter(Boolean) : []; } catch { /* keep [] */ }
  return {
    name: client.name || 'client',
    goal: GOAL_LABEL[client.goal] || client.goal,
    age: client.age ?? null,
    sex: client.sex ?? null,
    height_cm: client.height_cm ?? null,
    current_weight: client.current_weight ?? null,
    target_weight: client.target_weight ?? null,
    start_weight: client.start_weight ?? null,
    experience: profile?.experience || null,
    equipment: Array.isArray(equipment) ? equipment : [],
    diet_type: profile?.diet_type || null,
    cuisine: profile?.cuisine || null,
    food_exclusions: exclusions,
    injuries: injuries,
    meals_per_day: profile?.meals_per_day ?? null,
    sleep_target_h: profile?.sleep_target_h ?? 8,
    water_target_l: profile?.water_target_l ?? 3
  };
}

// ---------------- nutrition ----------------
export async function nutritionCtx(db, client, tz) {
  const d = dayKey(new Date(), tz);
  // 7-day average intake (excludes today so "today vs baseline" is honest)
  const wk = weekAgoKey(tz);
  const [plan, today, weekLogs, savedFoods] = await Promise.all([
    db.q1('SELECT * FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [client.id]),
    db.q('SELECT * FROM meal_logs WHERE client_id = ? AND date = ?', [client.id, d]),
    db.q('SELECT * FROM meal_logs WHERE client_id = ? AND date >= ? AND date < ?', [client.id, wk, d]),
    db.q('SELECT name, unit, serving, calories, protein, carbs, fat, source FROM foods WHERE client_id = ? ORDER BY name LIMIT 20', [client.id]),
  ]);
  const t = today.reduce((a, l) => ({ calories: a.calories + (l.calories || 0), protein: a.protein + (l.protein || 0), carbs: a.carbs + (l.carbs || 0), fat: a.fat + (l.fat || 0) }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const daysWithLogs = new Set(weekLogs.map((l) => l.date)).size;
  const weekSum = weekLogs.reduce((a, l) => ({ calories: a.calories + (l.calories || 0), protein: a.protein + (l.protein || 0) }), { calories: 0, protein: 0 });
  return {
    daily_target: plan ? { calories: plan.calories, protein: plan.protein, carbs: plan.carbs, fat: plan.fat } : null,
    today: { ...t, meals: today.length, date: d },
    week_avg: daysWithLogs ? {
      days_logged: daysWithLogs,
      calories: daysWithLogs ? Math.round(weekSum.calories / daysWithLogs) : null,
      protein: daysWithLogs ? Math.round((weekSum.protein / daysWithLogs) * 10) / 10 : null
    } : null,
    saved_foods: savedFoods.map((f) => `${f.name} (${f.serving || f.unit})`) 
  };
}

// ---------------- training ----------------
export async function trainingCtx(db, client, tz) {
  const d = dayKey(new Date(), tz);
  const dow = (new Date().getDay() + 6) % 7; // 0=Mon
  const dayName = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'][dow];
  const sundayDow = (dow + 1) % 7;
  const wk = weekAgoKey(tz);
  const [todayPlan, todayProgram, recent, doneToday] = await Promise.all([
    db.q1(
      `SELECT cw.name AS workout_name
         FROM client_workout_schedule cws
         LEFT JOIN client_workouts cw ON cw.id = cws.workout_id
        WHERE cws.client_id = ? AND cws.day_of_week = ?`, [client.id, dow]),
    db.q1(
      `SELECT td.name, tp.name AS program_name
         FROM training_days td JOIN training_programs tp ON tp.id = td.program_id
        WHERE tp.client_id = ? AND tp.active = 1 AND td.day_of_week = ?`, [client.id, sundayDow]),
    db.q(
      `SELECT wl.date, wl.weight, wl.reps, wl.sets_done, el.name AS exercise
         FROM workout_logs wl LEFT JOIN exercise_library el ON el.id = wl.exercise_id
        WHERE wl.client_id = ? AND wl.date >= ?
        ORDER BY wl.date DESC, wl.created_at DESC, wl.id DESC LIMIT 30`, [client.id, wk]),
    db.q1('SELECT id FROM workout_logs WHERE client_id = ? AND date = ? LIMIT 1', [client.id, d]),
  ]);
  const last5 = recent.slice(0, 5).map((r) => `${r.date}: ${r.exercise || 'workout'} ${r.weight || 'BW'}kg × ${r.reps || 0} (${r.sets_done || 0} sets)`);
  return {
    today_workout: todayPlan?.workout_name || todayProgram?.name || null,
    today_done: !!doneToday,
    day: dayName,
    week_workouts: recent.length,
    recent_sessions: last5,
    week_sets: recent.reduce((a, r) => a + (r.sets_done || 0), 0)
  };
}

// ---------------- progress / trends ----------------
export async function progressCtx(db, client, tz) {
  const [weights, metrics, prs] = await Promise.all([
    db.q('SELECT weight, date FROM weight_logs WHERE client_id = ? ORDER BY date ASC', [client.id]),
    db.q(
      `SELECT m.id, m.name, m.unit, m.target, e.value, e.date
         FROM custom_metrics m LEFT JOIN metric_entries e ON e.metric_id = m.id
        WHERE m.client_id = ? ORDER BY e.date DESC LIMIT 30`, [client.id]),
    db.q(
      `SELECT el.name, wl.weight, wl.reps, wl.date FROM workout_logs wl
         LEFT JOIN exercise_library el ON el.id = wl.exercise_id
        WHERE wl.client_id = ? AND wl.is_pr = 1 ORDER BY wl.date DESC LIMIT 5`, [client.id]),
  ]);
  const series = weights.map((w) => ({ date: w.date, weight: w.weight }));
  const trend = (n) => {
    const slice = series.slice(-n);
    if (slice.length < 2) return null;
    return Math.round((slice[slice.length - 1].weight - slice[0].weight) * 10) / 10;
  };
  return {
    weight: {
      count: series.length,
      latest: series.length ? series[series.length - 1].weight : null,
      trend_7d: trend(7),
      trend_14d: trend(14),
      trend_30d: trend(30),
      direction: trend(14) == null ? null : trend(14) < -0.4 ? 'losing' : trend(14) > 0.4 ? 'gaining' : 'stable'
    },
    custom_metrics: metrics.slice(0, 10).map((m) => (m.name ? `${m.name}: ${m.value}${m.unit || ''}` : null)).filter(Boolean),
    recent_prs: prs.map((p) => `${p.name}: ${p.weight}kg × ${p.reps} (${p.date})`)
  };
}

// ---------------- recovery ----------------
export async function recoveryCtx(db, client, tz) {
  const d = dayKey(new Date(), tz);
  const wk = weekAgoKey(tz);
  const [sleeps, water] = await Promise.all([
    db.q('SELECT duration_h FROM sleep_logs WHERE client_id = ? AND date >= ?', [client.id, wk]),
    db.q1('SELECT litres FROM water_logs WHERE client_id = ? AND date = ?', [client.id, d]),
  ]);
  const avgSleep = sleeps.length ? Math.round((sleeps.reduce((a, s) => a + (s.duration_h || 0), 0) / sleeps.length) * 10) / 10 : null;
  return { sleep_7d_avg_h: avgSleep, water_today_l: water?.litres ?? null };
}

// ---------------- gym ----------------
export async function gymCtx(db, orgId, tz) {
  try {
    const { computeOccupancy } = await import('./occupancy.js');
    const occ = await computeOccupancy(db, orgId, tz, {});
    return { crowd: occ?.enabled ? { current: occ.current, capacity: occ.capacity, status: occ.status } : null };
  } catch { return { crowd: null }; }
}

// ---------------- AI memory (structured preferences) ----------------
export async function memoryCtx(db, client) {
  const rows = await db.q('SELECT key, value FROM ai_memory WHERE org_id = ? AND client_id = ?', [client.org_id, client.id]);
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

// ==================================================================
// buildClientAIContext — the single entry point. `domains` filters
// which slices are retrieved (cost control — only what the question
// needs). Returns a compact plain object safe to send to the LLM.
// ==================================================================
//
// The domains are independent, read-only slices, so they are fetched
// concurrently. They used to be awaited one after another, which made the
// coach brief (6 domains, ~15 reads) wait on ~15 sequential database round
// trips -- the slowest request on the client Home screen, which loads both
// the brief and the weekly review on every visit. The object is still
// assembled in `domains` order, so its key order (it is serialized into
// LLM prompts) is unchanged.
const DOMAIN_READERS = {
  profile: (db, client) => profileCtx(db, client),
  nutrition: (db, client, tz) => nutritionCtx(db, client, tz),
  training: (db, client, tz) => trainingCtx(db, client, tz),
  progress: (db, client, tz) => progressCtx(db, client, tz),
  recovery: (db, client, tz) => recoveryCtx(db, client, tz),
  gym: (db, client, tz) => gymCtx(db, client.org_id, tz),
  memory: (db, client) => memoryCtx(db, client),
};

export async function buildClientAIContext(db, client, { domains = ['profile', 'nutrition', 'training', 'progress', 'recovery', 'gym', 'memory'] } = {}, tz = 'Asia/Kolkata') {
  const known = domains.filter((dom) => DOMAIN_READERS[dom]);
  const values = await Promise.all(known.map((dom) => DOMAIN_READERS[dom](db, client, tz)));
  const ctx = {};
  known.forEach((dom, i) => { ctx[dom] = values[i]; });
  return ctx;
}
