// ============================================================
// Integration tests for the nutrition history API endpoint:
//   GET /api/nutrition/clients/:id/history?from=&to=
//
// Covers:
//   * unauthenticated request -> 401
//   * unknown client -> 404
//   * today's history (default range, no query params)
//   * an old date, correctly aggregated
//   * a date with multiple unslotted food logs (slot must stay optional)
//   * an empty date range -> clean empty result, not an error
//   * macro aggregation only counts eaten=1 rows (matches nutrition-summary)
//   * cross-organization client access -> 403
//   * trainer of the client -> 200 (authorized)
//   * trainer NOT assigned to the client, same org -> 403 unless owner
//   * invalid range (from after to) -> 400
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

// ---- in-memory SQLite helper (same pattern as nutrition-meal-log-api.test.js) ----
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

// Local YYYY-MM-DD, matching how the server computes "today" (dayKey) --
// deliberately NOT going through Date.toISOString(), which is UTC and would
// be off by a day around midnight in timezones behind UTC (exactly the
// off-by-one class of bug this feature has to avoid).
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let mealLogSeq = 0;
async function insertLog(db, { client_id, date, slot = null, name, calories, protein, carbs, fat, eaten = 1 }) {
  await db.run(
    `INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source, estimate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 0)`,
    [`mlg_${++mealLogSeq}`, client_id, date, slot, name, calories, protein, carbs, fat, eaten]);
}

// ---- seed two orgs, a trainer, and clients for cross-tenant + role testing ----
async function seedFixtures(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client1@test.com', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    ['t1', 'o1', 'trainer1@test.com', 'x', 'Trainer One', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    ['t2', 'o1', 'trainer2@test.com', 'x', 'Trainer Two', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 't1', 'GENERAL', '2026-01-01T00:00:00Z']);

  // Org 2 (cross-tenant test)
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o2', 'Gym B', 'gym-b', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u2', 'o2', 'client2@test.com', 'x', 'Client Two', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c2', 'u2', 'o2', 'GENERAL', '2026-01-01T00:00:00Z']);

  // -- log data for c1 --
  // Today: one eaten log (drives the "today's history" test).
  await insertLog(db, { client_id: 'c1', date: todayKey(), slot: 'lunch', name: 'Chicken Rice', calories: 600, protein: 50, carbs: 60, fat: 15 });
  // An old date, single eaten log.
  await insertLog(db, { client_id: 'c1', date: '2026-01-10', slot: 'breakfast', name: 'Oats', calories: 300, protein: 12, carbs: 45, fat: 6 });
  // A date with multiple UNSLOTTED logs (slot must stay optional).
  await insertLog(db, { client_id: 'c1', date: '2026-01-12', slot: null, name: 'Snack A', calories: 150, protein: 5, carbs: 20, fat: 4 });
  await insertLog(db, { client_id: 'c1', date: '2026-01-12', slot: null, name: 'Snack B', calories: 200, protein: 8, carbs: 25, fat: 5 });
  // A logged-but-not-eaten row on the same date -- must appear in `logs`
  // but NOT count toward that day's totals.
  await insertLog(db, { client_id: 'c1', date: '2026-01-12', slot: null, name: 'Skipped Shake', calories: 400, protein: 40, carbs: 10, fat: 5, eaten: 0 });

  // A nutrition target for c1 (drives the `target` field in the response).
  await db.run(
    `INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ['np1', 'o1', 't1', 'c1', 'Plan', 2200, 160, 220, 70, '2026-01-01T00:00:00Z']);
}

// ---- start server ----
async function startHistoryApi() {
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

  const sign = (payload) => jwt.sign(payload, config.jwtSecret, { expiresIn: '1h' });
  const tokens = {
    client1: sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client One' }),
    client2: sign({ sub: 'u2', role: 'CLIENT', org: 'o2', name: 'Client Two' }),
    trainer1: sign({ sub: 't1', role: 'TRAINER', org: 'o1', name: 'Trainer One' }),
    trainer2: sign({ sub: 't2', role: 'TRAINER', org: 'o1', name: 'Trainer Two' }),
  };

  const call = async (p, token) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${p}`, { headers });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close, tokens };
}

// ---- tests ----

test('unauthenticated request -> 401', async (t) => {
  const { call, close } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history', '');
  assert.equal(r.status, 401);
});

test('unknown client -> 404', async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/ghost/history', tokens.client1);
  assert.equal(r.status, 404);
});

test("today's history (default range, no from/to given)", async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history', tokens.client1);
  assert.equal(r.status, 200);
  assert.equal(r.json.to, todayKey());
  const today = r.json.days.find((d) => d.date === todayKey());
  assert.ok(today, 'today should be present in the default range');
  assert.equal(today.calories, 600);
});

test('an old date is correctly aggregated', async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history?from=2026-01-10&to=2026-01-10', tokens.client1);
  assert.equal(r.status, 200);
  assert.equal(r.json.days.length, 1);
  const day = r.json.days[0];
  assert.equal(day.date, '2026-01-10');
  assert.equal(day.calories, 300);
  assert.equal(day.protein, 12);
  assert.equal(day.logs.length, 1);
  assert.equal(day.logs[0].name, 'Oats');
});

test('a date with multiple unslotted food logs -- slot stays optional, totals exclude un-eaten', async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history?from=2026-01-12&to=2026-01-12', tokens.client1);
  assert.equal(r.status, 200);
  const day = r.json.days[0];
  assert.equal(day.logs.length, 3, 'all logs present, including the un-eaten one');
  assert.ok(day.logs.every((l) => l.slot === null), 'unslotted foods display normally with slot: null');
  // 150 + 200 eaten; the 400-kcal skipped shake (eaten:0) must NOT count.
  assert.equal(day.calories, 350);
  assert.equal(day.protein, 13);
  const skipped = day.logs.find((l) => l.name === 'Skipped Shake');
  assert.equal(skipped.eaten, false);
});

test('empty date range -> clean empty result, not an error', async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history?from=2026-02-01&to=2026-02-01', tokens.client1);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.days, []);
});

test('target reflects the client\'s current nutrition plan', async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history?from=2026-01-10&to=2026-01-10', tokens.client1);
  assert.deepEqual(r.json.target, { calories: 2200, protein: 160, carbs: 220, fat: 70 });
});

test('cross-organization client access -> 403', async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history', tokens.client2);
  assert.equal(r.status, 403);
});

test("client cannot view another client's history -> 403", async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c2/history', tokens.client1);
  assert.equal(r.status, 403);
});

test("assigned trainer -> 200 (authorized access to their client's history)", async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history?from=2026-01-10&to=2026-01-10', tokens.trainer1);
  assert.equal(r.status, 200);
  assert.equal(r.json.days[0].calories, 300);
});

test('trainer NOT assigned to this client (same org) -> 403', async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history', tokens.trainer2);
  assert.equal(r.status, 403);
});

test('invalid range (from after to) -> 400', async (t) => {
  const { call, close, tokens } = await startHistoryApi();
  t.after(() => close());
  const r = await call('/api/nutrition/clients/c1/history?from=2026-02-01&to=2026-01-01', tokens.client1);
  assert.equal(r.status, 400);
});
