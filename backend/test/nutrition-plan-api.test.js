import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { resetRateLimits } from '../src/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    raw: db
  });
  return mk();
}

async function seedFixtures(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o2', 'Gym B', 'gym-b', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    ['t1', 'o1', 'trainer@test.com', 'x', 'Trainer One', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client1@test.com', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, trainer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'GENERAL', 't1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u2', 'o2', 'client2@test.com', 'x', 'Client Two', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c2', 'u2', 'o2', 'GENERAL', '2026-01-01T00:00:00Z']);
}

async function startPlanApi() {
  const db = await memDb();
  await seedFixtures(db);
  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/nutrition', nutritionRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const trainerToken = jwt.sign({ sub: 't1', role: 'TRAINER', org: 'o1', name: 'Trainer One' }, config.jwtSecret, { expiresIn: '1h' });
  const clientToken = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client One' }, config.jwtSecret, { expiresIn: '1h' });
  const trainerToken2 = jwt.sign({ sub: 't1', role: 'TRAINER', org: 'o2', name: 'Trainer One' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, token = trainerToken) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close, base, trainerToken, clientToken, trainerToken2 };
}

const PLAN = { name: 'Muscle Gain', calories: 2500, protein: 150, carbs: 300, fat: 70, meals: [
  { slot: 'breakfast', name: 'Oats + Eggs', calories: 500, protein: 30, carbs: 50, fat: 15 },
  { slot: 'lunch', name: 'Chicken Rice', calories: 700, protein: 45, carbs: 80, fat: 18 }
]};

// === CREATE ===
test('unauthenticated create -> 401', async (t) => {
  const { call, close } = await startPlanApi(); t.after(() => close());
  assert.equal((await call('POST', '/api/nutrition/plans', PLAN, '')).status, 401);
});

test('client role cannot create -> 403', async (t) => {
  const { call, close, clientToken } = await startPlanApi(); t.after(() => close());
  assert.equal((await call('POST', '/api/nutrition/plans', PLAN, clientToken)).status, 403);
});

test('missing name -> 422', async (t) => {
  const { call, close } = await startPlanApi(); t.after(() => close());
  const r = await call('POST', '/api/nutrition/plans', { calories: 2000, protein: 100, carbs: 200, fat: 50 });
  assert.equal(r.status, 422);
});

test('negative calories -> 422', async (t) => {
  const { call, close } = await startPlanApi(); t.after(() => close());
  assert.equal((await call('POST', '/api/nutrition/plans', { ...PLAN, calories: -100 })).status, 422);
});

test('exceeds max calories -> 422', async (t) => {
  const { call, close } = await startPlanApi(); t.after(() => close());
  assert.equal((await call('POST', '/api/nutrition/plans', { ...PLAN, calories: 99999 })).status, 422);
});

test('valid creation -> 201 + DB persistence', async (t) => {
  const { db, call, close } = await startPlanApi(); t.after(() => close());
  const r = await call('POST', '/api/nutrition/plans', PLAN);
  assert.equal(r.status, 201);
  assert.ok(r.json.id.startsWith('nut_'));
  const plan = await db.q1('SELECT * FROM nutrition_plans WHERE id = ?', [r.json.id]);
  assert.ok(plan);
  assert.equal(plan.org_id, 'o1');
  assert.equal(plan.trainer_id, 't1');
  assert.equal(plan.client_id, null);
  assert.equal(plan.is_template, 1);
  assert.equal(plan.name, 'Muscle Gain');
  assert.equal(plan.calories, 2500);
  assert.ok(plan.created_at);
  const meals = await db.q('SELECT * FROM meals WHERE plan_id = ? ORDER BY position', [r.json.id]);
  assert.equal(meals.length, 2);
  assert.equal(meals[0].slot, 'breakfast');
  assert.equal(meals[1].slot, 'lunch');
});

test('SQL injection in name is safe', async (t) => {
  const { db, call, close } = await startPlanApi(); t.after(() => close());
  const r = await call('POST', '/api/nutrition/plans', { ...PLAN, name: "'; DROP TABLE nutrition_plans; --" });
  assert.equal(r.status, 201);
  const plan = await db.q1('SELECT * FROM nutrition_plans WHERE id = ?', [r.json.id]);
  assert.equal(plan.name, "'; DROP TABLE nutrition_plans; --");
});

