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
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o2', 'Gym B', 'gym-b', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u2', 'o2', 'client2@test.com', 'x', 'Client Two', '2026-01-01T00:00:00Z']);
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
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client One' }, config.jwtSecret, { expiresIn: '1h' });
  const token2 = jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o2', name: 'Client Two' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, tok = token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, token, token2, close };
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

// ============================================================
// Custom-food selection bug (follow-up hardening prompt, Section 2) --
// this endpoint used to be the ONLY way any search result got priced,
// including a client's own custom food, which has no source_id and so
// was "resolved" by NAME-searching the model catalogue instead --
// silently returning a DIFFERENT food's macros. `food_id` (a real
// `foods` row's own primary key) fixes this by pricing directly from
// that row, never a name-based guess. These are exactly Tests A-D from
// the master prompt.
// ============================================================

// TEST A: tapping a custom food resolves to ITS OWN macros, not a
// model-catalogue guess.
test('POST /me/foods/resolve: food_id resolves a custom food from its OWN stored macros, never a name-based model guess', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const created = await call('POST', '/api/me/foods', { name: 'Bread', calories: 333, protein: 11, carbs: 44, fat: 5 });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const res = await call('POST', '/api/me/foods/resolve', { food_id: created.json.id, grams: 100 });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  // These are the CUSTOM food's own numbers -- deliberately chosen to be
  // implausible for any real "Bread" in the model catalogue, so a pass
  // here can only mean the custom row's own data was used.
  assert.equal(res.json.totals.energy_kcal, 333);
  assert.equal(res.json.totals.protein_g, 11);
  assert.equal(res.json.totals.carb_g, 44);
  assert.equal(res.json.totals.fat_g, 5);
});

// TEST B: the model catalogue ALSO has "bread" (rice/maggi/etc. are the
// only names guaranteed in this dataset across environments, so this
// uses a name definitely present in skos-food-v1 instead of asserting
// on "bread" specifically) -- tapping the CUSTOM result must never pick
// up the catalogue's numbers.
test('POST /me/foods/resolve: a custom food sharing a name with a real catalogue entry still resolves to the custom one', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  // "rice" is a real, populous catalogue entry (used throughout this file's
  // other tests) -- creating a custom food with the SAME name is the
  // direct Test-B scenario: global database also contains "Bread"/"rice".
  const created = await call('POST', '/api/me/foods', { name: 'rice', calories: 9999, protein: 1, carbs: 1, fat: 1 });
  const res = await call('POST', '/api/me/foods/resolve', { food_id: created.json.id, grams: 100 });
  assert.equal(res.status, 200);
  assert.equal(res.json.totals.energy_kcal, 9999, 'must be the CUSTOM row\'s implausible value, not the real catalogue "rice"');
});

// TEST C: client B must never be able to resolve client A's private
// custom food, even by guessing a real food_id.
test('POST /me/foods/resolve: a custom food is never resolvable by another client, even with its real food_id', async (t) => {
  const { call, token2, close } = await startApp(); t.after(() => close());
  const created = await call('POST', '/api/me/foods', { name: 'Private Roti', calories: 150, protein: 5, carbs: 20, fat: 4 });
  const res = await call('POST', '/api/me/foods/resolve', { food_id: created.json.id, grams: 100 }, token2);
  assert.equal(res.status, 404, 'client B must not be able to resolve client A\'s private custom food');
});

// TEST D: two custom foods with the same name must each resolve to
// their OWN distinct record, selection never conflated by name.
test('POST /me/foods/resolve: two custom foods with the identical name each resolve to their own distinct record', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const first = await call('POST', '/api/me/foods', { name: 'Homemade Curry', calories: 100, protein: 5, carbs: 10, fat: 2 });
  const second = await call('POST', '/api/me/foods', { name: 'Homemade Curry', calories: 400, protein: 20, carbs: 40, fat: 15 });
  assert.notEqual(first.json.id, second.json.id);
  const r1 = await call('POST', '/api/me/foods/resolve', { food_id: first.json.id, grams: 100 });
  const r2 = await call('POST', '/api/me/foods/resolve', { food_id: second.json.id, grams: 100 });
  assert.equal(r1.json.totals.energy_kcal, 100);
  assert.equal(r2.json.totals.energy_kcal, 400);
});

test('POST /me/foods/resolve: food_id scales linearly with grams, same as the free-grams path', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const created = await call('POST', '/api/me/foods', { name: 'Scaling Test', calories: 200, protein: 10, carbs: 20, fat: 5 });
  const r100 = await call('POST', '/api/me/foods/resolve', { food_id: created.json.id, grams: 100 });
  const r200 = await call('POST', '/api/me/foods/resolve', { food_id: created.json.id, grams: 200 });
  assert.equal(r200.json.totals.energy_kcal, r100.json.totals.energy_kcal * 2);
  assert.equal(r200.json.totals.protein_g, r100.json.totals.protein_g * 2);
});

test('POST /me/foods/resolve: an invalid/unknown food_id returns a clean 404, never falls through to a name search', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods/resolve', { food_id: 'food_doesNotExist', name: 'rice', grams: 100 });
  assert.equal(res.status, 404);
});

test('POST /me/foods/resolve: unauthenticated request is rejected', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('POST', '/api/me/foods/resolve', { name: 'rice', grams: 100 }, null);
  assert.equal(res.status, 401);
});
