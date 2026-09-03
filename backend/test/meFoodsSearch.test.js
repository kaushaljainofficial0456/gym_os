// ============================================================
// GET /api/me/foods/search — custom-food visibility and identification.
// No dedicated test file existed for this route before (confirmed via a
// full search). Covers the follow-up hardening prompt's Section 2/3/18
// requirements directly: a client's own custom food appears in their
// own search (and carries a clear source marker the frontend can label
// "Custom food" with), and is NEVER visible in another client's search
// results -- privacy enforced at the query level (`client_id = ?`), not
// just hidden by the frontend.
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
  return { call, token, token2, close };
}

test.beforeEach(() => { resetRateLimits(); });

test('GET /me/foods/search: the searching client\'s own custom food appears, carrying a clear "not the shared database" marker', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  await call('POST', '/api/me/foods', { name: 'My Special Roti', calories: 210, protein: 6, carbs: 30, fat: 5 });
  const res = await call('GET', '/api/me/foods/search?q=My%20Special%20Roti');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const hit = res.json.foods.find((f) => f.name === 'My Special Roti');
  assert.ok(hit, 'the custom food must appear in its owner\'s own search');
  assert.equal(hit.calories, 210);
  // source is the frontend's own signal for the "Custom food" badge
  // (Section 3) -- must be the private/user-entered marker, not the
  // shared-database one.
  assert.equal(hit.source, 'USER_ENTERED');
  assert.ok(hit.id, 'a real foods.id must be present so the frontend can resolve/select it unambiguously');
});

// TEST C (Section 2's own test list, applied to the actual search
// surface): another client must never see this food, by name or
// otherwise -- privacy enforced by the query's own client_id filter,
// not merely absent from some other client-side list.
test('GET /me/foods/search: a custom food is invisible to every other client, even searching its exact name', async (t) => {
  const { call, token2, close } = await startApp(); t.after(() => close());
  await call('POST', '/api/me/foods', { name: 'My Special Roti', calories: 210, protein: 6, carbs: 30, fat: 5 });
  const res = await call('GET', '/api/me/foods/search?q=My%20Special%20Roti', undefined, token2);
  assert.equal(res.status, 200);
  const hit = res.json.foods.find((f) => f.name === 'My Special Roti');
  assert.equal(hit, undefined, 'client B must never see client A\'s private custom food in search, by name or otherwise');
});

test('GET /me/foods/search: two different clients can each independently search their own identically-named custom food', async (t) => {
  const { call, token2, close } = await startApp(); t.after(() => close());
  await call('POST', '/api/me/foods', { name: 'Curry', calories: 111, protein: 1, carbs: 1, fat: 1 });
  await call('POST', '/api/me/foods', { name: 'Curry', calories: 222, protein: 2, carbs: 2, fat: 2 }, token2);
  const asClient1 = await call('GET', '/api/me/foods/search?q=Curry');
  const asClient2 = await call('GET', '/api/me/foods/search?q=Curry', undefined, token2);
  const hit1 = asClient1.json.foods.find((f) => f.name === 'Curry');
  const hit2 = asClient2.json.foods.find((f) => f.name === 'Curry');
  assert.equal(hit1.calories, 111, 'client A sees only their OWN "Curry"');
  assert.equal(hit2.calories, 222, 'client B sees only their OWN "Curry"');
  assert.notEqual(hit1.id, hit2.id, 'two genuinely separate rows, never conflated by name');
});

test('GET /me/foods/search: unauthenticated request is rejected', async (t) => {
  const { call, close } = await startApp(); t.after(() => close());
  const res = await call('GET', '/api/me/foods/search?q=rice', undefined, null);
  assert.equal(res.status, 401);
});
