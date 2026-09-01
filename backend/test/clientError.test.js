// ============================================================
// CLIENT (BROWSER) ERROR REPORTING — POST /api/client-error
//
// Public route (no auth required -- a crash can happen before login), so
// this covers: the shape gets persisted correctly, a present-but-invalid
// or absent JWT never blocks the report (best-effort context only), a
// present-and-valid JWT DOES attach org/user, and the IP-keyed rate
// limit actually engages.
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

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await this.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    raw: db,
  };
}

async function startApi() {
  const db = await memDb();
  const clientErrorRoutes = (await import('../src/routes/clientError.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/client-error', clientErrorRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

test('POST /api/client-error persists a well-formed crash report with no auth present', async (t) => {
  resetRateLimits();
  const { db, call, close } = await startApi();
  t.after(() => close());
  const r = await call({ message: 'TypeError: Cannot read properties of undefined', path: '/app/client/nutrition', component_stack: 'at MyDietCard\nat Nutrition' });
  assert.equal(r.status, 204, 'a crashed page must never depend on parsing a response body');
  const rows = await db.q(`SELECT * FROM events WHERE type = 'client_error'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].org_id, null, 'no auth present -- unscoped, never rejected for it');
  assert.equal(rows[0].user_id, null);
  const data = JSON.parse(rows[0].data_json);
  assert.equal(data.message, 'TypeError: Cannot read properties of undefined');
  assert.equal(data.path, '/app/client/nutrition');
});

test('POST /api/client-error attaches org/user when a valid JWT is present', async (t) => {
  resetRateLimits();
  const { db, call, close } = await startApi();
  t.after(() => close());
  // events.org_id/user_id are real foreign keys -- seed a minimal org+user
  // so the JWT's claims actually resolve to rows that can be attached.
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Org 1', 'org-1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'u1@x.in', 'x', 'Test User', '2026-01-01T00:00:00Z']);
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Test' }, config.jwtSecret, { expiresIn: '1h' });
  const r = await call({ message: 'crash with a real session' }, { Authorization: `Bearer ${token}` });
  assert.equal(r.status, 204);
  const row = await db.q1(`SELECT * FROM events WHERE type = 'client_error'`);
  assert.equal(row.org_id, 'o1');
  assert.equal(row.user_id, 'u1');
});

test('POST /api/client-error ignores an invalid/garbage Authorization header rather than rejecting the report', async (t) => {
  resetRateLimits();
  const { db, call, close } = await startApi();
  t.after(() => close());
  const r = await call({ message: 'crash with a garbage token' }, { Authorization: 'Bearer not.a.real.jwt' });
  assert.equal(r.status, 204, 'an unparseable token must never block a crash report');
  const row = await db.q1(`SELECT * FROM events WHERE type = 'client_error'`);
  assert.ok(row, 'the report was still recorded');
  assert.equal(row.org_id, null);
});

test('POST /api/client-error rejects a missing message (schema-validated, not silently dropped)', async (t) => {
  resetRateLimits();
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call({ path: '/app/client/nutrition' });
  assert.equal(r.status, 422);
});

test('POST /api/client-error is rate-limited by IP', async (t) => {
  resetRateLimits();
  const { call, close } = await startApi();
  t.after(() => close());
  // Freeze time for the burst: the limiter keys its window on
  // Math.floor(Date.now() / windowMs), so real sequential requests can
  // straddle an actual clock-minute boundary under load and spuriously
  // never hit the limit -- a test-timing flake, not a real bug.
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const statuses = [];
  try {
    for (let i = 0; i < 25; i++) {
      statuses.push((await call({ message: `burst ${i}` })).status);
    }
  } finally {
    mock.timers.reset();
  }
  assert.ok(statuses.includes(429), `expected at least one 429 in a 25-request burst against a 20/min limit, got: ${statuses.join(',')}`);
  assert.ok(statuses.slice(0, 20).every((s) => s === 204), 'the first 20 requests (at the configured limit) must all succeed');
});
