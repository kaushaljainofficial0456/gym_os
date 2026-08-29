// ============================================================
// Integration tests for the meal-logging API endpoint:
//   POST /api/nutrition/clients/:id/meals/log
//
// Covers:
//   * unauthenticated request -> 401
//   * invalid/nonexistent client -> 404
//   * invalid payload -> 422
//   * valid meal log -> 201 + database persistence
//   * cross-organization client access -> 403
//   * SQL injection safely handled
//   * negative/NaN numeric input rejected
//   * rate limiting -> 429
//   * duplicate submissions create separate records (by design)
// ============================================================
import test, { mock } from 'node:test';
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

// ---- in-memory SQLite helper ----
async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // meal_logs.ai_provider/ai_model/ai_confidence (food-AI Tier 4
  // provenance, see foodAI.js) exist only via scripts/init-db.js's guarded
  // migrations, which this lightweight in-memory DB doesn't run -- same
  // gap documented in barcodeApi.test.js's memDb() for the `foods` table.
  for (const ddl of ['ai_provider TEXT', 'ai_model TEXT', 'ai_confidence TEXT']) {
    db.exec(`ALTER TABLE meal_logs ADD COLUMN ${ddl}`);
  }
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

// ---- seed two orgs with users and clients for cross-tenant testing ----
async function seedFixtures(db) {
  // Org 1
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client1@test.com', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);

  // Org 2 (for cross-tenant test)
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o2', 'Gym B', 'gym-b', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u2', 'o2', 'client2@test.com', 'x', 'Client Two', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c2', 'u2', 'o2', 'GENERAL', '2026-01-01T00:00:00Z']);
}

// ---- start server ----
async function startMealLogApi() {
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

  const token1 = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client One' }, config.jwtSecret, { expiresIn: '1h' });
  const token2 = jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o2', name: 'Client Two' }, config.jwtSecret, { expiresIn: '1h' });

  const call = async (method, p, body, token = token1) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${p}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close, base, token1, token2 };
}

// ---- tests ----

test('unauthenticated request -> 401', async (t) => {
  const { call, close } = await startMealLogApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/log', { name: 'Lunch', calories: 500, protein: 30, carbs: 50, fat: 15 }, '');
  assert.equal(r.status, 401);
  assert.match(r.json.error, /auth/i);
});

test('nonexistent client -> 404', async (t) => {
  const { call, close } = await startMealLogApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/nonexistent/meals/log', { name: 'Lunch', calories: 500, protein: 30, carbs: 50, fat: 15 });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /not found/i);
});

test('missing required fields -> 422', async (t) => {
  const { call, close } = await startMealLogApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/log', {});
  assert.equal(r.status, 422);
  assert.ok(r.json.issues, 'has issues array');
  assert.ok(r.json.issues.some(i => i.includes('name')), 'mentions name field');
});

test('empty name -> 422', async (t) => {
  const { call, close } = await startMealLogApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/log', { name: '', calories: 500, protein: 30, carbs: 50, fat: 15 });
  assert.equal(r.status, 422);
});

test('negative calories -> 422', async (t) => {
  const { call, close } = await startMealLogApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/log', { name: 'Lunch', calories: -100, protein: 30, carbs: 50, fat: 15 });
  assert.equal(r.status, 422);
  assert.ok(r.json.issues.some(i => i.includes('calories')), 'rejects negative calories');
});

test('exceeds max calories -> 422', async (t) => {
  const { call, close } = await startMealLogApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/log', { name: 'Lunch', calories: 99999, protein: 30, carbs: 50, fat: 15 });
  assert.equal(r.status, 422);
  assert.ok(r.json.issues.some(i => i.includes('calories')), 'rejects excessive calories');
});

test('valid meal log -> 201 and persisted in database', async (t) => {
  const { db, call, close } = await startMealLogApi();
  t.after(() => close());
  const payload = { name: 'Chicken Rice Bowl', calories: 520, protein: 35, carbs: 55, fat: 14, slot: 'lunch', source: 'manual' };
  const r = await call('POST', '/api/nutrition/clients/c1/meals/log', payload);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { ok: true });

  // Verify database persistence
  const row = await db.q1('SELECT * FROM meal_logs WHERE client_id = ? ORDER BY rowid DESC LIMIT 1', ['c1']);
  assert.ok(row, 'meal log row exists');
  assert.equal(row.client_id, 'c1');
  assert.equal(row.name, 'Chicken Rice Bowl');
  assert.equal(row.calories, 520);
  assert.equal(row.protein, 35);
  assert.equal(row.carbs, 55);
  assert.equal(row.fat, 14);
  assert.equal(row.slot, 'lunch');
  assert.equal(row.source, 'manual');
  assert.equal(row.eaten, 1, 'default eaten is true');
  assert.equal(row.estimate, 0, 'default estimate is false');
  assert.ok(row.date, 'date is set');
  assert.ok(row.id.startsWith('mlg_'), 'id has correct prefix');
});

