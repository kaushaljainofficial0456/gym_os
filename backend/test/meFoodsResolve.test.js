// ============================================================
// POST /api/me/foods/resolve — the server-authoritative endpoint every
// portion/quantity screen in the redesigned Nutrition UI depends on
// (FoodLogSheet.jsx's portion picker, its quick-log rows, and the
// multi-portion combination logic all call this and nothing else for
// grams->macros math; see that file's own header comment on why the
// client is never allowed to re-derive this itself).
//
// No dedicated test file existed for this route before (confirmed via a
// full search) despite it being the single most load-bearing endpoint
// in the whole redesign -- a real, high-value gap, not a nice-to-have.
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
  return { call, close };
}

test.beforeEach(() => { resetRateLimits(); });

test('POST /me/foods/resolve: free-grams path returns proportional totals for a known food', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: 100 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.totals.energy_kcal > 0);
  assert.equal(res.json.grams, 100);
});

test('POST /me/foods/resolve: doubling grams doubles every macro proportionally', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const r100 = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: 100 });
  const r200 = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: 200 });
  assert.equal(r100.status, 200); assert.equal(r200.status, 200);
  const t1 = r100.json.totals, t2 = r200.json.totals;
  assert.ok(Math.abs(t2.energy_kcal - t1.energy_kcal * 2) < 0.5, `${t2.energy_kcal} should be ~2x ${t1.energy_kcal}`);
  assert.ok(Math.abs(t2.protein_g - t1.protein_g * 2) < 0.1);
  assert.ok(Math.abs(t2.carb_g - t1.carb_g * 2) < 0.1);
});

// This is the EXACT assumption FoodLogSheet.jsx's multi-portion
// combination logic depends on: summing several separately-resolved
// totals client-side must equal one resolve() call for the equivalent
// combined grams -- otherwise "1 small bowl + 1 tablespoon" would show
// a different total than "the same weight resolved in one shot", and
// the whole "sum real numbers the server already computed" architecture
// (memory item 9) would be unsound.
test('POST /me/foods/resolve: summing two separate resolves equals one resolve for the combined grams (validates the multi-portion combination architecture)', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const rA = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: 60 });
  const rB = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: 40 });
  const combined = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: 100 });
  assert.equal(rA.status, 200); assert.equal(rB.status, 200); assert.equal(combined.status, 200);
  const summedKcal = rA.json.totals.energy_kcal + rB.json.totals.energy_kcal;
  assert.ok(Math.abs(summedKcal - combined.json.totals.energy_kcal) < 0.5,
    `summed (${summedKcal}) should match the direct 100g resolve (${combined.json.totals.energy_kcal})`);
  const summedProtein = rA.json.totals.protein_g + rB.json.totals.protein_g;
  assert.ok(Math.abs(summedProtein - combined.json.totals.protein_g) < 0.1);
});

test('POST /me/foods/resolve: a real portion_key + count resolves via the portion catalogue', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods/resolve', { name: 'rice', portion_key: 'tablespoon', count: 2 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.totals.energy_kcal > 0);
});

test('POST /me/foods/resolve: rejects a negative or zero grams value at the schema layer', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const neg = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: -50 });
  assert.equal(neg.status, 422);
  const zero = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: 0 });
  assert.equal(zero.status, 422);
});

test('POST /me/foods/resolve: unresolvable/nonsense food name returns a clean 404, not a crash', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods/resolve', { name: 'zzznonexistentqwerty12345', grams: 100 });
  assert.equal(res.status, 404);
});

test('POST /me/foods/resolve: unauthenticated request is rejected', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: 100 }, null);
  assert.equal(res.status, 401);
});
