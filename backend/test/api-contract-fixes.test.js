// ============================================================
// Regression tests for two endpoints the frontend called but the backend
// never implemented -- found via a full frontend-call-to-backend-route
// cross-reference audit. Both features were fully built in the UI
// (validation, error toasts, confirm dialogs) and 404'd on every attempt.
//   POST/DELETE /api/me/avatar               (Profile.jsx)
//   DELETE /api/tracking/clients/:id/supplements/:supplementId  (Nutrition.jsx)
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

async function seedFixtures(db) {
  for (const [oid, slug] of [['o1', 'gym-a'], ['o2', 'gym-b']]) {
    await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [oid, 'Org ' + oid, slug, '2026-01-01T00:00:00Z']);
  }
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client@test.com', 'x', 'Test Client', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);
  // A second org's client, to prove the supplement-delete route is tenant-safe.
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u2', 'o2', 'other@test.com', 'x', 'Other Client', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c2', 'u2', 'o2', 'GENERAL', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO supplements (id, client_id, name, dose, active) VALUES (?, ?, ?, ?, 1)', ['sup1', 'c1', 'Whey Protein', '30g']);
  await db.run('INSERT INTO supplements (id, client_id, name, dose, active) VALUES (?, ?, ?, ?, 1)', ['sup2', 'c2', 'Creatine', '5g']);
}

async function startApi() {
  const db = await memDb();
  await seedFixtures(db);
  const meRoutes = (await import('../src/routes/me.js')).default;
  const trackingRoutes = (await import('../src/routes/tracking.js')).default;
  const app = express();
  // Matches backend/src/index.js's real per-path body limit for /api/me --
  // otherwise the oversized-image test below would be exercising Express's
  // default body-parser ceiling instead of the avatar route's own check.
  app.use('/api/me', express.json({ limit: '8mb' }));
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  app.use('/api/tracking', trackingRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const tokenFor = (sub, org) => jwt.sign({ sub, role: 'CLIENT', org, name: 'Test' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, token) => {
    const res = await fetch(`${base}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close, token1: tokenFor('u1', 'o1'), token2: tokenFor('u2', 'o2') };
}

// A tiny valid 1x1 PNG, well under the 1 MB cap.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('POST /me/avatar accepts a valid image and persists it', async (t) => {
  const { db, call, close, token1 } = await startApi();
  t.after(() => close());
  const r = await call('POST', '/api/me/avatar', { image: TINY_PNG }, token1);
  assert.equal(r.status, 200);
  assert.equal(r.json.avatar, TINY_PNG);
  const row = await db.q1('SELECT avatar FROM users WHERE id = ?', ['u1']);
  assert.equal(row.avatar, TINY_PNG);
});

test('POST /me/avatar rejects a non-image / malformed payload', async (t) => {
  const { call, close, token1 } = await startApi();
  t.after(() => close());
  const r = await call('POST', '/api/me/avatar', { image: 'not-a-data-url' }, token1);
  assert.equal(r.status, 400);
});

test('POST /me/avatar rejects an oversized image', async (t) => {
  const { call, close, token1 } = await startApi();
  t.after(() => close());
  // ~1.4 MB of base64 payload, comfortably over the 1 MB raw cap.
  const big = 'data:image/png;base64,' + 'A'.repeat(1_900_000);
  const r = await call('POST', '/api/me/avatar', { image: big }, token1);
  assert.equal(r.status, 413);
});

test('DELETE /me/avatar clears a previously-set avatar', async (t) => {
  const { db, call, close, token1 } = await startApi();
  t.after(() => close());
  await call('POST', '/api/me/avatar', { image: TINY_PNG }, token1);
  const r = await call('DELETE', '/api/me/avatar', null, token1);
  assert.equal(r.status, 200);
  const row = await db.q1('SELECT avatar FROM users WHERE id = ?', ['u1']);
  assert.equal(row.avatar, null);
});

test('DELETE /tracking/clients/:id/supplements/:supplementId soft-deletes (excluded from the GET list)', async (t) => {
  const { db, call, close, token1 } = await startApi();
  t.after(() => close());
  const before = await call('GET', '/api/tracking/clients/c1/supplements', null, token1);
  assert.equal(before.json.supplements.length, 1);

  const r = await call('DELETE', '/api/tracking/clients/c1/supplements/sup1', null, token1);
  assert.equal(r.status, 200);

  const after = await call('GET', '/api/tracking/clients/c1/supplements', null, token1);
  assert.equal(after.json.supplements.length, 0, 'deleted supplement must no longer be listed');

  // Soft delete, not a hard delete -- the row still exists, just inactive.
  const row = await db.q1('SELECT active FROM supplements WHERE id = ?', ['sup1']);
  assert.equal(row.active, 0);
});

test('DELETE /tracking/clients/:id/supplements/:supplementId is tenant-isolated', async (t) => {
  const { db, call, close, token1 } = await startApi();
  t.after(() => close());
  // Client u1/c1 (org o1) must not be able to delete org o2's supplement,
  // even by guessing/knowing its id, by passing THEIR OWN client id in the
  // URL -- resolveClient rejects c1 attempting to act as c2's supplement
  // owner implicitly by scoping the UPDATE to client_id = c1.
  const r = await call('DELETE', '/api/tracking/clients/c1/supplements/sup2', null, token1);
  assert.equal(r.status, 200, 'the route itself still responds (client c1 is valid for token1)');
  // But the cross-org row must be completely unaffected.
  const row = await db.q1('SELECT active FROM supplements WHERE id = ?', ['sup2']);
  assert.equal(row.active, 1, 'another org\'s supplement must not be affected by a same-shaped id');
});
