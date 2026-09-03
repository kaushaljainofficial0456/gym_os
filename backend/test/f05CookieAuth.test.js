// ============================================================
// F-05 REGRESSION (backend half): the httpOnly cookie is now the sole
// browser authentication mechanism -- these tests cover the two backend
// pieces this required:
//   1. POST /auth/logout actually clears the cookie server-side (it
//      never existed before this fix -- clearAuthCookie() was defined
//      but never called anywhere).
//   2. GET /auth/me (and any cookie-only request generally) authenticates
//      via the cookie alone, no Authorization header needed.
//   3. clientError.js's tryDecodeUser() falls back to the cookie too, so
//      ErrorBoundary.jsx's credentials-only fetch keeps enriching crash
//      reports with org/user context.
//
// The frontend half (api.js no longer reading/writing a token,
// AskSK.jsx/ErrorBoundary.jsx no longer reading localStorage directly)
// has no automated test suite of its own -- verified by build + live
// browser walkthrough instead (login, authenticated navigation, logout,
// session-expired handling), see the security verification report for
// that evidence.
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
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await this.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
  };
}

// Minimal cookie-jar fetch helper: captures Set-Cookie from a response and
// replays it on the next request, mirroring what a real browser does --
// none of this suite's other harnesses need this (they auth via a Bearer
// header built straight from a signed JWT), but a cookie-auth test
// genuinely needs to role-play the browser's own cookie storage.
function makeCookieJar() {
  let cookies = {};
  return {
    capture(res) {
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.raw?.()['set-cookie'] || []);
      for (const line of setCookie) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        // An expired/cleared cookie (Expires in the past, empty value) --
        // model it as removed rather than stored, matching real browsers.
        if (/expires=thu, 01 jan 1970/i.test(line) || value === '') delete cookies[name];
        else cookies[name] = value;
      }
    },
    header() {
      const pairs = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
      return pairs.length ? pairs.join('; ') : undefined;
    },
    has(name) { return name in cookies; },
  };
}

async function startAuthApi(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.use((req, _res, next) => {
    req.cookies = {};
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.split('=');
      if (k?.trim()) req.cookies[k.trim()] = decodeURIComponent(rest.join('='));
    }
    next();
  });
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const jar = makeCookieJar();
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(jar.header() ? { Cookie: jar.header() } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    jar.capture(res);
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close, jar };
}

async function seedOrgAndOwner(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'owner@x.in', ?, 'GYM_OWNER', 'Owner', 1, '2026-01-01T00:00:00Z')`,
    [await (await import('bcryptjs')).default.hash('password123', 10)]);
}

test('login sets the httpOnly cookie, and a cookie-only request (no Authorization header) authenticates via it', async (t) => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const api = await startAuthApi(db);
  t.after(() => api.close());

  const login = await api.call('POST', '/api/auth/login', { email: 'owner@x.in', password: 'password123' });
  assert.equal(login.status, 200);
  assert.ok(api.jar.has('sk_token'), 'login response set the sk_token cookie');

  const me = await api.call('GET', '/api/auth/me');
  assert.equal(me.status, 200, 'cookie alone (no Authorization header sent) authenticates the request');
  assert.equal(me.json.user.email, 'owner@x.in');
});

test('POST /auth/logout clears the cookie -- a subsequent request is unauthenticated', async (t) => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const api = await startAuthApi(db);
  t.after(() => api.close());

  await api.call('POST', '/api/auth/login', { email: 'owner@x.in', password: 'password123' });
  assert.ok(api.jar.has('sk_token'), 'sanity: logged in, cookie present');

  const logout = await api.call('POST', '/api/auth/logout');
  assert.equal(logout.status, 200);
  assert.equal(logout.json.ok, true);
  assert.equal(api.jar.has('sk_token'), false, 'the cookie jar no longer holds sk_token after the Set-Cookie clear response');

  const meAfter = await api.call('GET', '/api/auth/me');
  assert.equal(meAfter.status, 401, 'a request after logout is genuinely unauthenticated, not just locally forgotten');
});

test('POST /auth/logout succeeds even with no session at all (idempotent, never requires auth)', async (t) => {
  const db = await memDb();
  const api = await startAuthApi(db);
  t.after(() => api.close());
  const logout = await api.call('POST', '/api/auth/logout');
  assert.equal(logout.status, 200, 'logging out with nothing to log out of still succeeds cleanly');
  assert.equal(logout.json.ok, true);
});

test('clientError.js: tryDecodeUser falls back to the sk_token cookie when no Authorization header is sent', async (t) => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const authApi = await startAuthApi(db);
  const login = await authApi.call('POST', '/api/auth/login', { email: 'owner@x.in', password: 'password123' });
  assert.equal(login.status, 200);
  await authApi.close();

  const clientErrorRoutes = (await import('../src/routes/clientError.js')).default;
  const app = express();
  app.use((req, _res, next) => {
    req.cookies = {};
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.split('=');
      if (k?.trim()) req.cookies[k.trim()] = decodeURIComponent(rest.join('='));
    }
    next();
  });
  app.use(express.json());
  app.use('/api/client-error', clientErrorRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

  const res = await fetch(`http://127.0.0.1:${port}/api/client-error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authApi.jar.header() },
    body: JSON.stringify({ message: 'test crash' }),
  });
  assert.equal(res.status, 204);

  const event = await db.q1(`SELECT * FROM events WHERE type = 'client_error' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(event, 'the crash report was recorded');
  assert.equal(event.user_id, 'u1', 'org/user context was resolved from the COOKIE, not an Authorization header (none was sent)');
  assert.equal(event.org_id, 'o1');
});
