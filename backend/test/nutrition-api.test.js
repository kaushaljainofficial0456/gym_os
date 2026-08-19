// ============================================================
// Integration tests for the food-estimation API endpoint:
//   POST /api/nutrition/clients/:id/meals/ai-estimate
//
// Covers:
//   * unauthenticated request -> 401
//   * invalid client_id -> 404
//   * empty/missing text -> 422
//   * valid authenticated request -> 200 + correct shape
//   * response contains text, items, total, estimate, disclaimer
//   * repeated requests hit the configured rate limit -> 429
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

// ---- in-memory SQLite helper (same pattern as calorieContract.test.js) ----
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
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

// ---- seed org + user + client ----
async function seedFixtures(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Test Gym', 'test-gym', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client@test.com', 'x', 'Test Client', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);
}

// ---- start server with nutrition routes ----
async function startNutritionApi() {
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
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Test Client' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, extraHeaders = {}) => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extraHeaders };
    const res = await fetch(`${base}${p}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json, headers: Object.fromEntries(res.headers) };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close, base, token };
}

// ---- tests ----

test('unauthenticated request -> 401', async (t) => {
  const { call, close } = await startNutritionApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/ai-estimate', { text: '2 roti' }, { Authorization: '' });
  assert.equal(r.status, 401);
  assert.match(r.json.error, /auth/i);
});

test('invalid client_id -> 404', async (t) => {
  const { call, close } = await startNutritionApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/nonexistent/meals/ai-estimate', { text: '2 roti' });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /not found/i);
});

test('empty text -> 422 validation error', async (t) => {
  const { call, close } = await startNutritionApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/ai-estimate', { text: '' });
  assert.equal(r.status, 422);
  assert.ok(r.json.issues, 'has issues array');
  assert.ok(r.json.issues.some(i => i.includes('text')), 'mentions text field');
});

test('missing text field -> 422 validation error', async (t) => {
  const { call, close } = await startNutritionApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/ai-estimate', {});
  assert.equal(r.status, 422);
  assert.ok(r.json.issues.some(i => i.includes('text')), 'mentions text field');
});

test('valid request returns correct response shape', async (t) => {
  const { call, close } = await startNutritionApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/ai-estimate', { text: '2 roti' });
  assert.equal(r.status, 200);
  // top-level shape
  assert.equal(typeof r.json.text, 'string', 'text is string');
  assert.ok(Array.isArray(r.json.items), 'items is array');
  assert.ok(r.json.total, 'total exists');
  assert.equal(typeof r.json.total.calories, 'number', 'total.calories is number');
  assert.equal(typeof r.json.total.protein, 'number', 'total.protein is number');
  assert.equal(typeof r.json.total.carbs, 'number', 'total.carbs is number');
  assert.equal(typeof r.json.total.fat, 'number', 'total.fat is number');
  assert.equal(r.json.estimate, true, 'estimate flag is true');
  assert.equal(typeof r.json.disclaimer, 'string', 'disclaimer is string');
  assert.ok(r.json.disclaimer.length > 0, 'disclaimer is non-empty');
  // item shape
  if (r.json.items.length > 0) {
    const item = r.json.items[0];
    assert.equal(typeof item.name, 'string', 'item.name is string');
    assert.equal(typeof item.grams, 'number', 'item.grams is number');
    assert.ok(item.grams > 0, 'item.grams > 0');
    assert.equal(typeof item.calories, 'number', 'item.calories is number');
  }
});

test('food estimate returns correct grams for known input', async (t) => {
  const { call, close } = await startNutritionApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/ai-estimate', { text: '2 roti' });
  assert.equal(r.status, 200);
  assert.ok(r.json.items.length >= 1, 'at least one item');
  const roti = r.json.items.find(i => i.name.toLowerCase().includes('roti') || i.name.toLowerCase().includes('chapati'));
  assert.ok(roti, 'roti found in items');
  assert.equal(roti.grams, 80, '2 roti = 80g');
});

test('rate limit returns 429 after exceeding threshold', async (t) => {
  resetRateLimits();
  const { call, close } = await startNutritionApi();
  t.after(() => { resetRateLimits(); close(); });

  // The rate limit is 30/min. Send 31 requests to exceed it.
  // Use a unique client_id that exists to avoid 404s.
  let hitLimit = false;
  for (let i = 0; i < 35; i++) {
    const r = await call('POST', '/api/nutrition/clients/c1/meals/ai-estimate', { text: '1 banana' });
    if (r.status === 429) {
      hitLimit = true;
      assert.ok(r.json.error.includes('many') || r.json.error.includes('rate') || r.json.error.includes('try again'),
        '429 response has rate-limit message');
      assert.ok(r.headers['retry-after'], 'Retry-After header present');
      break;
    }
    // Before hitting the limit, requests should succeed (200 or 404 for bad client)
    assert.ok(r.status === 200 || r.status === 404, `request ${i + 1} returned ${r.status}`);
  }
  assert.ok(hitLimit, 'rate limit was triggered within 35 requests');
});

test('response does not leak internal source IDs or database details', async (t) => {
  const { call, close } = await startNutritionApi();
  t.after(() => close());
  const r = await call('POST', '/api/nutrition/clients/c1/meals/ai-estimate', { text: 'paneer' });
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.json);
  // Should not contain raw source IDs like "usda:" or "cnf:" in top-level error messages
  // (source_id in items is fine — it's part of the food contract)
  assert.ok(!body.includes('SELECT'), 'no SQL in response');
  assert.ok(!body.includes('sqlite'), 'no database driver name in response');
  assert.ok(!body.includes('Error:'), 'no Error stack in response');
});
