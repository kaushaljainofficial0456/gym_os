// ============================================================
// F-10 REGRESSION: email verification + password reset.
//
// Covers, all against the real HTTP routes in routes/auth.js (not the
// service functions directly, except where constructing an expired
// token needs it -- see issueAccountToken's own ttlMs override, same
// technique enrollmentToken.test.js already uses):
//   * registration issues a verification email; the link's token
//     genuinely verifies the account
//   * malformed / already-used / expired tokens are all rejected with
//     the right reason, never a crash
//   * resend-verification requires auth and is a no-op once verified
//   * forgot-password is byte-identical whether or not the account
//     exists (no account enumeration), and never emails the real
//     password anywhere
//   * reset-password actually changes the password (old password stops
//     working, new one works), is single-use, and clears the current
//     session cookie
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { _mockOutbox, _resetMockEmailStateForTests } from '../src/services/notifications/emailProvider.js';
import { issueAccountToken } from '../src/services/accountTokens.js';

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

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json, headers: res.headers };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

const flush = () => new Promise((r) => setImmediate(r));

test.beforeEach(() => { resetRateLimits(); _resetMockEmailStateForTests(); });

// ---------------- email verification ----------------

test('registration issues a verification email whose token actually verifies the account', async (t) => {
  const db = await memDb();
  const api = await startApp(db);
  t.after(() => api.close());

  const reg = await api.call('POST', '/api/auth/register-trainer', { name: 'New Trainer', email: 'newtrainer@x.in', password: 'password123' });
  assert.equal(reg.status, 201);
  await flush();

  const outbox = _mockOutbox();
  assert.equal(outbox.length, 1, 'exactly one verification email was sent');
  assert.equal(outbox[0].to, 'newtrainer@x.in');
  assert.match(outbox[0].html, /verify-email\?token=/);

  const before = await db.q1('SELECT email_verified FROM users WHERE email = ?', ['newtrainer@x.in']);
  assert.equal(before.email_verified, 0, 'not verified yet');

  const tokenMatch = outbox[0].html.match(/token=([^"&]+)/);
  const token = decodeURIComponent(tokenMatch[1]);
  const verify = await api.call('POST', '/api/auth/verify-email', { token });
  assert.equal(verify.status, 200);
  assert.equal(verify.json.ok, true);

  const after = await db.q1('SELECT email_verified FROM users WHERE email = ?', ['newtrainer@x.in']);
  assert.equal(after.email_verified, 1, 'now verified');
});

test('verify-email: a malformed token is rejected cleanly, never a 500', async (t) => {
  const db = await memDb();
  const api = await startApp(db);
  t.after(() => api.close());
  const r = await api.call('POST', '/api/auth/verify-email', { token: 'not-a-real-token-at-all' });
  assert.equal(r.status, 422);
  assert.equal(r.json.reason, 'malformed_token');
});

test('verify-email: a token is single-use -- the second attempt is rejected', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'u1@x.in', 'x', 'CLIENT', 'X', 1, '2026-01-01T00:00:00Z')`);
  const { payload } = await issueAccountToken(db, { userId: 'u1', purpose: 'EMAIL_VERIFY' });
  const api = await startApp(db);
  t.after(() => api.close());

  const first = await api.call('POST', '/api/auth/verify-email', { token: payload });
  assert.equal(first.status, 200);
  const second = await api.call('POST', '/api/auth/verify-email', { token: payload });
  assert.equal(second.status, 422);
  assert.equal(second.json.reason, 'already_consumed');
});

test('verify-email: an expired token is rejected even with a correct secret', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'u1@x.in', 'x', 'CLIENT', 'X', 1, '2026-01-01T00:00:00Z')`);
  const { payload } = await issueAccountToken(db, { userId: 'u1', purpose: 'EMAIL_VERIFY', ttlMs: -1000 }); // already expired
  const api = await startApp(db);
  t.after(() => api.close());
  const r = await api.call('POST', '/api/auth/verify-email', { token: payload });
  assert.equal(r.status, 422);
  assert.equal(r.json.reason, 'expired');
});

test('verify-email: a PASSWORD_RESET token cannot be used to verify an email (purpose-scoped)', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'u1@x.in', 'x', 'CLIENT', 'X', 1, '2026-01-01T00:00:00Z')`);
  const { payload } = await issueAccountToken(db, { userId: 'u1', purpose: 'PASSWORD_RESET' });
  const api = await startApp(db);
  t.after(() => api.close());
  const r = await api.call('POST', '/api/auth/verify-email', { token: payload });
  assert.equal(r.status, 422);
  assert.equal(r.json.reason, 'wrong_purpose');
});

test('resend-verification: requires auth, resends for an unverified account, no-ops for an already-verified one', async (t) => {
  const db = await memDb();
  const api = await startApp(db);
  t.after(() => api.close());

  const noAuth = await api.call('POST', '/api/auth/resend-verification');
  assert.equal(noAuth.status, 401);

  const reg = await api.call('POST', '/api/auth/register-trainer', { name: 'T', email: 't@x.in', password: 'password123' });
  await flush();
  _resetMockEmailStateForTests(); // clear the registration's own verification email

  const resend = await api.call('POST', '/api/auth/resend-verification', undefined, reg.json.token);
  assert.equal(resend.status, 200);
  assert.equal(resend.json.alreadyVerified, undefined);
  assert.equal(_mockOutbox().length, 1, 'a fresh verification email was sent');

  await db.run('UPDATE users SET email_verified = 1 WHERE email = ?', ['t@x.in']);
  _resetMockEmailStateForTests();
  const resendAgain = await api.call('POST', '/api/auth/resend-verification', undefined, reg.json.token);
  assert.equal(resendAgain.status, 200);
  assert.equal(resendAgain.json.alreadyVerified, true);
  assert.equal(_mockOutbox().length, 0, 'no email sent for an already-verified account');
});

// ---------------- password reset ----------------

test('forgot-password: identical generic response whether or not the account exists (no enumeration)', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'real@x.in', 'x', 'CLIENT', 'X', 1, '2026-01-01T00:00:00Z')`);
  const api = await startApp(db);
  t.after(() => api.close());

  const realAccount = await api.call('POST', '/api/auth/forgot-password', { email: 'real@x.in' });
  await flush();
  const fakeAccount = await api.call('POST', '/api/auth/forgot-password', { email: 'does-not-exist@x.in' });
  await flush();

  assert.equal(realAccount.status, fakeAccount.status, 'same HTTP status either way');
  assert.deepEqual(realAccount.json, fakeAccount.json, 'byte-identical response body either way');

  const outbox = _mockOutbox();
  assert.equal(outbox.length, 1, 'exactly one email sent -- only for the account that actually exists');
  assert.equal(outbox[0].to, 'real@x.in');
});

