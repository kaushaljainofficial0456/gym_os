// ============================================================
// Custom foods — POST/PUT/DELETE/GET /api/me/foods*
//
// No dedicated test file existed for this CRUD before (confirmed via a
// full search — only incidentally touched inside hardening.test.js /
// foodFeedback.test.js). Covers three things the nutrition redesign
// spec explicitly calls out:
//   1. Ownership is enforced server-side, not just hidden client-side
//      (Part 38) — a two-user isolation test, not just a code read.
//   2. Duplicate-name detection is a CLIENT-scoped lookup, not global —
//      two different clients can each have their own food named "Curry".
//   3. The optional fiber/sugar/sodium fields (Part 14) are genuinely
//      optional: absent means NULL ("not tracked"), never coerced to 0,
//      and still validated (rejected) when present but invalid.
// ============================================================
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
    raw: db,
  });
  return mk();
}

// Two independent clients, two different orgs -- isolation must hold
// even when nothing else about the two accounts overlaps.
async function seedFixtures(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o2', 'Gym B', 'gym-b', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client1@test.com', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u2', 'o2', 'client2@test.com', 'x', 'Client Two', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c2', 'u2', 'o2', 'GENERAL', '2026-01-01T00:00:00Z']);
}

async function startApp() {
  const db = await memDb();
  await seedFixtures(db);
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const token1 = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client One' }, config.jwtSecret, { expiresIn: '1h' });
  const token2 = jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o2', name: 'Client Two' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, tok = token1) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, token1, token2, close };
}

test.beforeEach(() => { resetRateLimits(); });

test('POST /me/foods: creates a private, client-owned food', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods', { name: 'Homemade Curry', calories: 220, protein: 12, carbs: 18, fat: 10 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.id);
  const row = await db.q1('SELECT * FROM foods WHERE id = ?', [res.json.id]);
  assert.equal(row.client_id, 'c1');
  assert.equal(row.is_global, 0);
  assert.equal(row.name, 'Homemade Curry');
});

test('POST /me/foods: fiber/sugar/sodium are optional -- absent means NULL, never coerced to 0', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods', { name: 'Plain Rice', calories: 130, protein: 3, carbs: 28, fat: 0 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const row = await db.q1('SELECT * FROM foods WHERE id = ?', [res.json.id]);
  assert.equal(row.fiber, null);
  assert.equal(row.sugar, null);
  assert.equal(row.sodium, null);
});

test('POST /me/foods: fiber/sugar/sodium are stored correctly when provided', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods', { name: 'Oats Bowl', calories: 300, protein: 10, carbs: 50, fat: 6, fiber: 8, sugar: 4, sodium: 120 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const row = await db.q1('SELECT * FROM foods WHERE id = ?', [res.json.id]);
  assert.equal(row.fiber, 8);
  assert.equal(row.sugar, 4);
  assert.equal(row.sodium, 120);
});

test('POST /me/foods: rejects a negative fiber/sugar/sodium value', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods', { name: 'Bad Data', calories: 100, protein: 5, carbs: 10, fat: 2, sodium: -50 });
  // Caught by the zod schema's own .nonnegative() before the route body
  // even runs -- a 422 (schema validation), not the route's 400.
  assert.equal(res.status, 422, JSON.stringify(res.json));
});

test('PUT /me/foods/:id: updates fiber/sugar/sodium independently of the required macros', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const created = await call('POST', '/api/me/foods', { name: 'Yogurt', calories: 90, protein: 8, carbs: 6, fat: 3 });
  const putRes = await call('PUT', `/api/me/foods/${created.json.id}`, { sugar: 6 });
  assert.equal(putRes.status, 200, JSON.stringify(putRes.json));
  const row = await db.q1('SELECT * FROM foods WHERE id = ?', [created.json.id]);
  assert.equal(row.sugar, 6);
  assert.equal(row.fiber, null); // untouched fields stay untouched
  assert.equal(row.calories, 90); // untouched fields stay untouched
});

test('DELETE /me/foods/:id: removes the food', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const created = await call('POST', '/api/me/foods', { name: 'Temp Snack', calories: 50, protein: 1, carbs: 5, fat: 1 });
  const delRes = await call('DELETE', `/api/me/foods/${created.json.id}`);
  assert.equal(delRes.status, 200);
  const row = await db.q1('SELECT * FROM foods WHERE id = ?', [created.json.id]);
  assert.equal(row, null);
});

test('Two-user isolation: client B cannot edit client A\'s custom food', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  const created = await call('POST', '/api/me/foods', { name: 'Client A Only', calories: 77, protein: 5, carbs: 5, fat: 5 });
  await call('PUT', `/api/me/foods/${created.json.id}`, { calories: 9999 }, token2);
  // The route's own ownership WHERE clause means this either 404s or
  // silently matches zero rows -- either way, the underlying data must
  // be untouched, which is the actual security property being tested.
  const row = await db.q1('SELECT * FROM foods WHERE id = ?', [created.json.id]);
  assert.equal(row.calories, 77, 'client B must not be able to overwrite client A\'s food');
});

test('Two-user isolation: client B cannot delete client A\'s custom food', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  const created = await call('POST', '/api/me/foods', { name: 'Client A Only 2', calories: 88, protein: 5, carbs: 5, fat: 5 });
  await call('DELETE', `/api/me/foods/${created.json.id}`, undefined, token2);
  const row = await db.q1('SELECT * FROM foods WHERE id = ?', [created.json.id]);
  assert.ok(row, 'client B\'s delete attempt must not remove client A\'s food');
  assert.equal(row.name, 'Client A Only 2');
});

