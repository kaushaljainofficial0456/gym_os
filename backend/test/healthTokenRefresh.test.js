// ============================================================
// Token-refresh regression tests for syncOneConnection
// (backend/src/routes/health.js), at the HTTP route level against a
// real in-memory SQLite DB with global fetch mocked for WHOOP's host.
//
// WHY THIS FILE EXISTS: provider.refreshAccessToken was implemented in
// every OAuth adapter and never called by anything. WHOOP access tokens
// last ~1 hour, so a real connected account synced fine for an hour and
// then failed EVERY subsequent sync with "sync failed" -- reported from
// the live site two days after connecting. These tests lock the fix in:
//   1. an expired access token is refreshed before syncing
//   2. the ROTATED refresh token is persisted (WHOOP invalidates the old
//      one on every refresh -- keeping it bricks the NEXT refresh)
//   3. a 401 despite a not-yet-expired token forces one refresh + retry
//   4. a dead refresh grant surfaces as "reconnect required", not as a
//      generic sync error the user can only stare at
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';
import healthRoutes from '../src/routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const JWT_SECRET = 'test-secret-for-health-token-refresh';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    async q(sql, params = []) { const st = db.prepare(sql); return params.length ? st.all(...params) : st.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const st = db.prepare(sql); const r = params.length ? st.run(...params) : st.run(); return { changes: Number(r.changes) }; },
  });
  return mk();
}

async function seed(db, { expiresAt, refreshToken = 'refresh-v1' }) {
  const ts = '2026-01-01T00:00:00Z';
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', ts]);
  await db.run('INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,?,?,1,?)',
    ['u1', 'o1', 'c@test.com', 'x', 'CLIENT', 'Client', ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, current_weight, age, sex, height_cm, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ['c1', 'u1', 'o1', 'GENERAL', 78, 30, 'male', 178, ts]);
  await db.run(
    `INSERT INTO health_provider_connections (id, user_id, org_id, provider, status, external_account_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['hconn1', 'u1', 'o1', 'whoop', 'connected', '999', 'stale-access-token', refreshToken, expiresAt, ts, ts]);
}

async function startApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client', email: 'c@test.com' }, JWT_SECRET);
  const sync = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { sync, close: () => new Promise((r) => server.close(r)) };
}

/** Mocks WHOOP's host. `onRefresh` decides what the token endpoint does;
 *  `validAccessToken` is the only token the data endpoints accept --
 *  anything else gets a real 401, exactly like WHOOP would. */
function mockWhoop(t, { onRefresh, validAccessToken }) {
  const calls = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url);
    if (!u.includes('api.prod.whoop.com')) return realFetch(url, opts);
    if (u.includes('/oauth/oauth2/token')) {
      calls.push({ kind: 'refresh', body: String((opts && opts.body) || '') });
      return onRefresh();
    }
    const auth = String((opts && opts.headers && opts.headers.Authorization) || '');
    calls.push({ kind: 'data', url: u, auth });
    if (auth !== `Bearer ${validAccessToken}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
    return new Response(JSON.stringify({ records: [] }), { status: 200 });
  });
  return calls;
}

function tokenResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Every test needs the same three config values; restores them after. */
function withConfig(t) {
  const original = { secret: config.jwtSecret, id: config.whoopClientId, cs: config.whoopClientSecret };
  config.jwtSecret = JWT_SECRET;
  config.whoopClientId = 'cid';
  config.whoopClientSecret = 'csecret';
  t.after(() => {
    config.jwtSecret = original.secret;
    config.whoopClientId = original.id;
    config.whoopClientSecret = original.cs;
  });
}

