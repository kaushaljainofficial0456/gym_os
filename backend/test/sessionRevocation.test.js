// ============================================================
// Session revocation (users.sessions_valid_after) and the parallel
// per-request gates in requireAuth.
//
// Before: sessions were stateless 7-day JWTs. A password change or reset
// ended only the browser it happened in -- a token on another device, or
// one an attacker had copied, kept working for the rest of its 7 days
// (the documented F-10 residual risk). Now a password change, a reset or
// POST /auth/logout-everywhere records an instant, and requireAuth refuses
// any token issued before it.
//
// These run the REAL requireAuth and the real /api/auth routes against an
// in-memory database registered as the app's db (app.set('db', ...)),
// which is the handle requireAuth reads.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';
import {
  requireAuth, hashPassword, JWT_ALGORITHM, invalidateUserActive, invalidateOrgBillingCache, isSessionRevoked,
} from '../src/auth.js';
import { resetRateLimits } from '../src/rateLimit.js';
import { issueAccountToken } from '../src/services/accountTokens.js';
import { parseCookieHeader } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb({ migrated = true } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  // init-db.js's guarded migration; left out to model a database that has
  // not run db:init since the column was added.
  if (migrated) raw.exec('ALTER TABLE users ADD COLUMN sessions_valid_after TEXT');
  const db = {
    driver: 'sqlite',
    async q(sql, params = []) { const s = raw.prepare(sql); return params.length ? s.all(...params) : s.all(); },
    async q1(sql, params = []) { return (await db.q(sql, params))[0] || null; },
    async run(sql, params = []) { const s = raw.prepare(sql); const r = params.length ? s.run(...params) : s.run(); return { changes: Number(r.changes) }; },
    raw,
  };
  return db;
}

