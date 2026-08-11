// ============================================================
// ADHERENCE SCORE — definition (not arbitrary)
// Rolling 7-day window. Weighted composite of six components:
//
//   COMPONENT              WEIGHT   FORMULA
//   workoutCompletion       35%     completed workouts / scheduled workouts in window
//                                   (100 if nothing scheduled — nothing to miss)
//   nutritionAdherence      20%     planned meals marked eaten / planned meals (window)
//   proteinAdherence        15%     protein eaten / protein target (cap 100%)
//   waterAdherence          10%     avg litres / daily target (cap 100%)
//   sleepAdherence          10%     avg duration / sleep target (cap 100%)
//   checkinConsistency      10%     100 if a check-in (weight log / measurement)
//                                   exists in the window, else 0
//
// If a component is not applicable (e.g. no nutrition plan assigned),
// its weight is removed and the remaining weights are renormalized.
// Over-achievement on protein/water/sleep is capped at 100% (extra credit
// is not awarded — only under-delivery counts against the score).
// ============================================================
import { daysAgoIso, todayKey, clamp, round1 } from '../utils/time.js';

const WEIGHTS = {
  workout: 35,
  nutrition: 20,
  protein: 15,
  water: 10,
  sleep: 10,
  checkin: 10
};

// Pure per-client calculation from already-fetched rows. Shared by the
// single-client and bulk paths so the definition can never drift.
function adherenceFromData({ client, profile, plan, workouts, meals, logs, waterLogs, sleepLogs }, { endDate = todayKey(), days = 7 } = {}) {
  const start = daysAgoIso(days);

  // ---- workout completion ----
  let workout = null;
  if (workouts.length) {
    const done = workouts.filter(w => w.status === 'completed').length;
    workout = round1((done / workouts.length) * 100);
  }

  // ---- nutrition + protein ----
  let nutrition = null, protein = null;
  if (plan) {
    const logByKey = new Map(logs.map(l => [`${l.date}|${l.meal_id}`, l]));
    let eaten = 0;
    for (let i = 0; i < days; i++) {
      const d = daysAgoIso(days - 1 - i);
      for (const meal of meals) {
        const l = logByKey.get(`${d}|${meal.id}`);
        if (l && l.eaten) eaten++;
      }
    }
    nutrition = round1((eaten / (meals.length * days)) * 100);

    const target = plan.protein * days;
    const eatenProtein = logs.reduce((s, l) => s + (l.eaten ? l.protein : 0), 0);
    protein = target > 0 ? round1(clamp((eatenProtein / target) * 100, 0, 100)) : null;
  }

  // ---- water ----
  const waterTarget = (profile?.water_target_l ?? 3) * days;
  let water = null;
  if (waterTarget > 0) {
    const total = waterLogs.reduce((s, w) => s + w.litres, 0);
    water = round1(clamp((total / waterTarget) * 100, 0, 100));
  }

  // ---- sleep ----
  const sleepTarget = profile?.sleep_target_h ?? 8;
  let sleep = null;
  if (sleepLogs.length) {
    const avg = sleepLogs.reduce((s, l) => s + l.duration_h, 0) / sleepLogs.length;
    sleep = round1(clamp((avg / sleepTarget) * 100, 0, 100));
  }

  // ---- check-in consistency ----
  const lastCheckin = client?.last_checkin_at;
  let checkin = null;
  if (lastCheckin) {
    checkin = lastCheckin.slice(0, 10) >= start ? 100 : 0;
  }

  // ---- weighted composite with renormalization ----
  const components = { workout, nutrition, protein, water, sleep, checkin };
  let totalWeight = 0, scoreSum = 0;
  const detail = {};
  for (const [key, w] of Object.entries(WEIGHTS)) {
    if (components[key] !== null) {
      totalWeight += w;
      scoreSum += components[key] * w;
      detail[key] = { value: components[key], weight: w };
    }
  }
  const score = totalWeight > 0 ? round1(scoreSum / totalWeight) : 0;

  return {
    clientId: client.id,
    score,
    components,            // raw percentages (null = not applicable)
    weights: WEIGHTS,
    applicableWeights: detail,
    window: { start, end: endDate, days }
  };
}

