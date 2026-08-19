import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, orgScope, resolveClient } from '../auth.js';
import { validate, schemas } from '../validate.js';
import { id, now } from '../ids.js';
import { dayKey } from '../utils/time.js';
import { estimateFood } from '../services/foodEstimator.js';
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
      `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('mlg'), client.id, b.meal_id || null, b.date || dayKey(), b.slot || 'snack', b.name,
       b.calories, b.protein, b.carbs, b.fat, b.eaten ? 1 : 0, b.source, b.estimate ? 1 : 0]);
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'meal_logged', data: { clientId: client.id, source: b.source } });
    res.status(201).json({ ok: true });
  });

  // ---- AI food estimate (clearly labeled estimate) ----
  // Rate-limited per authenticated user: 30 requests / minute, matching
  // the intelligence AI-endpoint convention for computation-heavy routes.
  const estimateLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/clients/:id/meals/ai-estimate', estimateLimit, validate(schemas.aiEstimate), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    res.json(estimateFood(req.body.text));
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

  return r;
}