let seq = 0;
async function seedUser(db, { password = 'old-password-1' } = {}) {
  seq += 1;
  const orgId = `org_${seq}`;
  const userId = `user_${seq}`;
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, 'Gym', `gym-${seq}`, '2026-01-01T00:00:00Z']);
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'GYM_OWNER', 'Owner', 1, ?)`,
    [userId, orgId, `owner${seq}@x.in`, await hashPassword(password), '2026-01-01T00:00:00Z']);
  invalidateUserActive(userId);
  invalidateOrgBillingCache(orgId);
  return { userId, orgId, email: `owner${seq}@x.in` };
}

// A token as an earlier login would have issued it: same claims signToken
// writes, with `iat` a minute in the past (a revocation recorded "now"
// must catch it; whole-second precision makes same-second tokens survive).
function earlierToken({ userId, orgId, email }, secondsAgo = 60) {
  return jwt.sign(
    { sub: userId, role: 'GYM_OWNER', org: orgId, name: 'Owner', email, iat: Math.floor(Date.now() / 1000) - secondsAgo },
    config.jwtSecret, { algorithm: JWT_ALGORITHM, expiresIn: '7d' });
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.set('db', db);
  app.use((req, _res, next) => { req.cookies = parseCookieHeader(req.headers.cookie); next(); });
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.get('/api/probe', requireAuth, (req, res) => res.json({ sub: req.user.sub, org: req.user.org }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { body, token, cookie } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* empty body */ }
    const setCookie = res.headers.get('set-cookie') || '';
    return { status: res.status, json, setCookie };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

const tokenFromSetCookie = (setCookie) => {
  const m = setCookie.match(/sk_token=([^;]+)/);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
};

test.beforeEach(() => resetRateLimits());

test('without any revocation, an older token keeps working (no existing session is affected)', async (t) => {
  const db = await memDb();
  const u = await seedUser(db);
  const api = await startApp(db);
  t.after(() => api.close());
  const r = await api.call('GET', '/api/probe', { token: earlierToken(u, 6 * 24 * 3600) });
  assert.equal(r.status, 200);
  assert.equal(r.json.sub, u.userId);
});

test('change-password ends every OTHER session, and keeps this one signed in on the same gym', async (t) => {
  const db = await memDb();
  const u = await seedUser(db);
  const api = await startApp(db);
  t.after(() => api.close());

  const thisDevice = earlierToken(u);
  const otherDevice = earlierToken(u, 120);
  assert.equal((await api.call('GET', '/api/probe', { token: otherDevice })).status, 200, 'both work before');

  const change = await api.call('POST', '/api/auth/change-password', {
    token: thisDevice, body: { current_password: 'old-password-1', new_password: 'new-password-2' },
  });
  assert.equal(change.status, 200);

  assert.equal((await api.call('GET', '/api/probe', { token: otherDevice })).status, 401, 'other device is signed out');
  assert.equal((await api.call('GET', '/api/probe', { token: thisDevice })).status, 401, 'the pre-change token itself is retired');

  const replacement = tokenFromSetCookie(change.setCookie);
  assert.ok(replacement, 'a replacement session cookie is set');
  const me = await api.call('GET', '/api/probe', { token: replacement });
  assert.equal(me.status, 200, 'this device stays signed in');
  assert.equal(me.json.org, u.orgId, 'and on the same gym it was on');
});

test('a wrong current password changes nothing and revokes nothing', async (t) => {
  const db = await memDb();
  const u = await seedUser(db);
  const api = await startApp(db);
  t.after(() => api.close());
  const other = earlierToken(u);
  const r = await api.call('POST', '/api/auth/change-password', {
    token: earlierToken(u, 30), body: { current_password: 'wrong', new_password: 'new-password-2' },
  });
  assert.equal(r.status, 403);
  assert.equal((await api.call('GET', '/api/probe', { token: other })).status, 200);
  const row = await db.q1('SELECT sessions_valid_after FROM users WHERE id = ?', [u.userId]);
  assert.equal(row.sessions_valid_after, null);
});

test('reset-password ends every session on every device', async (t) => {
  const db = await memDb();
  const u = await seedUser(db);
  const api = await startApp(db);
  t.after(() => api.close());
  const phone = earlierToken(u);
  const laptop = earlierToken(u, 300);
  const { payload } = await issueAccountToken(db, { userId: u.userId, purpose: 'PASSWORD_RESET' });
  const reset = await api.call('POST', '/api/auth/reset-password', { body: { token: payload, newPassword: 'brand-new-pass-3' } });
  assert.equal(reset.status, 200);
  for (const tok of [phone, laptop]) {
    const r = await api.call('GET', '/api/probe', { token: tok });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'session_revoked');
  }
  // and the new password signs in to a working session
  const login = await api.call('POST', '/api/auth/login', { body: { email: u.email, password: 'brand-new-pass-3' } });
  assert.equal(login.status, 200);
  assert.equal((await api.call('GET', '/api/probe', { token: login.json.token })).status, 200);
});

test('logout-everywhere signs out this device and every other one; it needs a valid session', async (t) => {
  const db = await memDb();
  const u = await seedUser(db);
  const api = await startApp(db);
  t.after(() => api.close());
  assert.equal((await api.call('POST', '/api/auth/logout-everywhere')).status, 401, 'anonymous callers cannot act on an account');
  const a = earlierToken(u);
  const b = earlierToken(u, 90);
  const out = await api.call('POST', '/api/auth/logout-everywhere', { token: a });
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /sk_token=;/, 'this browser\'s cookie is cleared');
  assert.equal((await api.call('GET', '/api/probe', { token: a })).status, 401);
  assert.equal((await api.call('GET', '/api/probe', { token: b })).status, 401);
});

test('revocation is per user: another account\'s sessions are untouched', async (t) => {
  const db = await memDb();
  const u1 = await seedUser(db);
  const u2 = await seedUser(db);
  const api = await startApp(db);
  t.after(() => api.close());
  await api.call('POST', '/api/auth/logout-everywhere', { token: earlierToken(u1) });
  assert.equal((await api.call('GET', '/api/probe', { token: earlierToken(u2) })).status, 200);
});

test('a database without the new column: sign-in, password change and deactivation all still work', async (t) => {
  const db = await memDb({ migrated: false });
  const u = await seedUser(db);
  const api = await startApp(db);
  t.after(() => api.close());
  const tok = earlierToken(u);
  assert.equal((await api.call('GET', '/api/probe', { token: tok })).status, 200);
  const change = await api.call('POST', '/api/auth/change-password', {
    token: tok, body: { current_password: 'old-password-1', new_password: 'new-password-2' },
  });
  assert.equal(change.status, 200, 'the password change itself never fails over revocation');
  await db.run('UPDATE users SET active = 0 WHERE id = ?', [u.userId]);
  invalidateUserActive(u.userId);
  const off = await api.call('GET', '/api/probe', { token: tok });
  assert.equal(off.status, 401);
  assert.equal(off.json.error, 'This account is no longer active.');
});

test('gate order is unchanged: a deactivated account in a suspended gym gets the deactivation answer', async (t) => {
  const db = await memDb();
  const u = await seedUser(db);
  await db.run(`INSERT INTO org_billing_state (org_id, status, updated_at) VALUES (?, 'SUSPENDED', ?)`, [u.orgId, '2026-01-01T00:00:00Z'])
    .catch(async () => { await db.run(`INSERT INTO org_billing_state (org_id, status) VALUES (?, 'SUSPENDED')`, [u.orgId]); });
  invalidateOrgBillingCache(u.orgId);
  const api = await startApp(db);
  t.after(() => api.close());
  const tok = earlierToken(u);
  const suspended = await api.call('GET', '/api/probe', { token: tok });
  assert.equal(suspended.status, 403, 'a suspended gym is still refused');
  await db.run('UPDATE users SET active = 0 WHERE id = ?', [u.userId]);
  invalidateUserActive(u.userId);
  const both = await api.call('GET', '/api/probe', { token: tok });
  assert.equal(both.status, 401, 'deactivation is checked before suspension, as before');
});

test('isSessionRevoked: no record never revokes; a token from before the instant is revoked; same second survives', () => {
  assert.equal(isSessionRevoked(null, 100), false);
  assert.equal(isSessionRevoked({ validAfterSec: null }, 100), false);
  assert.equal(isSessionRevoked({ validAfterSec: 1000 }, 999), true);
  assert.equal(isSessionRevoked({ validAfterSec: 1000 }, 1000), false);
  assert.equal(isSessionRevoked({ validAfterSec: 1000 }, undefined), true, 'a token without iat cannot prove it is newer');
});
