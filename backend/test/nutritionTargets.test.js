// ============================================================
// Nutrition target confirm/save — POST /api/me/nutrition/targets/confirm
//
// Real bug fixed here: `calories` used to be saved as a FOURTH,
// independent number the client supplied directly, with zero
// cross-validation against protein/carbs/fat -- so a stale or
// inconsistent calorie figure (exactly what the frontend produced,
// since NutritionTargetSetup.jsx never recomputed it when a macro
// changed) could be persisted as a client's real nutrition target.
//
// Fix: calories is now ALWAYS derived server-side from
// protein/carbs/fat via the canonical 4/4/9 (Atwater) formula --
// the client-supplied `calories` field (if any) is never read at all.
// Also added real validation: non-finite/non-numeric values and
// out-of-bounds values are rejected with a clear 422, not silently
// clamped into range.
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
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client1@test.com', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);
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
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client One' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, tok = token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

test.beforeEach(() => { resetRateLimits(); });

test('POST /me/nutrition/targets/confirm: calories is derived via 4/4/9, never trusted from the client', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  // A deliberately WRONG calories figure -- must be ignored entirely.
  const res = await call('POST', '/api/me/nutrition/targets/confirm', { calories: 1, protein: 150, carbs: 200, fat: 60 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const expected = 150 * 4 + 200 * 4 + 60 * 9; // 600 + 800 + 540 = 1940
  assert.equal(res.json.plan.calories, expected);
  assert.equal(res.json.plan.protein, 150);
  assert.equal(res.json.plan.carbs, 200);
  assert.equal(res.json.plan.fat, 60);
});

test('POST /me/nutrition/targets/confirm: persists a plan whose calories column matches 4/4/9 exactly', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await call('POST', '/api/me/nutrition/targets/confirm', { protein: 100, carbs: 250, fat: 70 });
  const row = await db.q1(`SELECT * FROM nutrition_plans WHERE client_id = 'c1' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(row, 'a plan row was created');
  assert.equal(row.calories, 100 * 4 + 250 * 4 + 70 * 9); // 400 + 1000 + 630 = 2030
  assert.equal(row.protein, 100);
  assert.equal(row.carbs, 250);
  assert.equal(row.fat, 70);
});

test('POST /me/nutrition/targets/confirm: rejects a missing macro field with 422, not a silent default', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/nutrition/targets/confirm', { protein: 100, carbs: 250 });
  assert.equal(res.status, 422);
  assert.match(res.json.error, /Fat/);
});

test('POST /me/nutrition/targets/confirm: rejects a non-numeric string instead of silently coercing to NaN', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/nutrition/targets/confirm', { protein: 'abc', carbs: 250, fat: 70 });
  assert.equal(res.status, 422);
  assert.match(res.json.error, /Protein/);
});

test('POST /me/nutrition/targets/confirm: rejects NaN and Infinity explicitly', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const nan = await call('POST', '/api/me/nutrition/targets/confirm', { protein: 100, carbs: NaN, fat: 70 });
  assert.equal(nan.status, 422);
  const inf = await call('POST', '/api/me/nutrition/targets/confirm', { protein: 100, carbs: 250, fat: Infinity });
  assert.equal(inf.status, 422);
});

test('POST /me/nutrition/targets/confirm: rejects negative and absurdly large values with a clear range message', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const negative = await call('POST', '/api/me/nutrition/targets/confirm', { protein: -10, carbs: 250, fat: 70 });
  assert.equal(negative.status, 422);
  assert.match(negative.json.error, /Protein target must be between 20 and 500g/);

  const absurd = await call('POST', '/api/me/nutrition/targets/confirm', { protein: 100, carbs: 999999, fat: 70 });
  assert.equal(absurd.status, 422);
  assert.match(absurd.json.error, /Carb target must be between 20 and 800g/);
});

test('POST /me/nutrition/targets/confirm: rounds fractional macro grams', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/nutrition/targets/confirm', { protein: 100.6, carbs: 250.4, fat: 70.5 });
  assert.equal(res.status, 200);
  assert.equal(res.json.plan.protein, 101);
  assert.equal(res.json.plan.carbs, 250);
  assert.equal(res.json.plan.fat, 71); // Math.round(70.5) === 71 (round-half-up)
});

test('POST /me/nutrition/targets/confirm: unauthenticated request is rejected', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/nutrition/targets/confirm', { protein: 100, carbs: 250, fat: 70 }, null);
  assert.equal(res.status, 401);
});

test('GET /me/nutrition/targets: the suggested split still satisfies 4/4/9 within rounding', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await db.run(
    `INSERT INTO client_profiles (client_id, experience) VALUES ('c1', 'INTERMEDIATE')`
  ).catch(() => {}); // table/columns vary by schema version; best-effort, not the point of this test
  await db.run(`UPDATE clients SET current_weight = 75, height_cm = 178, age = 28, sex = 'MALE' WHERE id = 'c1'`);
  const res = await call('GET', '/api/me/nutrition/targets');
  assert.equal(res.status, 200);
  assert.equal(res.json.incomplete, false);
  const { calories, protein, carbs, fat } = res.json.targets;
  const derived = protein * 4 + carbs * 4 + fat * 9;
  // Allow small rounding slack -- macros are independently rounded before
  // carbs is derived from the remainder, per me.js's own comment.
  assert.ok(Math.abs(derived - calories) <= 6, `derived ${derived} vs stated ${calories} target diverges more than rounding allows`);
});
