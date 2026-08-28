import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, orgScope, resolveClient } from '../auth.js';
import { validate, schemas } from '../validate.js';
import { id, now } from '../ids.js';
import { dayKey, addDays, daysBetween } from '../utils/time.js';
import { estimateFood, estimateMeal } from '../services/food/index.js';
import { track } from '../services/events.js';
import { rateLimit } from '../rateLimit.js';

export default function nutritionRoutes(db) {
  const r = Router();
  // Clients log their own meals; plan management is trainer/owner-only (per-route).
  r.use(requireAuth, orgScope);
  const trainerOnly = requireRole('GYM_OWNER', 'TRAINER', 'SUPER_ADMIN');

  async function attachMeals(plan) {
    plan.meals = await db.q('SELECT * FROM meals WHERE plan_id = ? ORDER BY position', [plan.id]);
    return plan;
  }

  // ---- plans (templates + client plans, trainer/owner only) ----
  r.get('/plans', trainerOnly, async (req, res) => {
    const rows = await db.q(
      `SELECT * FROM nutrition_plans WHERE org_id = ? AND (is_template = 1 OR client_id IS NULL)
       ORDER BY created_at DESC`, [req.orgId]);
    const plans = [];
    for (const p of rows) plans.push(await attachMeals(p));
    res.json({ plans });
  });

  r.get('/plans/:id', trainerOnly, async (req, res) => {
    const p = await db.q1('SELECT * FROM nutrition_plans WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!p) return res.status(404).json({ error: 'Plan not found' });
    res.json({ plan: await attachMeals(p) });
  });

  // ---- update a nutrition plan template (trainer/owner only) ----
  // Only templates (is_template=1) can be updated. Client-specific plans
  // assigned to individual clients should be managed via re-assignment.
  // Preserves existing client assignments — updating a template does NOT
  // rewrite historical meal logs or alter already-assigned plans.
  const planUpdateLimit = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => req.user?.sub || 'anon' });
  r.put('/plans/:id', trainerOnly, planUpdateLimit, validate(schemas.nutritionPlan), async (req, res) => {
    const p = await db.q1('SELECT * FROM nutrition_plans WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!p) return res.status(404).json({ error: 'Plan not found' });
    if (!p.is_template) {
      return res.status(400).json({ error: 'Only templates can be updated — use plan assignment for client-specific plans' });
    }
    // Update plan-level nutrition values
    await db.run(
      `UPDATE nutrition_plans SET name = ?, calories = ?, protein = ?, carbs = ?, fat = ? WHERE id = ?`,
      [req.body.name, req.body.calories, req.body.protein, req.body.carbs, req.body.fat, p.id]);
    // Replace meals: delete existing, insert new (atomic via sequential writes)
    await db.run('DELETE FROM meals WHERE plan_id = ?', [p.id]);
    for (let i = 0; i < req.body.meals.length; i++) {
      const m = req.body.meals[i];
      await db.run(
        `INSERT INTO meals (id, plan_id, slot, name, time, calories, protein, carbs, fat, foods, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('mea'), p.id, m.slot, m.name, m.time || null, m.calories, m.protein, m.carbs, m.fat, m.foods || null, i]);
    }
    await track(db, { orgId: req.orgId, userId: req.user.sub, type: 'nutrition_plan_updated', data: { planId: p.id } });
    res.json({ ok: true, id: p.id });
  });

  // Rate-limited: plan creation is infrequent (trainer action, not per-meal).
  const planCreateLimit = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/plans', trainerOnly, planCreateLimit, validate(schemas.nutritionPlan), async (req, res) => {
    const pId = id('nut');
    await db.run(
      `INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?)`,
      [pId, req.orgId, req.user.sub, req.body.name, req.body.calories, req.body.protein,
       req.body.carbs, req.body.fat, now()]);
    for (let i = 0; i < req.body.meals.length; i++) {
      const m = req.body.meals[i];
      await db.run(
        `INSERT INTO meals (id, plan_id, slot, name, time, calories, protein, carbs, fat, foods, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('mea'), pId, m.slot, m.name, m.time || null, m.calories, m.protein, m.carbs, m.fat, m.foods || null, i]);
    }
    await track(db, { orgId: req.orgId, userId: req.user.sub, type: 'nutrition_plan_created', data: { planId: pId } });
    res.status(201).json({ id: pId });
  });

  // ---- assign a plan to a client ----
  // Rate-limited: plan assignment is infrequent (trainer action).
  const planAssignLimit = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/clients/:id/plan/assign', trainerOnly, planAssignLimit, validate(z.object({ plan_id: z.string().min(1) })), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const plan = await db.q1('SELECT * FROM nutrition_plans WHERE id = ? AND org_id = ?', [req.body.plan_id, req.orgId]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const pId = id('nut');
    await db.run(
      `INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [pId, req.orgId, req.user.sub, client.id, plan.name, plan.calories, plan.protein, plan.carbs, plan.fat, now()]);
    const meals = await db.q('SELECT * FROM meals WHERE plan_id = ? ORDER BY position', [plan.id]);
    for (const m of meals) {
      await db.run(
        `INSERT INTO meals (id, plan_id, slot, name, time, calories, protein, carbs, fat, foods, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('mea'), pId, m.slot, m.name, m.time, m.calories, m.protein, m.carbs, m.fat, m.foods, m.position]);
    }
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'plan_assigned', data: { clientId: client.id } });
    res.status(201).json({ planId: pId });
  });

  // ---- today's meals (plan + eaten flags) ----
  r.get('/clients/:id/meals', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const d = req.query.date || dayKey();
    const plan = await db.q1(
      'SELECT * FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [client.id]);
    const meals = plan ? await db.q('SELECT * FROM meals WHERE plan_id = ? ORDER BY position', [plan.id]) : [];
    const logs = await db.q(
      `SELECT * FROM meal_logs WHERE client_id = ? AND date = ?`, [client.id, d]);
    const logMap = new Map(logs.map(l => [l.meal_id, l]));
    res.json({
      date: d,
      plan: plan ? { id: plan.id, calories: plan.calories, protein: plan.protein, carbs: plan.carbs, fat: plan.fat } : null,
      meals: meals.map(m => ({
        ...m, eaten: !!logMap.get(m.id)?.eaten, logId: logMap.get(m.id)?.id || null
      })),
      customLogs: logs.filter(l => !l.meal_id)
    });
  });

  // ---- toggle a meal eaten ----
  r.post('/clients/:id/meals/toggle', validate(z.object({ meal_id: z.string().min(1), eaten: z.boolean().optional() })), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const mealId = req.body.meal_id;
    const eaten = req.body.eaten ?? true;

    // Custom / AI-logged meals have IDs prefixed with 'mlg_' and live directly in meal_logs.
    if (mealId.startsWith('mlg_')) {
      const log = await db.q1('SELECT id, client_id FROM meal_logs WHERE id = ?', [mealId]);
      if (!log || log.client_id !== client.id) return res.status(404).json({ error: 'Meal log not found' });
      await db.run('UPDATE meal_logs SET eaten = ? WHERE id = ?', [eaten ? 1 : 0, mealId]);
      await track(db, { orgId: client.org_id, userId: req.user.sub, type: eaten ? 'meal_logged' : 'meal_unlogged', data: { clientId: client.id, mealId } });
      return res.json({ ok: true });
    }

    // Plan meals live in the `meals` table — create or update a meal_log for today.
    const meal = await db.q1('SELECT * FROM meals WHERE id = ?', [mealId]);
    if (!meal) return res.status(404).json({ error: 'Meal not found' });
    const d = dayKey();
    const existing = await db.q1(
      'SELECT id FROM meal_logs WHERE client_id = ? AND meal_id = ? AND date = ?', [client.id, meal.id, d]);
    if (existing) {
      await db.run('UPDATE meal_logs SET eaten = ? WHERE id = ?', [eaten ? 1 : 0, existing.id]);
    } else {
      await db.run(
        `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, estimate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'plan', 0)`,
        [id('mlg'), client.id, meal.id, d, meal.slot, meal.name, meal.calories, meal.protein, meal.carbs, meal.fat, eaten ? 1 : 0]);
    }
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: eaten ? 'meal_logged' : 'meal_unlogged', data: { clientId: client.id, mealId: meal.id } });
    res.json({ ok: true });
  });

  // ---- log a custom (or AI-estimated) meal ----
  // Rate-limited per authenticated user: 60 requests / minute.
  // Meal logging is a frequent client action (multiple meals per day),
  // so the limit is more generous than the AI estimate endpoint (30/min).
  const mealLogLimit = rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/clients/:id/meals/log', mealLogLimit, validate(schemas.mealLog), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const b = req.body;
    await db.run(
      `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, estimate, ai_provider, ai_model, ai_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('mlg'), client.id, b.meal_id || null, b.date || dayKey(), b.slot || 'snack', b.name,
       b.calories, b.protein, b.carbs, b.fat, b.eaten ? 1 : 0, b.source, b.estimate ? 1 : 0,
       b.ai_provider || null, b.ai_model || null, b.ai_confidence || null]);
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'meal_logged', data: { clientId: client.id, source: b.source } });
    if (b.source === 'ai_estimated' || b.source === 'ai_estimated_user_adjusted') {
      // Distinct from the generic 'meal_logged' event above so Tier-4
      // confirmation/adjustment rates (spec: user_confirmed_ai_estimates,
      // user_adjusted_ai_estimates) can be measured without re-parsing data.
      await track(db, { orgId: client.org_id, userId: req.user.sub, type: `food_ai_${b.source === 'ai_estimated_user_adjusted' ? 'user_adjusted' : 'user_confirmed'}`, data: { clientId: client.id, name: b.name } });
    }
    res.status(201).json({ ok: true });
  });

  // ---- AI food estimate (clearly labeled estimate) ----
  // Rate-limited per authenticated user: 30 requests / minute, matching
  // the intelligence AI-endpoint convention for computation-heavy routes.
  const estimateLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/clients/:id/meals/ai-estimate', estimateLimit, validate(schemas.aiEstimate), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    // Default: V1 (frozen baseline), byte-identical to `estimateFood`. Opt in
    // to the Phase-2 engine per-request with `?engine=v2` (plausibility
    // downgrade + quarantine rescue over the V1 result) — for QA / shadow
    // checks ahead of a later gated cutover. Anything other than exactly
    // "v2" is V1.
    const engine = req.query.engine === 'v2' ? 'v2' : undefined;
    res.json(engine ? estimateMeal(req.body.text, { engine }) : estimateFood(req.body.text));
  });

  // ---- daily nutrition summary ----
  r.get('/clients/:id/nutrition-summary', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const d = req.query.date || dayKey();
    const plan = await db.q1('SELECT * FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [client.id]);
    const logs = await db.q(
      'SELECT * FROM meal_logs WHERE client_id = ? AND date = ? AND eaten = 1', [client.id, d]);
    const eaten = logs.reduce((s, l) => ({
      calories: s.calories + l.calories, protein: s.protein + l.protein,
      carbs: s.carbs + l.carbs, fat: s.fat + l.fat
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
    res.json({
      date: d,
      plan: plan ? { calories: plan.calories, protein: plan.protein, carbs: plan.carbs, fat: plan.fat } : null,
      eaten, remaining: plan ? {
        calories: plan.calories - eaten.calories, protein: plan.protein - eaten.protein,
        carbs: plan.carbs - eaten.carbs, fat: plan.fat - eaten.fat
      } : null
    });
  });

  // ---- nutrition history: calendar + long-term trends ----
  // One parameterized query for the whole [from, to] range, grouped by date
  // in JS -- no N+1 regardless of range length. The response carries both
  // per-day aggregates (calendar dots, history charts) AND each day's
  // individual logs, so selecting any date already covered by a fetched
  // range (the calendar's current month, or the history section's current
  // window) needs no extra request -- it's a lookup into data already in
  // hand, not a new round trip.
  r.get('/clients/:id/history', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const tz = req.tz || 'Asia/Kolkata';
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const to = DATE_RE.test(req.query.to) ? req.query.to : dayKey(new Date(), tz);
    const from = DATE_RE.test(req.query.from) ? req.query.from : dayKey(addDays(new Date(), -29), tz);
    if (from > to) return res.status(400).json({ error: '"from" must not be after "to"' });
    // Generous cap (a little over a year) -- covers every range the UI
    // offers (7d/30d/3mo/6mo/custom) with headroom, while bounding the
    // query and response size against an arbitrarily large request.
    if (daysBetween(from, to) > 400) {
      return res.status(400).json({ error: 'Date range too large (max 400 days)' });
    }
    const plan = await db.q1(
      'SELECT * FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [client.id]);
    const rows = await db.q(
      `SELECT id, date, slot, name, calories, protein, carbs, fat, eaten, source, quantity, unit, unit_type
         FROM meal_logs WHERE client_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
      [client.id, from, to]);
    const byDate = new Map();
    for (const row of rows) {
      let day = byDate.get(row.date);
      if (!day) {
        day = { date: row.date, calories: 0, protein: 0, carbs: 0, fat: 0, logged: true, logs: [] };
        byDate.set(row.date, day);
      }
      // Totals count only eaten=1 rows -- matches nutrition-summary above
      // and the Home page's "Fuel today" ring, so the same day never shows
      // two disagreeing calorie figures depending on which screen it's
      // viewed from. Un-eaten rows still appear in `logs` (a genuine
      // historical log either way), just excluded from the day's totals.
      if (row.eaten) {
        day.calories += row.calories; day.protein += row.protein;
        day.carbs += row.carbs; day.fat += row.fat;
      }
      day.logs.push({
        id: row.id, name: row.name, calories: row.calories, protein: row.protein,
        carbs: row.carbs, fat: row.fat, slot: row.slot || null,
        quantity: row.quantity ?? null, unit: row.unit || null,
        eaten: !!row.eaten, source: row.source
      });
    }
    res.json({
      from, to,
      target: plan ? { calories: plan.calories, protein: plan.protein, carbs: plan.carbs, fat: plan.fat } : null,
      // Only dates with at least one log are included -- the frontend
      // already knows every date in [from, to] from the calendar/range it
      // requested, so an absent date unambiguously means "nothing logged"
      // rather than the server needing to materialize empty rows for
      // every unlogged day in a 6-month range.
      days: [...byDate.values()]
    });
  });

  return r;
}
