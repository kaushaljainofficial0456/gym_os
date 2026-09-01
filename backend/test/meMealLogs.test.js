// ============================================================
// PUT/DELETE /api/me/meal-logs/:logId — editing/removing a single
// logged food entry for today (distinct from editing a saved food's own
// defaults, and distinct from deleting a saved meal template -- this
// only ever touches the one already-logged row).
//
// No dedicated test file existed for this route before (confirmed via a
// full search). Covers the proportional-quantity-scaling behavior
// (Part 24-adjacent: editing quantity must recompute nutrition, not just
// overwrite it) and ownership isolation (Part 38's own two-user pattern,
// applied here too).
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

async function seedLog(db, { id: logId, clientId = 'c1', name = 'Test Food', calories = 200, protein = 10, carbs = 20, fat = 5, quantity = 100, unit = 'g' }) {
  await db.run(
    `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, quantity, unit)
     VALUES (?, ?, NULL, '2026-08-20', 'snack', ?, ?, ?, ?, ?, 1, 'manual', ?, ?)`,
    [logId, clientId, name, calories, protein, carbs, fat, quantity, unit]);
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

test('PUT /me/meal-logs/:id: scales calories/protein/carbs/fat proportionally to the new quantity', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1', calories: 200, protein: 10, carbs: 20, fat: 5, quantity: 100 });
  const res = await call('PUT', '/api/me/meal-logs/l1', { quantity: 150 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const row = await db.q1('SELECT * FROM meal_logs WHERE id = ?', ['l1']);
  assert.equal(row.quantity, 150);
  assert.equal(row.calories, 300); // 200 * 1.5
  assert.equal(row.protein, 15);
  assert.equal(row.carbs, 30);
  assert.equal(row.fat, 7.5);
});

// Real bug found during a live end-to-end verification pass: the edit
// modal always resends `{quantity, unit: log.unit}` verbatim, and most
// individually-logged foods (quick-log, portion picker, Custom Macros,
// AI estimate, Recent quick-add) have `unit: null` -- a plain
// `z.string().optional()` accepts undefined but REJECTS null, so this
// 422'd every time for the common case. Fixed via `.nullable()` on the
// schema + explicit null-handling in the route (String(null) would
// otherwise silently store the literal string "null").
test('PUT /me/meal-logs/:id: accepts and preserves a NULL unit (the common case for any individually-logged food)', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1', calories: 200, protein: 10, carbs: 20, fat: 5, quantity: 100, unit: null });
  const res = await call('PUT', '/api/me/meal-logs/l1', { quantity: 200, unit: null });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const row = await db.q1('SELECT * FROM meal_logs WHERE id = ?', ['l1']);
  assert.equal(row.unit, null, 'unit must stay a real NULL, never the literal string "null"');
  assert.equal(row.calories, 400);
});

test('PUT /me/meal-logs/:id: editing one entry never touches a different day\'s already-logged entry (historical-log immutability)', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1', calories: 200, quantity: 100 });
  await seedLog(db, { id: 'l2', calories: 999, quantity: 100 }); // a second, unrelated entry
  await call('PUT', '/api/me/meal-logs/l1', { quantity: 200 });
  const untouched = await db.q1('SELECT * FROM meal_logs WHERE id = ?', ['l2']);
  assert.equal(untouched.calories, 999, 'editing l1 must not affect l2');
});

test('PUT /me/meal-logs/:id: missing quantity is rejected (422 from schema, required field)', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('PUT', '/api/me/meal-logs/l1', {});
  assert.equal(res.status, 422);
});

test('PUT /me/meal-logs/:id: nonexistent log id returns 404', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('PUT', '/api/me/meal-logs/does-not-exist', { quantity: 100 });
  assert.equal(res.status, 404);
});

test('DELETE /me/meal-logs/:id: removes only that entry, leaves other logs untouched', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1', name: 'Delete Me' });
  await seedLog(db, { id: 'l2', name: 'Keep Me' });
  const res = await call('DELETE', '/api/me/meal-logs/l1');
  assert.equal(res.status, 200);
  const gone = await db.q1('SELECT * FROM meal_logs WHERE id = ?', ['l1']);
  assert.equal(gone, null);
  const kept = await db.q1('SELECT * FROM meal_logs WHERE id = ?', ['l2']);
  assert.ok(kept, 'the unrelated log entry must survive');
});

test('DELETE /me/meal-logs/:id: nonexistent log id returns 404', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('DELETE', '/api/me/meal-logs/does-not-exist');
  assert.equal(res.status, 404);
});

test('Two-user isolation: client B cannot edit client A\'s logged entry', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1', calories: 200, quantity: 100 });
  const res = await call('PUT', '/api/me/meal-logs/l1', { quantity: 500 }, token2);
  assert.equal(res.status, 404, 'client B must not even be able to locate client A\'s log entry');
  const row = await db.q1('SELECT * FROM meal_logs WHERE id = ?', ['l1']);
  assert.equal(row.quantity, 100, 'client A\'s entry must be unmodified');
});

test('Two-user isolation: client B cannot delete client A\'s logged entry', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  await seedLog(db, { id: 'l1' });
  const res = await call('DELETE', '/api/me/meal-logs/l1', undefined, token2);
  assert.equal(res.status, 404);
  const row = await db.q1('SELECT * FROM meal_logs WHERE id = ?', ['l1']);
  assert.ok(row, 'client A\'s entry must still exist');
});

test('PUT /me/meal-logs/:id: unauthenticated request is rejected', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('PUT', '/api/me/meal-logs/l1', { quantity: 100 }, null);
  assert.equal(res.status, 401);
});
