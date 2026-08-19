import { Router } from 'express';
import { requireAuth, orgScope, resolveClient } from '../auth.js';
import { validate, schemas } from '../validate.js';
import { id, now } from '../ids.js';
import { dayKey, getOrgTz } from '../utils/time.js';
import { computeAdherence } from '../services/adherence.js';
import { generateCoachMessage } from '../services/aiCoach.js';
import { todaySession, getActiveProgram, getProgramDays } from '../services/trainingProgram.js';
import { track } from '../services/events.js';

export default function trackingRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);

  // ---- water ----
  r.post('/clients/:id/water', validate(schemas.waterLog), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const d = req.body.date || dayKey();
    const existing = await db.q1('SELECT id FROM water_logs WHERE client_id = ? AND date = ?', [client.id, d]);
    if (existing) await db.run('UPDATE water_logs SET litres = ? WHERE id = ?', [req.body.litres, existing.id]);
    else await db.run('INSERT INTO water_logs (id, client_id, date, litres) VALUES (?, ?, ?, ?)',
      [id('wat'), client.id, d, req.body.litres]);
    res.json({ ok: true });
  });

  // ---- sleep ----
  r.post('/clients/:id/sleep', validate(schemas.sleepLog), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const d = req.body.date || dayKey();
    const existing = await db.q1('SELECT id FROM sleep_logs WHERE client_id = ? AND date = ?', [client.id, d]);
    const vals = [req.body.duration_h, req.body.bed_time || null, req.body.wake_time || null, req.body.source];
    if (existing) {
      await db.run('UPDATE sleep_logs SET duration_h = ?, bed_time = ?, wake_time = ?, source = ? WHERE id = ?',
        [...vals, existing.id]);
    } else {
      await db.run(
        `INSERT INTO sleep_logs (id, client_id, date, bed_time, wake_time, duration_h, target_h, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('slp'), client.id, d, req.body.bed_time || null, req.body.wake_time || null,
         req.body.duration_h, 8, req.body.source]);
    }
    res.json({ ok: true });
  });

  // ---- supplements ----
  r.get('/clients/:id/supplements', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    res.json({ supplements: await db.q('SELECT * FROM supplements WHERE client_id = ? AND active = 1', [client.id]) });
  });

  r.post('/clients/:id/supplements', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const b = req.body || {};
    await db.run(
      `INSERT INTO supplements (id, client_id, name, dose, schedule_time, active) VALUES (?, ?, ?, ?, ?, 1)`,
      [id('sup'), client.id, b.name || 'Supplement', b.dose || null, b.schedule_time || null]);
    res.status(201).json({ ok: true });
  });

  // ---- client workout history (client portal) ----
  r.get('/me/workouts', async (req, res) => {
    if (req.user.role !== 'CLIENT') return res.status(403).json({ error: 'Client portal only' });
    const client = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!client) return res.status(404).json({ error: 'Client profile not found' });
    const workouts = await db.q(
      'SELECT * FROM workouts WHERE client_id = ? ORDER BY scheduled_date DESC LIMIT 20', [client.id]);
    const withEx = [];
    for (const w of workouts) {
      const ex = await db.q(
        `SELECT we.*, el.animation_key, el.primary_muscle
           FROM workout_exercises we
           LEFT JOIN exercise_library el ON el.id = we.exercise_id
          WHERE we.workout_id = ? ORDER BY we.position`, [w.id]);
      withEx.push({ ...w, exercises: ex });
    }
    res.json({ workouts: withEx });
  });

  // ---- client progress bundle (client portal) ----
  r.get('/me/progress', async (req, res) => {
    if (req.user.role !== 'CLIENT') return res.status(403).json({ error: 'Client portal only' });
    const client = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!client) return res.status(404).json({ error: 'Client profile not found' });
    const [weights, adherence, measurements, photos, supplements] = await Promise.all([
      db.q('SELECT date, weight FROM weight_logs WHERE client_id = ? ORDER BY date', [client.id]),
      db.q('SELECT date, score FROM adherence_records WHERE client_id = ? ORDER BY date DESC LIMIT 14', [client.id]),
      db.q('SELECT * FROM measurements WHERE client_id = ? ORDER BY taken_at DESC LIMIT 8', [client.id]),
      db.q('SELECT id, view, taken_at, storage_key, data_url, is_before FROM progress_photos WHERE client_id = ? ORDER BY taken_at', [client.id]).then(async (rows) => {
        const { objectUrl } = await import('../storage.js');
        return rows.map((p) => ({ id: p.id, view: p.view, taken_at: p.taken_at, is_before: p.is_before, imageUrl: objectUrl(p.storage_key) || p.data_url || null }));
      }),
      db.q('SELECT * FROM supplements WHERE client_id = ? AND active = 1', [client.id])
    ]);
    res.json({ weights, adherence: adherence.reverse(), measurements, photos, supplements });
  });

  // ---- client home bundle (client portal) ----
  r.get('/me/home', async (req, res) => {
    if (req.user.role !== 'CLIENT') return res.status(403).json({ error: 'Client portal only' });
    const user = await db.q1('SELECT * FROM users WHERE id = ?', [req.user.sub]);
    const client = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!client) return res.status(404).json({ error: 'Client profile not found' });
    const d = dayKey();

    const [plan, meals, logs, water, sleep, adherence, profile] = await Promise.all([
      db.q1('SELECT * FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [client.id]),
      db.q('SELECT * FROM meals WHERE plan_id IN (SELECT id FROM nutrition_plans WHERE client_id = ?) ORDER BY position', [client.id]),
      db.q('SELECT * FROM meal_logs WHERE client_id = ? AND date = ?', [client.id, d]),
      db.q1('SELECT litres FROM water_logs WHERE client_id = ? AND date = ?', [client.id, d]),
      db.q1('SELECT * FROM sleep_logs WHERE client_id = ? AND date = ?', [client.id, d]),
      computeAdherence(db, client.id),
      db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [client.id])
    ]);

    const latestPlan = plan ? await db.q('SELECT * FROM meals WHERE plan_id = ? ORDER BY position', [plan.id]) : [];
    const logMap = new Map(logs.map(l => [l.meal_id, l]));
    const eaten = logs.filter(l => l.eaten).reduce((s, l) => ({
      calories: s.calories + l.calories, protein: s.protein + l.protein,
      carbs: s.carbs + l.carbs, fat: s.fat + l.fat
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    const tz = await getOrgTz(db, client.org_id);
    const session = await todaySession(db, client.id, tz);

    res.json({
      client: {
        id: client.id, name: user.name, goal: client.goal,
        currentWeight: client.current_weight, targetWeight: client.target_weight,
        startWeight: client.start_weight, goalDate: client.goal_date
      },
      adherence: adherence.score,
      adherenceComponents: adherence.components,
      todayWorkout: session ? { ...session.workout, exercises: session.workout.exercises, focus: session.focus, meta: session.meta } : null,
      nutrition: {
        plan: plan ? { calories: plan.calories, protein: plan.protein, carbs: plan.carbs, fat: plan.fat } : null,
        meals: [
          ...latestPlan.map(m => ({ ...m, eaten: !!logMap.get(m.id)?.eaten })),
          // client's own logged foods/meals (source: custom) — count toward today's ring + macros
          ...logs.filter(l => !l.meal_id).map(l => ({
            id: l.id, name: l.name, slot: l.slot || 'Logged', calories: l.calories,
            protein: l.protein, carbs: l.carbs, fat: l.fat, eaten: !!l.eaten, source: l.source
          }))
        ],
        eaten, customLogs: logs.filter(l => !l.meal_id)
      },
      water: { litres: water?.litres ?? 0, target: profile?.water_target_l ?? 3 },
      sleep: sleep || null,
      coachMessage: await generateCoachMessage(db, client.id)
    });
  });

  // ---- today's training session detail (client portal) ----
  r.get('/me/today', async (req, res) => {
    if (req.user.role !== 'CLIENT') return res.status(403).json({ error: 'Client portal only' });
    const client = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!client) return res.status(404).json({ error: 'Client profile not found' });
    const tz = await getOrgTz(db, client.org_id);
    const session = await todaySession(db, client.id, tz);
    res.json(session ? { ...session, clientId: client.id } : { workout: null });
  });

  // ---- this week's plan (client portal): every day + its workout preview ----
  // day_of_week convention: 1=Mon..6=Sat, 0=Sun (matches training_days + planner)
  r.get('/me/week', async (req, res) => {
    if (req.user.role !== 'CLIENT') return res.status(403).json({ error: 'Client portal only' });
    const client = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!client) return res.status(404).json({ error: 'Client profile not found' });
    const prog = await getActiveProgram(db, client.id);
    const days = prog ? await getProgramDays(db, prog.id) : [];
    // planner schedule (client-owned reusable workouts assigned to weekdays)
    // NOTE: planner stores day_of_week 0=Mon..6=Sun; training_days uses 1=Mon..6=Sat,0=Sun
    const sched = await db.q('SELECT day_of_week, workout_id FROM client_workout_schedule WHERE client_id = ?', [client.id]);
    const byDow = new Map();
    for (const s of sched) {
      const tDow = (Number(s.day_of_week) + 1) % 7; // planner 0=Mon -> training 1=Mon .. planner 6=Sun -> training 0=Sun
      byDow.set(tDow, s.workout_id);
    }
    const plannerIds = [...new Set(sched.map((s) => s.workout_id).filter(Boolean))];
    const plannerNames = plannerIds.length
      ? await db.q('SELECT id, name FROM client_workouts WHERE id IN (' + plannerIds.map(() => '?').join(',') + ')', plannerIds)
      : [];
    const nameById = new Map(plannerNames.map((p) => [p.id, p.name]));
    const plannerExs = plannerIds.length
      ? await db.q(
          `SELECT cwe.workout_id, cwe.position, cwe.name, cwe.sets, cwe.reps, cwe.weight, cwe.rest_sec,
                  el.primary_muscle, el.secondary_muscles, el.equipment, el.animation_key
             FROM client_workout_exercises cwe
             LEFT JOIN exercise_library el ON el.id = cwe.exercise_id
            WHERE cwe.workout_id IN (${plannerIds.map(() => '?').join(',')})
            ORDER BY cwe.workout_id, cwe.position`, plannerIds)
      : [];
    const byPlannerWorkout = new Map();
    for (const ex of plannerExs) {
      if (!byPlannerWorkout.has(ex.workout_id)) byPlannerWorkout.set(ex.workout_id, []);
      byPlannerWorkout.get(ex.workout_id).push(ex);
    }

    const DOW_LABEL = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const loadDayExs = async (templateId) => db.q(
      `SELECT we.position, we.name, we.sets, we.reps, we.weight, we.rest_sec,
              el.primary_muscle, el.secondary_muscles, el.equipment, el.animation_key
         FROM workout_exercises we
         LEFT JOIN exercise_library el ON el.id = we.exercise_id
        WHERE we.template_id = ? ORDER BY we.position`, [templateId]);
    const week = [];
    for (let dow = 0; dow <= 6; dow++) {
      const day = days.find((d) => d.day_of_week === dow);
      const plannerWid = byDow.get(dow);
      let exercises = null;
      let source = null;
      let name = 'Rest';
      if (day?.template_id) {
        exercises = await loadDayExs(day.template_id);
        source = 'program';
        name = day.name;
      } else if (plannerWid) {
        exercises = byPlannerWorkout.get(plannerWid) || [];
        source = 'my_workout';
        name = nameById.get(plannerWid) || 'My workout';
      }
      week.push({ day_of_week: dow, label: DOW_LABEL[dow], name, focus: day?.focus_muscles || null, source, exercises });
    }
    res.json({
      program: prog ? { name: prog.name, split: prog.split, days_per_week: prog.days_per_week } : null,
      week
    });
  });

  return r;
}