test('meal log with source=ai and estimate=true is persisted', async (t) => {
  const { db, call, close } = await startMealLogApi();
  t.after(() => close());
  const payload = { name: 'Dal Roti', calories: 350, protein: 15, carbs: 50, fat: 8, source: 'ai', estimate: true };
  const r = await call('POST', '/api/nutrition/clients/c1/meals/log', payload);
  assert.equal(r.status, 201);
  const row = await db.q1('SELECT * FROM meal_logs WHERE client_id = ? ORDER BY rowid DESC LIMIT 1', ['c1']);
  assert.equal(row.source, 'ai');
  assert.equal(row.estimate, 1);
});

test('cross-organization client access is rejected', async (t) => {
  const { call, close } = await startMealLogApi();
  t.after(() => close());
  // User from org1 tries to log a meal for client in org2
  const r = await call('POST', '/api/nutrition/clients/c2/meals/log', { name: 'Lunch', calories: 500, protein: 30, carbs: 50, fat: 15 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /access/i);
});

test('SQL injection in name field is safely handled', async (t) => {
  const { db, call, close } = await startMealLogApi();
  t.after(() => close());
  const payload = { name: "'; DROP TABLE meal_logs; --", calories: 100, protein: 10, carbs: 10, fat: 5 };
  const r = await call('POST', '/api/nutrition/clients/c1/meals/log', payload);
  assert.equal(r.status, 201, 'request succeeds (parameterized query)');
  // Verify the malicious string is stored literally, not executed
  const row = await db.q1('SELECT * FROM meal_logs WHERE client_id = ? ORDER BY rowid DESC LIMIT 1', ['c1']);
  assert.equal(row.name, "'; DROP TABLE meal_logs; --", 'malicious string stored literally');
  // Verify the table still exists
  const tableCheck = await db.q1("SELECT name FROM sqlite_master WHERE type='table' AND name='meal_logs'");
  assert.ok(tableCheck, 'meal_logs table still exists');
});

test('duplicate submissions create separate records (by design)', async (t) => {
  const { db, call, close } = await startMealLogApi();
  t.after(() => close());
  const payload = { name: 'Banana', calories: 105, protein: 1, carbs: 27, fat: 0 };
  const r1 = await call('POST', '/api/nutrition/clients/c1/meals/log', payload);
  const r2 = await call('POST', '/api/nutrition/clients/c1/meals/log', payload);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  const rows = await db.q('SELECT * FROM meal_logs WHERE client_id = ? AND name = ?', ['c1', 'Banana']);
  assert.equal(rows.length, 2, 'duplicate submissions create separate records');
  assert.notEqual(rows[0].id, rows[1].id, 'each record has a unique ID');
});

test('rate limit returns 429 after exceeding threshold', async (t) => {
  resetRateLimits();
  const { call, close } = await startMealLogApi();
  t.after(() => { resetRateLimits(); close(); });

  // Rate limit is 60/min. Send 65 requests to exceed it.
  // Freeze time for the burst: the limiter keys its window on
  // Math.floor(Date.now() / windowMs), so real sequential requests can
  // straddle an actual clock-minute boundary under load and spuriously
  // never hit the limit -- a test-timing flake, not a real bug.
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let hitLimit = false;
  try {
    for (let i = 0; i < 65; i++) {
      const r = await call('POST', '/api/nutrition/clients/c1/meals/log', { name: 'Snack', calories: 50, protein: 2, carbs: 8, fat: 1 });
      if (r.status === 429) {
        hitLimit = true;
        assert.ok(r.json.error.includes('many') || r.json.error.includes('try again'), '429 has rate-limit message');
        break;
      }
      assert.equal(r.status, 201, `request ${i + 1} succeeded`);
    }
  } finally {
    mock.timers.reset();
  }
  assert.ok(hitLimit, 'rate limit was triggered within 65 requests');
});