test('empty meals array -> 201', async (t) => {
  const { db, call, close } = await startPlanApi(); t.after(() => close());
  const r = await call('POST', '/api/nutrition/plans', { ...PLAN, meals: [] });
  assert.equal(r.status, 201);
  assert.equal((await db.q('SELECT * FROM meals WHERE plan_id = ?', [r.json.id])).length, 0);
});

// === LIST / GET ===
test('list plans returns templates', async (t) => {
  const { call, close } = await startPlanApi(); t.after(() => close());
  await call('POST', '/api/nutrition/plans', PLAN);
  const r = await call('GET', '/api/nutrition/plans');
  assert.equal(r.status, 200);
  assert.ok(r.json.plans.length >= 1);
  assert.ok(r.json.plans[0].meals, 'plans have meals');
});

test('get single plan -> 200', async (t) => {
  const { call, close } = await startPlanApi(); t.after(() => close());
  const created = await call('POST', '/api/nutrition/plans', PLAN);
  const r = await call('GET', `/api/nutrition/plans/${created.json.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.plan.name, 'Muscle Gain');
  assert.equal(r.json.plan.meals.length, 2);
});

test('get nonexistent plan -> 404', async (t) => {
  const { call, close } = await startPlanApi(); t.after(() => close());
  assert.equal((await call('GET', '/api/nutrition/plans/nonexistent')).status, 404);
});

test('client cannot list plans -> 403', async (t) => {
  const { call, close, clientToken } = await startPlanApi(); t.after(() => close());
  assert.equal((await call('GET', '/api/nutrition/plans', null, clientToken)).status, 403);
});

// === ASSIGN ===
test('assign plan to client -> 201 + DB persistence', async (t) => {
  const { db, call, close } = await startPlanApi(); t.after(() => close());
  const created = await call('POST', '/api/nutrition/plans', PLAN);
  const r = await call('POST', '/api/nutrition/clients/c1/plan/assign', { plan_id: created.json.id });
  // The assign endpoint uses resolveClient which requires the trainer to be
  // the client's assigned trainer. Our test trainer 't1' is assigned as c1's trainer.
  assert.equal(r.status, 201);
  assert.ok(r.json.planId);
  const assigned = await db.q1('SELECT * FROM nutrition_plans WHERE id = ?', [r.json.planId]);
  assert.ok(assigned);
  assert.equal(assigned.client_id, 'c1');
  assert.equal(assigned.is_template, 0);
  assert.equal(assigned.calories, 2500);
  const meals = await db.q('SELECT * FROM meals WHERE plan_id = ? ORDER BY position', [r.json.planId]);
  assert.equal(meals.length, 2, 'meals copied');
});

test('assign to nonexistent client -> 404', async (t) => {
  const { call, close } = await startPlanApi(); t.after(() => close());
  const created = await call('POST', '/api/nutrition/plans', PLAN);
  assert.equal((await call('POST', '/api/nutrition/clients/nonexistent/plan/assign', { plan_id: created.json.id })).status, 404);
});

test('assign nonexistent plan -> 404', async (t) => {
  const { db, call, close } = await startPlanApi(); t.after(() => close());
  // resolveClient passes first (c1 exists, trainer is assigned), then plan lookup fails
  const r = await call('POST', '/api/nutrition/clients/c1/plan/assign', { plan_id: 'nonexistent' });
  assert.equal(r.status, 404);
});

test('cross-org assign -> 403', async (t) => {
  const { call, close, trainerToken2 } = await startPlanApi(); t.after(() => close());
  assert.equal((await call('POST', '/api/nutrition/clients/c1/plan/assign', { plan_id: 'x' }, trainerToken2)).status, 403);
});

test('assign missing plan_id -> 422', async (t) => {
  const { call, close } = await startPlanApi(); t.after(() => close());
  assert.equal((await call('POST', '/api/nutrition/clients/c1/plan/assign', {})).status, 422);
});

// === RATE LIMITING ===
test('plan creation rate limit -> 429', async (t) => {
  resetRateLimits();
  const { call, close } = await startPlanApi(); t.after(() => { resetRateLimits(); close(); });
  let hitLimit = false;
  for (let i = 0; i < 25; i++) {
    const r = await call('POST', '/api/nutrition/plans', { ...PLAN, name: `Plan ${i}` });
    if (r.status === 429) { hitLimit = true; break; }
    assert.equal(r.status, 201);
  }
  assert.ok(hitLimit, 'rate limit triggered');
});
