// ============================================================
// POST /api/me/share + POST /api/me/share/:id/save — bundling a
// client's own saved foods/meals into a shareable snapshot, and another
// client saving one item from it into their own My Diet.
//
// No dedicated test file existed for this route before (confirmed via a
// full search). Covers: only the sender's own rows can ever be shared
// (never leaks another client's food even by guessed id), duplicate-name
// handling on save (never silently overwrites, never blocks -- suffixes
// instead), and that cross-client saving is the intended positive case
// (contrasted with the CRUD isolation tests elsewhere, where cross-client
// access should be blocked -- here it's the whole point).
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

test('POST /me/share: bundles the client\'s own saved food into a shareable snapshot', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const food = await call('POST', '/api/me/foods', { name: 'Shareable Snack', calories: 150, protein: 8, carbs: 12, fat: 6 });
  const res = await call('POST', '/api/me/share', { food_ids: [food.json.id] });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.ok(res.json.id);
  const row = await db.q1('SELECT * FROM shared_meals WHERE id = ?', [res.json.id]);
  const items = JSON.parse(row.items_json);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Shareable Snack');
  assert.equal(items[0].calories, 150);
});

test('POST /me/share: rejects a request with neither meal_ids nor food_ids', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/share', {});
  assert.equal(res.status, 400);
});

test('POST /me/share: never leaks another client\'s food, even by a guessed real id', async (t) => {
  const { call, token2, close } = await startApp(); t.after(() => close());
  const foodA = await call('POST', '/api/me/foods', { name: 'Client A Secret Food', calories: 100, protein: 1, carbs: 1, fat: 1 });
  // client B tries to share client A's food id as if it were their own
  const res = await call('POST', '/api/me/share', { food_ids: [foodA.json.id] }, token2);
  assert.equal(res.status, 404, 'a share containing only another client\'s (silently-skipped) id must find nothing to share');
});

test('POST /me/share/:id/save: saves a shared food into the recipient\'s own foods, tagged as a duplicate only when a name collision exists', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  const food = await call('POST', '/api/me/foods', { name: 'Grandmas Recipe', calories: 300, protein: 10, carbs: 40, fat: 8 });
  const share = await call('POST', '/api/me/share', { food_ids: [food.json.id] });
  const saved = await call('POST', `/api/me/share/${share.json.id}/save`, { item_index: 0 }, token2);
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.equal(saved.json.duplicate, false);
  assert.equal(saved.json.saved_as, 'Grandmas Recipe');
  const row = await db.q1('SELECT * FROM foods WHERE id = ?', [saved.json.id]);
  assert.equal(row.client_id, 'c2', 'saved into the RECIPIENT\'S own foods, not the sender\'s');
  assert.equal(row.calories, 300);
});

test('POST /me/share/:id/save: a name collision gets a disambiguated "(shared)" suffix, never overwrites and never blocks', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  await call('POST', '/api/me/foods', { name: 'Curry', calories: 111, protein: 1, carbs: 1, fat: 1 }, token2); // client B already has one
  const food = await call('POST', '/api/me/foods', { name: 'Curry', calories: 222, protein: 2, carbs: 2, fat: 2 }); // client A's own, different values
  const share = await call('POST', '/api/me/share', { food_ids: [food.json.id] });
  const saved = await call('POST', `/api/me/share/${share.json.id}/save`, { item_index: 0 }, token2);
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.equal(saved.json.duplicate, true);
  assert.equal(saved.json.saved_as, 'Curry (shared)');
  const original = await db.q1(`SELECT * FROM foods WHERE client_id = 'c2' AND name = 'Curry'`);
  assert.equal(original.calories, 111, 'client B\'s original "Curry" must be untouched, not overwritten');
  const newOne = await db.q1(`SELECT * FROM foods WHERE client_id = 'c2' AND name = 'Curry (shared)'`);
  assert.equal(newOne.calories, 222);
});

test('POST /me/share/:id/save: saving a shared MEAL recreates its components too', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  const meal = await call('POST', '/api/me/meals', { name: 'Shared Combo', slot: 'Meal' });
  // Insert the item row directly -- POST /meals/:id/items uses db.tx(),
  // a transaction helper this test file's minimal mock db doesn't
  // implement (out of scope here; this test is about the SHARE route,
  // not meal-item creation, which already has its own coverage).
  await db.run(
    `INSERT INTO meal_items (id, meal_template_id, name, quantity, unit, calories, protein, carbs, fat, position)
     VALUES ('mi1', ?, 'Combo Ingredient', 1, null, 90, 3, 10, 2, 0)`,
    [meal.json.id]);
  const share = await call('POST', '/api/me/share', { meal_ids: [meal.json.id] });
  const saved = await call('POST', `/api/me/share/${share.json.id}/save`, { item_index: 0 }, token2);
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.equal(saved.json.type, 'meal');
  const components = await db.q('SELECT * FROM meal_items WHERE meal_template_id = ?', [saved.json.id]);
  assert.equal(components.length, 1);
  assert.equal(components[0].name, 'Combo Ingredient');
});

test('POST /me/share/:id/save: an invalid share id returns 404', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/share/does-not-exist/save', { item_index: 0 });
  assert.equal(res.status, 404);
});

test('POST /me/share/:id/save: an out-of-range item_index returns 404', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const food = await call('POST', '/api/me/foods', { name: 'Only Item', calories: 100, protein: 1, carbs: 1, fat: 1 });
  const share = await call('POST', '/api/me/share', { food_ids: [food.json.id] });
  const res = await call('POST', `/api/me/share/${share.json.id}/save`, { item_index: 5 });
  assert.equal(res.status, 404);
});

test('POST /me/share: unauthenticated request is rejected', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/share', { food_ids: ['x'] }, null);
  assert.equal(res.status, 401);
});