test('Two-user isolation: client B\'s GET /me/foods "mine" list never includes client A\'s private food', async (t) => {
  const { call, token2, close } = await startApp(); t.after(() => close());
  await call('POST', '/api/me/foods', { name: 'Only Client A Sees This', calories: 60, protein: 2, carbs: 3, fat: 4 });
  const asClient2 = await call('GET', '/api/me/foods', undefined, token2);
  assert.equal(asClient2.status, 200);
  const names = (asClient2.json.mine || []).map((f) => f.name);
  assert.ok(!names.includes('Only Client A Sees This'), 'client B must never see client A\'s private food in "mine"');
});

test('Two different clients can each independently have a custom food with the same name', async (t) => {
  const { call, token2, close } = await startApp(); t.after(() => close());
  const a = await call('POST', '/api/me/foods', { name: 'Curry', calories: 200, protein: 10, carbs: 20, fat: 8 });
  const b = await call('POST', '/api/me/foods', { name: 'Curry', calories: 250, protein: 15, carbs: 15, fat: 12 }, token2);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.json.id, b.json.id, 'same name, but two genuinely separate rows -- one per client');
});

test('POST /me/foods: unauthenticated request is rejected', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods', { name: 'x', calories: 1, protein: 1, carbs: 1, fat: 1 }, null);
  assert.equal(res.status, 401);
});

// ---------------- GET /me/foods/recent (Part 40-41) ----------------
// Reconstructed from meal_logs history, not a new table -- these tests
// seed meal_logs rows directly (mirroring exactly what
// POST /nutrition/clients/:id/meals/log itself inserts) rather than
// re-testing that unrelated route.
async function seedLog(db, { id: logId, name, source = 'manual', date, calories = 100, protein = 5, carbs = 10, fat = 3, mealTemplateId = null }) {
  await db.run(
    `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, meal_template_id)
     VALUES (?, 'c1', NULL, ?, 'snack', ?, ?, ?, ?, ?, 1, ?, ?)`,
    [logId, date, name, calories, protein, carbs, fat, source, mealTemplateId]);
}

test('GET /me/foods/recent: returns distinct foods ordered by most-recently-logged day', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1', name: 'Old Food', date: '2026-08-01' });
  await seedLog(db, { id: 'l2', name: 'New Food', date: '2026-08-20' });
  const res = await call('GET', '/api/me/foods/recent');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const names = res.json.recent.map((r) => r.name);
  assert.equal(names[0], 'New Food');
  assert.equal(names[1], 'Old Food');
});

test('GET /me/foods/recent: collapses repeated logs of the same food into one entry with a times_logged count', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1', name: 'Rice', date: '2026-08-01' });
  await seedLog(db, { id: 'l2', name: 'Rice', date: '2026-08-10' });
  await seedLog(db, { id: 'l3', name: 'rice', date: '2026-08-15' }); // case-insensitive match
  const res = await call('GET', '/api/me/foods/recent');
  assert.equal(res.status, 200);
  const rice = res.json.recent.find((r) => r.name.toLowerCase() === 'rice');
  assert.ok(rice, 'exactly one collapsed entry for "Rice"/"rice"');
  assert.equal(rice.times_logged, 3);
  assert.equal(res.json.recent.length, 1, 'no duplicate rows for the same food name');
});

test('GET /me/foods/recent: excludes plan-sourced meal-template logs (Today\'s Eaten Meals already covers those)', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1', name: 'Assigned Plan Meal', date: '2026-08-20', source: 'plan' });
  await seedLog(db, { id: 'l2', name: 'Searched Food', date: '2026-08-19', source: 'manual' });
  const res = await call('GET', '/api/me/foods/recent');
  const names = res.json.recent.map((r) => r.name);
  assert.ok(!names.includes('Assigned Plan Meal'), 'plan-sourced logs must not appear in Recent');
  assert.ok(names.includes('Searched Food'));
});

test('GET /me/foods/recent: excludes a SAVED MEAL logged via "Log Today" (source=custom, has a meal_template_id) -- Part 42, a saved meal must never masquerade as an individual food', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1', name: 'Morning oats + milk', date: '2026-08-20', source: 'custom', mealTemplateId: 'cmt_fake123' });
  await seedLog(db, { id: 'l2', name: 'Real Individual Food', date: '2026-08-19', source: 'manual' });
  const res = await call('GET', '/api/me/foods/recent');
  const names = res.json.recent.map((r) => r.name);
  assert.ok(!names.includes('Morning oats + milk'), 'a saved MEAL log must not appear in Recent FOODS');
  assert.ok(names.includes('Real Individual Food'));
});

test('GET /me/foods/recent: two-user isolation -- client B never sees client A\'s log history', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  await db.run(
    `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source)
     VALUES ('l1', 'c1', NULL, '2026-08-20', 'snack', 'Client A Food', 100, 5, 10, 3, 1, 'manual')`);
  const res = await call('GET', '/api/me/foods/recent', undefined, token2);
  assert.equal(res.status, 200);
  assert.equal(res.json.recent.length, 0, 'client B has no log history yet, and must not see client A\'s');
});

test('GET /me/foods/recent: respects an explicit limit', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  for (let i = 0; i < 5; i++) {
    await seedLog(db, { id: `l${i}`, name: `Food ${i}`, date: `2026-08-0${i + 1}` });
  }
  const res = await call('GET', '/api/me/foods/recent?limit=2');
  assert.equal(res.status, 200);
  assert.equal(res.json.recent.length, 2);
});