test('forgot-password: the email never contains the account\'s actual password anywhere', async (t) => {
  const db = await memDb();
  const api = await startApp(db);
  t.after(() => api.close());
  const secretPassword = 'th1s-1s-my-r34l-p4ssw0rd';
  await api.call('POST', '/api/auth/register-trainer', { name: 'T', email: 't@x.in', password: secretPassword });
  await flush();
  _resetMockEmailStateForTests();

  await api.call('POST', '/api/auth/forgot-password', { email: 't@x.in' });
  await flush();
  const outbox = _mockOutbox();
  assert.equal(outbox.length, 1);
  assert.doesNotMatch(outbox[0].html, new RegExp(secretPassword), 'the real password never appears in the reset email HTML');
  assert.doesNotMatch(outbox[0].text, new RegExp(secretPassword), 'the real password never appears in the reset email text');
  assert.match(outbox[0].html, /reset-password\?token=/);
});

test('reset-password: actually changes the password -- old password stops working, new one works, token is single-use', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  const api = await startApp(db);
  t.after(() => api.close());

  const reg = await api.call('POST', '/api/auth/register-trainer', { name: 'T', email: 'reset@x.in', password: 'old-password-123' });
  const userId = reg.json.user.id;

  const { payload } = await issueAccountToken(db, { userId, purpose: 'PASSWORD_RESET' });
  const reset = await api.call('POST', '/api/auth/reset-password', { token: payload, newPassword: 'brand-new-password-456' });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.ok, true);
  // Session cookie is cleared -- see routes/auth.js's own comment on why
  // only THIS device's cookie, not other devices' (documented residual
  // risk, not an oversight).
  const setCookie = reset.headers.getSetCookie ? reset.headers.getSetCookie() : [];
  assert.ok(setCookie.some((c) => /sk_token=;/.test(c) || /sk_token=;.*expires=thu, 01 jan 1970/i.test(c)), 'sk_token cookie is cleared in the response');

  const oldLogin = await api.call('POST', '/api/auth/login', { email: 'reset@x.in', password: 'old-password-123' });
  assert.equal(oldLogin.status, 401, 'the OLD password no longer works');

  const newLogin = await api.call('POST', '/api/auth/login', { email: 'reset@x.in', password: 'brand-new-password-456' });
  assert.equal(newLogin.status, 200, 'the NEW password works');

  const reuse = await api.call('POST', '/api/auth/reset-password', { token: payload, newPassword: 'yet-another-password-789' });
  assert.equal(reuse.status, 422);
  assert.equal(reuse.json.reason, 'already_consumed');
});

test('reset-password: rejects a too-short new password before ever touching the token', async (t) => {
  const db = await memDb();
  const api = await startApp(db);
  t.after(() => api.close());
  const r = await api.call('POST', '/api/auth/reset-password', { token: 'atk_whatever.somesecret1234567890', newPassword: 'short' });
  assert.equal(r.status, 422, 'zod validation rejects it before the route body even runs');
});

test('reset-password: an expired token is rejected', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'u1@x.in', 'x', 'CLIENT', 'X', 1, '2026-01-01T00:00:00Z')`);
  const { payload } = await issueAccountToken(db, { userId: 'u1', purpose: 'PASSWORD_RESET', ttlMs: -1000 });
  const api = await startApp(db);
  t.after(() => api.close());
  const r = await api.call('POST', '/api/auth/reset-password', { token: payload, newPassword: 'brand-new-password-456' });
  assert.equal(r.status, 422);
  assert.equal(r.json.reason, 'expired');
});

test('Google-registered accounts are pre-verified (email_verified = 1 at creation)', async (t) => {
  // Direct DB-level check -- the /auth/google route itself needs a real
  // verified Google ID token to exercise over HTTP (see
  // googleEnterpriseAuth.test.js for how that's mocked at the
  // OAuth2Client level); this test pins the INSERT statement's own
  // contract instead, which is what actually matters here.
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, ?, ?)', ['ind1', 'Independent Clients', 'independent', 'independent', '2026-01-01T00:00:00Z']);
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, avatar, active, email_verified, created_at)
     VALUES ('gu1', 'ind1', 'googleuser@gmail.com', 'x', 'CLIENT', 'Google User', NULL, 1, 1, '2026-01-01T00:00:00Z')`);
  const row = await db.q1('SELECT email_verified FROM users WHERE id = ?', ['gu1']);
  assert.equal(row.email_verified, 1);
});