export async function computeAdherence(db, clientId, opts = {}) {
  const { endDate = todayKey(), days = 7 } = opts;
  const start = daysAgoIso(days);
  const [client, profile, plan] = await Promise.all([
    db.q1('SELECT * FROM clients WHERE id = ?', [clientId]),
    db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [clientId]),
    db.q1('SELECT * FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [clientId])
  ]);
  if (!client) return null;
  const [workouts, meals, logs, waterLogs, sleepLogs] = await Promise.all([
    db.q(`SELECT status FROM workouts WHERE client_id = ? AND scheduled_date >= ? AND scheduled_date <= ?`, [clientId, start, endDate]),
    plan ? db.q('SELECT * FROM meals WHERE plan_id = ?', [plan.id]) : Promise.resolve([]),
    plan ? db.q(`SELECT * FROM meal_logs WHERE client_id = ? AND date >= ? AND date <= ?`, [clientId, start, endDate]) : Promise.resolve([]),
    db.q(`SELECT litres FROM water_logs WHERE client_id = ? AND date >= ? AND date <= ?`, [clientId, start, endDate]),
    db.q(`SELECT duration_h FROM sleep_logs WHERE client_id = ? AND date >= ? AND date <= ?`, [clientId, start, endDate])
  ]);
  return adherenceFromData({ client, profile, plan, workouts, meals, logs, waterLogs, sleepLogs }, opts);
}

// Bulk variant: computes adherence for MANY clients in ~8 queries total
// (one per table, filtered with IN (...) and GROUP BY client_id) instead of
// ~7 queries per client. Returns Map(clientId -> adherence).
export async function computeAdherenceBulk(db, clients, opts = {}) {
  const { endDate = todayKey(), days = 7 } = opts;
  const start = daysAgoIso(days);
  const ids = clients.map(c => c.id);
  const inClause = ids.map(() => '?').join(',');
  if (!ids.length) return new Map();
  const clientMap = new Map(clients.map(c => [c.id, c]));

  const [profiles, plans, workouts, meals, logs, waterLogs, sleepLogs] = await Promise.all([
    db.q(`SELECT * FROM client_profiles WHERE client_id IN (${inClause})`, ids),
    db.q(`SELECT * FROM nutrition_plans WHERE client_id IN (${inClause}) ORDER BY created_at DESC`, ids),
    db.q(`SELECT client_id, status FROM workouts WHERE client_id IN (${inClause}) AND scheduled_date >= ? AND scheduled_date <= ?`, [...ids, start, endDate]),
    db.q(`SELECT id, plan_id FROM meals WHERE plan_id IN (SELECT id FROM nutrition_plans WHERE client_id IN (${inClause}))`, ids),
    db.q(`SELECT * FROM meal_logs WHERE client_id IN (${inClause}) AND date >= ? AND date <= ?`, [...ids, start, endDate]),
    db.q(`SELECT client_id, litres FROM water_logs WHERE client_id IN (${inClause}) AND date >= ? AND date <= ?`, [...ids, start, endDate]),
    db.q(`SELECT client_id, duration_h FROM sleep_logs WHERE client_id IN (${inClause}) AND date >= ? AND date <= ?`, [...ids, start, endDate])
  ]);

  const profileBy = new Map(profiles.map(p => [p.client_id, p]));
  const planBy = new Map();
  for (const p of plans) { if (!planBy.has(p.client_id)) planBy.set(p.client_id, p); } // latest per client (ordered desc)
  const mealsByPlan = new Map();
  for (const m of meals) {
    if (!mealsByPlan.has(m.plan_id)) mealsByPlan.set(m.plan_id, []);
    mealsByPlan.get(m.plan_id).push(m);
  }
  const workoutsBy = new Map(); const logsBy = new Map(); const waterBy = new Map(); const sleepBy = new Map();
  for (const w of workouts) { (workoutsBy.get(w.client_id) || workoutsBy.set(w.client_id, []).get(w.client_id)).push(w); }
  for (const l of logs) { (logsBy.get(l.client_id) || logsBy.set(l.client_id, []).get(l.client_id)).push(l); }
  for (const w of waterLogs) { (waterBy.get(w.client_id) || waterBy.set(w.client_id, []).get(w.client_id)).push(w); }
  for (const s of sleepLogs) { (sleepBy.get(s.client_id) || sleepBy.set(s.client_id, []).get(s.client_id)).push(s); }

  const out = new Map();
  for (const c of clients) {
    const plan = planBy.get(c.id) || null;
    out.set(c.id, adherenceFromData({
      client: c,
      profile: profileBy.get(c.id) || null,
      plan,
      workouts: workoutsBy.get(c.id) || [],
      meals: plan ? mealsByPlan.get(plan.id) || [] : [],
      logs: plan ? logsBy.get(c.id) || [] : [],
      waterLogs: waterBy.get(c.id) || [],
      sleepLogs: sleepBy.get(c.id) || []
    }, opts));
  }
  return out;
}

// Persist a snapshot row (called after compute + on seed).
export async function snapshotAdherence(db, clientId) {
  const a = await computeAdherence(db, clientId);
  await db.run(
    `INSERT INTO adherence_records
       (id, client_id, date, score, workout, nutrition, protein, water, sleep, checkin, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'adr_' + Math.random().toString(36).slice(2, 12),
      clientId, a.window.end, a.score,
      a.components.workout, a.components.nutrition, a.components.protein,
      a.components.water, a.components.sleep, a.components.checkin,
      JSON.stringify(a)
    ]);
  return a;
}