test('an EXPIRED access token is refreshed before syncing, and the sync then succeeds', async (t) => {
  withConfig(t);
  const db = await memDb();
  await seed(db, { expiresAt: new Date(Date.now() - 60_000).toISOString() }); // expired a minute ago
  const { sync, close } = await startApp(db);
  t.after(() => close());

  const calls = mockWhoop(t, {
    validAccessToken: 'fresh-access-token',
    onRefresh: () => tokenResponse({ access_token: 'fresh-access-token', refresh_token: 'refresh-v2', expires_in: 3600 }),
  });

  const res = await sync();
  assert.equal(res.status, 200);
  assert.equal(res.json.results[0].ok, true, `sync should succeed after refresh, got ${JSON.stringify(res.json.results[0])}`);
  assert.equal(calls.filter((c) => c.kind === 'refresh').length, 1, 'exactly one refresh');
  assert.ok(calls.some((c) => c.kind === 'data' && c.auth === 'Bearer fresh-access-token'), 'data call must use the REFRESHED token');

  const conn = await db.q1('SELECT * FROM health_provider_connections WHERE id = ?', ['hconn1']);
  assert.equal(conn.access_token, 'fresh-access-token');
  assert.equal(conn.refresh_token, 'refresh-v2', 'the ROTATED refresh token must be persisted -- keeping the old one bricks the next refresh');
  assert.ok(Date.parse(conn.token_expires_at) > Date.now(), 'the new expiry must be persisted');
  assert.equal(conn.sync_error, null);
});

test('the WHOOP refresh call includes the offline scope (without it WHOOP can omit the new refresh token)', async (t) => {
  withConfig(t);
  const db = await memDb();
  await seed(db, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const { sync, close } = await startApp(db);
  t.after(() => close());
  const calls = mockWhoop(t, {
    validAccessToken: 'fresh-access-token',
    onRefresh: () => tokenResponse({ access_token: 'fresh-access-token', refresh_token: 'refresh-v2', expires_in: 3600 }),
  });

  await sync();
  const refresh = calls.find((c) => c.kind === 'refresh');
  assert.ok(refresh.body.includes('grant_type=refresh_token'), 'refresh grant type');
  assert.ok(refresh.body.includes('scope=offline'), 'offline scope must be sent on refresh');
});

test('a still-valid token is NOT refreshed unnecessarily', async (t) => {
  withConfig(t);
  const db = await memDb();
  await seed(db, { expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  await db.run('UPDATE health_provider_connections SET access_token = ? WHERE id = ?', ['still-good', 'hconn1']);
  const { sync, close } = await startApp(db);
  t.after(() => close());
  const calls = mockWhoop(t, { validAccessToken: 'still-good', onRefresh: () => tokenResponse({}) });

  const res = await sync();
  assert.equal(res.json.results[0].ok, true);
  assert.equal(calls.filter((c) => c.kind === 'refresh').length, 0, 'a valid token must not trigger a refresh');
});

test('a 401 despite a not-yet-expired token forces ONE refresh and retries the sync', async (t) => {
  withConfig(t);
  const db = await memDb();
  // Expiry claims it is valid for another hour, but the provider rejects it
  // (revoked server-side / clock skew) -- the retry path must handle it.
  await seed(db, { expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const { sync, close } = await startApp(db);
  t.after(() => close());
  const calls = mockWhoop(t, {
    validAccessToken: 'fresh-access-token', // the seeded 'stale-access-token' will 401
    onRefresh: () => tokenResponse({ access_token: 'fresh-access-token', refresh_token: 'refresh-v2', expires_in: 3600 }),
  });

  const res = await sync();
  assert.equal(res.json.results[0].ok, true, 'the retry after a forced refresh must succeed');
  assert.equal(calls.filter((c) => c.kind === 'refresh').length, 1, 'exactly one forced refresh, never a refresh loop');
});

test('a DEAD refresh grant reports reconnect-required and marks the connection revoked, not a generic sync error', async (t) => {
  withConfig(t);
  const db = await memDb();
  await seed(db, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const { sync, close } = await startApp(db);
  t.after(() => close());
  mockWhoop(t, {
    validAccessToken: 'never-issued',
    onRefresh: () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
  });

  const res = await sync();
  const result = res.json.results[0];
  assert.equal(result.ok, false);
  assert.equal(result.reconnectRequired, true);
  assert.match(result.error, /reconnect/i, 'the message must tell the user what to actually DO');

  const conn = await db.q1('SELECT * FROM health_provider_connections WHERE id = ?', ['hconn1']);
  assert.equal(conn.status, 'revoked', 'a dead grant is revoked, not merely error');
  assert.match(conn.sync_error, /reconnect/i);
});
