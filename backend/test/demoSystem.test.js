// ============================================================
// FOUNDER-APPROVED 30-MINUTE DEMO SYSTEM
//
// Covers the acceptance criteria the spec lists, in its own groupings:
// authentication (who can reach demo admin), approval (the state
// machine), the timer (including the 29:59 / 00:01 / 00:00 boundaries),
// security (tenant isolation, and the four things a demo client must not
// be able to change about itself), refresh, multiple tabs, and
// expiration.
//
// Everything below drives the REAL routes over HTTP against a real
// in-memory database. Nothing is stubbed except the clock, and that only
// where a test would otherwise have to wait out half an hour -- the
// expiry boundary cases are asserted twice over: once against the pure
// decision function with an injected timestamp, and once end-to-end by
// writing a past expires_at and watching a real request get rejected.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { hashPassword, invalidateOrgDemoCache, invalidateOrgBillingCache } from '../src/auth.js';
import { id, now } from '../src/ids.js';
import {
  evaluateSession, expiryFor, hashToken, newAccessToken, DEMO_DURATION_MINUTES,
} from '../src/services/demo/session.js';
import { DEMO_PERSONAS } from '../src/services/demo/personas.js';
import { seedDemoTenant, DEMO_ORG_SLUG } from '../src/services/demo/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // Guarded migration columns (init-db.js MIGRATIONS) that schema.sql
  // deliberately does not carry -- mirrored here the same way every other
  // test in this suite mirrors them, so this in-memory database matches
  // what init-db.js actually produces.
  db.exec('ALTER TABLE organizations ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0');
  db.exec(`ALTER TABLE subscriptions ADD COLUMN lifecycle_status TEXT CHECK (lifecycle_status IN ('PENDING_PAYMENT','ACTIVE','PAUSED','SUSPENDED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED','TRANSFERRED'))`);
  db.exec('ALTER TABLE users ADD COLUMN branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL');
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    raw: db,
  });
  return mk();
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const demoRoutes = (await import('../src/routes/demo.js')).default;
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const app = express();
  // The same registration buildApp() makes, and the reason requireAuth's
  // demo gate can read this test's database rather than the process-wide
  // singleton -- see auth.js.
  app.set('db', db);
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/console', consoleRoutes(db));
  app.use('/api/demo', demoRoutes(db));
  // One ordinary PRODUCT route, mounted so the demo token can be proven
  // to work (and, once expired, to stop working) against the real
  // application rather than only against demo-specific endpoints.
  app.use('/api/admin', adminRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

/** Mirrors scripts/create-super-admin.js exactly -- there is deliberately
 *  no HTTP route that can mint a SUPER_ADMIN -- then logs in through the
 *  real /auth/login rather than fabricating a token by hand. */
async function createFounder(db, api, email = 'founder@sk-os.test') {
  const userId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [userId, email, await hashPassword('founderpass1'), 'Founder', now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password: 'founderpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

async function createGymOwner(api, email, orgName) {
  const signup = await api.call('POST', '/api/auth/setup-org', { orgName, ownerName: 'Owner', email, password: 'ownerpass1' });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  return { token: signup.json.token, orgId: signup.json.user.orgId, userId: signup.json.user.id };
}

const REQUEST_BODY = {
  ownerName: 'Kirthi', gymName: 'BeFitter', email: 'kirthi@befitter.example',
  phone: '+91 98450 11223', city: 'Bengaluru', memberCount: 90,
  message: 'Would like to see how member engagement works.',
};

/** Full setup: seeded demo tenant, a founder, a pending request. Shared
 *  by most tests below. Seeding is the slow part (~2s) so each test that
 *  needs a tenant pays for it once, not per assertion. */
async function world({ seedTenant = true } = {}) {
  resetRateLimits();
  invalidateOrgDemoCache();
  invalidateOrgBillingCache();
  const db = await memDb();
  const api = await startApp(db);
  const founder = await createFounder(db, api);
  let demoOrgId = null;
  if (seedTenant) ({ orgId: demoOrgId } = await seedDemoTenant(db));
  return { db, api, founder, demoOrgId, close: api.close };
}

/** Request -> approve -> the raw link token. The founder path, end to end. */
async function approvedToken(api, founder, body = REQUEST_BODY) {
  const created = await api.call('POST', '/api/demo/request', body);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const list = await api.call('GET', '/api/console/demos', undefined, founder.token);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const row = list.json.demos.find((d) => d.email === body.email.toLowerCase());
  assert.ok(row, 'the request appears in the founder dashboard');
  const approval = await api.call('POST', `/api/console/demos/${row.id}/approve`, {}, founder.token);
  assert.equal(approval.status, 200, JSON.stringify(approval.json));
  return { requestId: row.id, token: approval.json.accessToken, link: approval.json.demoLink, sessionId: approval.json.sessionId };
}

// ============================================================
// AUTHENTICATION -- who can reach demo admin
// ============================================================
test('demo admin is founder-only: anonymous and gym owners are refused, SUPER_ADMIN is allowed', async (t) => {
  const w = await world({ seedTenant: false });
  t.after(w.close);

  const anon = await w.api.call('GET', '/api/console/demos');
  assert.equal(anon.status, 401, 'unauthenticated cannot reach demo admin');

  const owner = await createGymOwner(w.api, 'owner@realgym.test', 'Real Gym');
  const asOwner = await w.api.call('GET', '/api/console/demos', undefined, owner.token);
  assert.equal(asOwner.status, 403, 'a gym owner cannot reach demo admin');

  const asFounder = await w.api.call('GET', '/api/console/demos', undefined, w.founder.token);
  assert.equal(asFounder.status, 200, 'the founder can');
  assert.ok(Array.isArray(asFounder.json.demos));
});

test('a gym owner cannot approve a demo for themselves', async (t) => {
  const w = await world();
  t.after(w.close);
  await w.api.call('POST', '/api/demo/request', REQUEST_BODY);
  const list = await w.api.call('GET', '/api/console/demos', undefined, w.founder.token);
  const requestId = list.json.demos[0].id;

  const owner = await createGymOwner(w.api, 'owner@selfserve.test', 'Self Serve Gym');
  for (const route of ['approve', 'reject', 'revoke', 'reissue']) {
    const res = await w.api.call('POST', `/api/console/demos/${requestId}/${route}`, {}, owner.token);
    assert.equal(res.status, 403, `a gym owner cannot ${route} a demo`);
  }
  const reset = await w.api.call('POST', '/api/console/demos/tenant/reset', {}, owner.token);
  assert.equal(reset.status, 403, 'a gym owner cannot reset the demo tenant');

  const after = await w.api.call('GET', '/api/console/demos', undefined, w.founder.token);
  assert.equal(after.json.demos[0].status, 'pending', 'the request is untouched');
});

// ============================================================
// APPROVAL -- the state machine
// ============================================================
test('a submitted request is pending and grants no access until a founder approves it', async (t) => {
  const w = await world();
  t.after(w.close);

  const created = await w.api.call('POST', '/api/demo/request', REQUEST_BODY);
  assert.equal(created.status, 201);
  // Nothing addressable comes back -- there is nothing for a prospect to
  // guess at or poll.
  assert.equal(created.json.id, undefined);
  assert.equal(created.json.accessToken, undefined);
  assert.equal(created.json.demoLink, undefined);

  const row = await w.db.q1('SELECT * FROM demo_requests WHERE email = ?', [REQUEST_BODY.email.toLowerCase()]);
  assert.equal(row.status, 'pending');
  assert.equal(row.approved_at, null);
  assert.equal(row.owner_name, 'Kirthi');
  assert.equal(row.gym_name, 'BeFitter');

  const sessions = await w.db.q('SELECT * FROM demo_sessions');
  assert.equal(sessions.length, 0, 'submitting creates no session and therefore no way in');
});

test('pending -> approve -> approved, with a one-time link and an audit record', async (t) => {
  const w = await world();
  t.after(w.close);
  const { requestId, token, link } = await approvedToken(w.api, w.founder);

  assert.ok(token.length >= 40, 'the access token is long and random, not a database id');
  assert.ok(!link.includes(requestId), 'the link never exposes a database id');
  assert.ok(link.endsWith(`/demo/${token}`));

  const row = await w.db.q1('SELECT * FROM demo_requests WHERE id = ?', [requestId]);
  assert.equal(row.status, 'approved');
  assert.equal(row.reviewed_by, w.founder.userId, 'approval records who approved it');
  assert.ok(row.approved_at);

  const session = await w.db.q1('SELECT * FROM demo_sessions WHERE demo_request_id = ?', [requestId]);
  assert.equal(session.status, 'approved');
  assert.equal(session.started_at, null, 'approving does NOT start the clock');
  assert.equal(session.expires_at, null);
  // The raw token must not be recoverable from the database.
  assert.equal(session.access_token_hash, hashToken(token));
  assert.ok(!JSON.stringify(session).includes(token), 'no column stores the raw token');

  const audit = await w.db.q1(`SELECT * FROM admin_audit_logs WHERE action = 'demo_approved'`);
  assert.ok(audit, 'approval is audited');
  assert.equal(audit.admin_id, w.founder.userId);
  assert.ok(!String(audit.after_json).includes(token), 'the audit trail never stores the token');
});

test('pending -> reject -> rejected, and a rejected request cannot then be approved', async (t) => {
  const w = await world();
  t.after(w.close);
  await w.api.call('POST', '/api/demo/request', REQUEST_BODY);
  const list = await w.api.call('GET', '/api/console/demos', undefined, w.founder.token);
  const requestId = list.json.demos[0].id;

  const rejected = await w.api.call('POST', `/api/console/demos/${requestId}/reject`, { reason: 'Not a gym.' }, w.founder.token);
  assert.equal(rejected.status, 200);
  const row = await w.db.q1('SELECT * FROM demo_requests WHERE id = ?', [requestId]);
  assert.equal(row.status, 'rejected');
  assert.equal(row.reject_reason, 'Not a gym.');
  assert.ok(row.rejected_at);

  const approveAfter = await w.api.call('POST', `/api/console/demos/${requestId}/approve`, {}, w.founder.token);
  assert.equal(approveAfter.status, 409, 'a rejected request cannot be approved behind the founder\'s back');
  assert.equal((await w.db.q('SELECT * FROM demo_sessions')).length, 0);
});

test('active -> revoke -> revoked, and the prospect is locked out on their very next request', async (t) => {
  const w = await world();
  t.after(w.close);
  const { requestId, token } = await approvedToken(w.api, w.founder);

  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const demoToken = started.json.token;

  const before = await w.api.call('GET', '/api/admin/overview', undefined, demoToken);
  assert.equal(before.status, 200, 'the demo can use the real product');

  const revoked = await w.api.call('POST', `/api/console/demos/${requestId}/revoke`, { reason: 'Done.' }, w.founder.token);
  assert.equal(revoked.status, 200);

  const after = await w.api.call('GET', '/api/admin/overview', undefined, demoToken);
  assert.equal(after.status, 401, 'revocation takes effect immediately, not on a cache TTL');
  assert.equal(after.json.error, 'demo_session_ended');
  assert.equal(after.json.reason, 'revoked');
  assert.match(after.json.message, /revoked by the administrator/i);

  const session = await w.db.q1('SELECT * FROM demo_sessions WHERE demo_request_id = ?', [requestId]);
  assert.equal(session.status, 'revoked');
  assert.ok(session.revoked_at);
});

test('approving is refused when the demo tenant has not been seeded', async (t) => {
  const w = await world({ seedTenant: false });
  t.after(w.close);
  await w.api.call('POST', '/api/demo/request', REQUEST_BODY);
  const list = await w.api.call('GET', '/api/console/demos', undefined, w.founder.token);
  const res = await w.api.call('POST', `/api/console/demos/${list.json.demos[0].id}/approve`, {}, w.founder.token);
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'demo_tenant_missing');
});

// ============================================================
// THE TIMER
// ============================================================
test('the clock starts on Start -- not on request, approval, link generation, or opening the link', async (t) => {
  const w = await world();
  t.after(w.close);
  const { token } = await approvedToken(w.api, w.founder);

  // Opening the pre-demo screen must not start anything.
  const pre = await w.api.call('GET', `/api/demo/access/${token}`);
  assert.equal(pre.status, 200);
  assert.equal(pre.json.state, 'approved');
  assert.equal(pre.json.startedAt, null);
  assert.equal(pre.json.expiresAt, null);
  assert.equal(pre.json.ownerName, 'Kirthi', 'the welcome screen greets them by their own name');
  assert.equal(pre.json.gymName, 'BeFitter');
  assert.equal(pre.json.durationMinutes, DEMO_DURATION_MINUTES);

  const stillUnstarted = await w.db.q1('SELECT started_at FROM demo_sessions LIMIT 1');
  assert.equal(stillUnstarted.started_at, null);

  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  assert.equal(started.status, 200);
  const row = await w.db.q1('SELECT * FROM demo_sessions LIMIT 1');
  assert.equal(row.status, 'active');
  assert.ok(row.started_at && row.expires_at);
  const span = Date.parse(row.expires_at) - Date.parse(row.started_at);
  assert.equal(span, DEMO_DURATION_MINUTES * 60_000, 'exactly 30 minutes');
});

test('expiry boundaries: 29:59 active, 00:01 active, 00:00 expired', async () => {
  const startedAt = '2026-09-16T10:00:00.000Z';
  const session = {
    id: 'dms_x', status: 'active', started_at: startedAt,
    expires_at: expiryFor(startedAt, 30), duration_minutes: 30,
  };
  const at = (mins, secs = 0) => Date.parse(startedAt) + mins * 60_000 + secs * 1000;

  assert.equal(evaluateSession(session, at(0)).ok, true, 'the instant it starts');
  assert.equal(evaluateSession(session, at(0, 1)).ok, true, '00:01 elapsed');
  assert.equal(evaluateSession(session, at(29, 59)).ok, true, '29:59 -- one second left');
  assert.equal(evaluateSession(session, at(29, 59)).remainingMs, 1000);
  assert.equal(evaluateSession(session, at(29, 59, 999)).ok, true);
  // The exact moment of expiry is already over -- 00:00 means finished,
  // not one last millisecond of grace.
  const atZero = evaluateSession(session, at(30));
  assert.equal(atZero.ok, false, '00:00 -- expired');
  assert.equal(atZero.reason, 'expired');
  assert.equal(atZero.remainingMs, 0);
  assert.equal(evaluateSession(session, at(30, 1)).ok, false, 'and after');
  assert.equal(evaluateSession(session, at(45)).reason, 'expired');
});

test('a corrupt or missing expiry is treated as over, never as unlimited', async () => {
  const base = { id: 'x', status: 'active', started_at: '2026-09-16T10:00:00.000Z', duration_minutes: 30 };
  assert.equal(evaluateSession({ ...base, expires_at: 'not-a-date' }).reason, 'expired');
  assert.equal(evaluateSession({ ...base, expires_at: null }).reason, 'not_started');
  assert.equal(evaluateSession(null).reason, 'not_found');
  assert.equal(evaluateSession({ ...base, status: 'revoked', expires_at: expiryFor(base.started_at) }).reason, 'revoked');
});

// ============================================================
// REFRESH / MULTIPLE TABS -- the timer cannot be reset by the client
// ============================================================
test('refreshing does not reset the timer, and a second Start does not buy more time', async (t) => {
  const w = await world();
  t.after(w.close);
  const { token } = await approvedToken(w.api, w.founder);

  const first = await w.api.call('POST', `/api/demo/access/${token}/start`);
  assert.equal(first.status, 200);
  const originalExpiry = first.json.session.expiresAt;

  // A refresh re-reads the pre-demo endpoint, which must now report an
  // ALREADY-RUNNING session with the original deadline.
  const reopened = await w.api.call('GET', `/api/demo/access/${token}`);
  assert.equal(reopened.json.state, 'active');
  assert.equal(reopened.json.expiresAt, originalExpiry);

  // And clicking Start again (a second tab, a double click, a
  // deliberately replayed request) must not move it.
  const second = await w.api.call('POST', `/api/demo/access/${token}/start`);
  assert.equal(second.status, 200);
  assert.equal(second.json.session.expiresAt, originalExpiry, 'the deadline is unchanged');

  const rows = await w.db.q('SELECT * FROM demo_sessions');
  assert.equal(rows.length, 1, 'no second session was created');
  assert.equal(rows[0].expires_at, originalExpiry);
});

test('two tabs share one server-side expiry', async (t) => {
  const w = await world();
  t.after(w.close);
  const { token } = await approvedToken(w.api, w.founder);

  const tabA = await w.api.call('POST', `/api/demo/access/${token}/start`);
  const tabB = await w.api.call('POST', `/api/demo/access/${token}/start`);
  assert.equal(tabA.json.session.expiresAt, tabB.json.session.expiresAt);

  const sessionA = await w.api.call('GET', '/api/demo/session', undefined, tabA.json.token);
  const sessionB = await w.api.call('GET', '/api/demo/session', undefined, tabB.json.token);
  assert.equal(sessionA.json.expiresAt, sessionB.json.expiresAt);

  // Expiring it affects both, because there is only one row.
  await w.db.run(`UPDATE demo_sessions SET expires_at = ? WHERE id = ?`,
    [new Date(Date.now() - 1000).toISOString(), (await w.db.q1('SELECT id FROM demo_sessions')).id]);
  for (const [label, tok] of [['A', tabA.json.token], ['B', tabB.json.token]]) {
    const res = await w.api.call('GET', '/api/admin/overview', undefined, tok);
    assert.equal(res.status, 401, `tab ${label} is expired too`);
  }
});

test('concurrent Start requests cannot race the clock into starting twice', async (t) => {
  const w = await world();
  t.after(w.close);
  const { token } = await approvedToken(w.api, w.founder);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => w.api.call('POST', `/api/demo/access/${token}/start`)));
  const expiries = new Set(results.map((r) => r.json.session.expiresAt));
  assert.equal(expiries.size, 1, 'every concurrent Start agrees on one deadline');
  assert.equal((await w.db.q('SELECT * FROM demo_sessions')).length, 1);
});

// ============================================================
// EXPIRATION
// ============================================================
test('an expired session is rejected by the real product API and marked expired in the database', async (t) => {
  const w = await world();
  t.after(w.close);
  const { requestId, token } = await approvedToken(w.api, w.founder);
  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  const demoToken = started.json.token;

  assert.equal((await w.api.call('GET', '/api/admin/overview', undefined, demoToken)).status, 200);

  // Move the deadline into the past -- the same thing 30 minutes of real
  // time would do, without the wait.
  const sessionId = (await w.db.q1('SELECT id FROM demo_sessions')).id;
  await w.db.run('UPDATE demo_sessions SET expires_at = ? WHERE id = ?',
    [new Date(Date.now() - 60_000).toISOString(), sessionId]);

  const res = await w.api.call('GET', '/api/admin/overview', undefined, demoToken);
  assert.equal(res.status, 401, 'a protected product route rejects the expired session');
  assert.equal(res.json.error, 'demo_session_ended');
  assert.equal(res.json.reason, 'expired');

  // The first request to notice persists the verdict, so it is expired
  // for every other tab, device and future request -- not just this one.
  const row = await w.db.q1('SELECT * FROM demo_sessions WHERE id = ?', [sessionId]);
  assert.equal(row.status, 'expired');
  const request = await w.db.q1('SELECT status FROM demo_requests WHERE id = ?', [requestId]);
  assert.equal(request.status, 'expired', 'the founder list reflects it too');

  // And the expiry screen can say what happened, with the prospect's own name.
  const ended = await w.api.call('GET', `/api/demo/ended/${token}`);
  assert.equal(ended.status, 200);
  assert.equal(ended.json.state, 'expired');
  assert.equal(ended.json.ownerName, 'Kirthi');
  assert.equal(ended.json.gymName, 'BeFitter');
});

test('an expired demo cannot restart itself -- only a founder can grant another', async (t) => {
  const w = await world();
  t.after(w.close);
  const { requestId, token } = await approvedToken(w.api, w.founder);
  await w.api.call('POST', `/api/demo/access/${token}/start`);
  await w.db.run('UPDATE demo_sessions SET status = ?, expires_at = ?',
    ['expired', new Date(Date.now() - 60_000).toISOString()]);

  const restartAttempt = await w.api.call('POST', `/api/demo/access/${token}/start`);
  assert.equal(restartAttempt.status, 410, 'clicking Start again gets nothing');
  assert.equal(restartAttempt.json.error, 'demo_session_ended');

  // The founder, and only the founder, can grant a second one.
  const reissued = await w.api.call('POST', `/api/console/demos/${requestId}/reissue`, {}, w.founder.token);
  assert.equal(reissued.status, 200);
  assert.equal(reissued.json.restarted, true);
  assert.notEqual(reissued.json.accessToken, token, 'a new token, not the old one');

  const fresh = await w.api.call('POST', `/api/demo/access/${reissued.json.accessToken}/start`);
  assert.equal(fresh.status, 200, 'the new link works');
  assert.equal((await w.db.q('SELECT * FROM demo_sessions')).length, 2, 'the old session stays on the record');
});

test('re-issuing an unstarted link rotates the token so the old link stops working', async (t) => {
  const w = await world();
  t.after(w.close);
  const { requestId, token } = await approvedToken(w.api, w.founder);
  const reissued = await w.api.call('POST', `/api/console/demos/${requestId}/reissue`, {}, w.founder.token);
  assert.equal(reissued.status, 200);
  assert.equal(reissued.json.restarted, false, 'the same session, a new link');
  assert.equal((await w.db.q('SELECT * FROM demo_sessions')).length, 1);
  assert.equal((await w.api.call('GET', `/api/demo/access/${token}`)).status, 404, 'the leaked link is dead');
  assert.equal((await w.api.call('GET', `/api/demo/access/${reissued.json.accessToken}`)).status, 200);
});

// ============================================================
// SECURITY
// ============================================================
test('a demo client cannot change its own expiry, tenant, role or session', async (t) => {
  const w = await world();
  t.after(w.close);
  const { token } = await approvedToken(w.api, w.founder);
  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  const demoToken = started.json.token;
  const originalExpiry = started.json.session.expiresAt;

  // Every client-supplied value the spec names, offered to the routes
  // that could plausibly honour one.
  const forged = {
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    durationMinutes: 6000, duration_minutes: 6000,
    org: 'org_somewhere_else', orgId: 'org_somewhere_else', tenantId: 'org_somewhere_else',
    demo_org_id: 'org_somewhere_else',
    role: 'SUPER_ADMIN', is_demo: false, isDemo: false,
  };
  await w.api.call('POST', `/api/demo/access/${token}/start`, forged);
  await w.api.call('POST', '/api/demo/switch-role', { ...forged, persona: 'OWNER' }, demoToken);
  await w.api.call('POST', '/api/demo/event', { ...forged, type: 'dashboard_viewed' }, demoToken);

  const row = await w.db.q1('SELECT * FROM demo_sessions');
  assert.equal(row.expires_at, originalExpiry, 'expiry is unchanged');
  assert.equal(Number(row.duration_minutes), DEMO_DURATION_MINUTES, 'duration is unchanged');
  assert.equal(row.demo_org_id, w.demoOrgId, 'tenant is unchanged');

  // Role: a switch to the owner persona still yields GYM_OWNER, never
  // the SUPER_ADMIN that was asked for.
  const switched = await w.api.call('POST', '/api/demo/switch-role', { persona: 'OWNER', role: 'SUPER_ADMIN' }, demoToken);
  assert.equal(switched.status, 200);
  assert.equal(switched.json.user.role, 'GYM_OWNER');

  // And a demo token, whatever it claims, cannot reach the founder console.
  const console1 = await w.api.call('GET', '/api/console/demos', undefined, switched.json.token);
  assert.equal(console1.status, 403, 'a demo can never become a founder');
  const console2 = await w.api.call('GET', '/api/console/dashboard', undefined, switched.json.token);
  assert.equal(console2.status, 403);
});

test('role switching only ever lands on the three seeded demo identities, inside the demo tenant', async (t) => {
  const w = await world();
  t.after(w.close);
  const { token } = await approvedToken(w.api, w.founder);
  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  let current = started.json.token;
  assert.equal(started.json.user.role, 'GYM_OWNER');
  assert.equal(started.json.user.email, DEMO_PERSONAS.OWNER.email);

  for (const [persona, role, email] of [
    ['TRAINER', 'TRAINER', DEMO_PERSONAS.TRAINER.email],
    ['MEMBER', 'CLIENT', DEMO_PERSONAS.MEMBER.email],
    ['OWNER', 'GYM_OWNER', DEMO_PERSONAS.OWNER.email],
  ]) {
    const res = await w.api.call('POST', '/api/demo/switch-role', { persona }, current);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.user.role, role);
    assert.equal(res.json.user.email, email);
    assert.equal(res.json.user.orgId, w.demoOrgId, 'always inside the demo tenant');
    assert.equal(res.json.session.expiresAt, started.json.session.expiresAt, 'switching does not extend the demo');
    current = res.json.token;
  }

  const bogus = await w.api.call('POST', '/api/demo/switch-role', { persona: 'FOUNDER' }, current);
  assert.equal(bogus.status, 422, 'there is no persona to escalate into');
});

test('one demo cannot see, use, or end another demo', async (t) => {
  const w = await world();
  t.after(w.close);
  const a = await approvedToken(w.api, w.founder, { ...REQUEST_BODY, email: 'a@gyma.example', gymName: 'Gym A', ownerName: 'Asha' });
  const b = await approvedToken(w.api, w.founder, { ...REQUEST_BODY, email: 'b@gymb.example', gymName: 'Gym B', ownerName: 'Bala' });

  const startedA = await w.api.call('POST', `/api/demo/access/${a.token}/start`);
  const startedB = await w.api.call('POST', `/api/demo/access/${b.token}/start`);
  assert.notEqual(startedA.json.token, startedB.json.token);

  // Ending A must leave B untouched.
  await w.api.call('POST', '/api/demo/finish', {}, startedA.json.token);
  assert.equal((await w.api.call('GET', '/api/demo/session', undefined, startedA.json.token)).status, 401);
  assert.equal((await w.api.call('GET', '/api/demo/session', undefined, startedB.json.token)).status, 200);

  // A's telemetry is filed against A's session only.
  const sessionA = await w.db.q1('SELECT * FROM demo_sessions WHERE demo_request_id = ?', [a.requestId]);
  const sessionB = await w.db.q1('SELECT * FROM demo_sessions WHERE demo_request_id = ?', [b.requestId]);
  assert.notEqual(sessionA.id, sessionB.id);
  assert.equal(sessionA.status, 'completed');
  assert.equal(sessionB.status, 'active');
  const eventsB = await w.db.q('SELECT * FROM demo_events WHERE session_id = ?', [sessionB.id]);
  assert.ok(eventsB.every((e) => e.session_id === sessionB.id));
});

test('a demo cannot read a real gym, and a real gym cannot read the demo', async (t) => {
  const w = await world();
  t.after(w.close);
  const owner = await createGymOwner(w.api, 'owner@production.test', 'Production Gym');
  // Give the real gym one member, so "did the demo see it" has something
  // to actually be true or false about.
  const realUserId = id('usr');
  const realClientId = id('cli');
  await w.db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?, ?, 'realmember@production.test', 'x', 'CLIENT', 'Real Member', 1, ?)`,
    [realUserId, owner.orgId, now()]);
  await w.db.run(`INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, 'FAT_LOSS', ?)`,
    [realClientId, realUserId, owner.orgId, owner.userId, now()]);

  const { token } = await approvedToken(w.api, w.founder);
  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  const demoToken = started.json.token;

  const members = await w.api.call('GET', '/api/admin/members', undefined, demoToken);
  assert.equal(members.status, 200);
  const body = JSON.stringify(members.json);
  assert.ok(!body.includes('Real Member'), 'the demo never sees a production member');
  assert.ok(!body.includes(realClientId));
  assert.ok(body.includes('Aarav Sharma'), 'it sees its own seeded roster instead');

  // ...and the real gym's owner sees only their own gym.
  const realView = await w.api.call('GET', '/api/admin/members', undefined, owner.token);
  assert.equal(realView.status, 200);
  const realBody = JSON.stringify(realView.json);
  assert.ok(realBody.includes('Real Member'));
  assert.ok(!realBody.includes('Aarav Sharma'), 'a real gym never sees demo data');
});

test('a demo identity cannot be signed into with a password', async (t) => {
  const w = await world();
  t.after(w.close);
  // Every password anyone could plausibly try against a seeded account.
  // resetRateLimits() between attempts because /auth/login's own
  // brute-force lockout would otherwise start answering 429 partway
  // through -- correct product behaviour, but it would stop this test
  // proving what it is here to prove, which is that the CREDENTIALS are
  // rejected rather than the requests being throttled.
  for (const password of ['demo', 'password', 'BeFitter', 'kirthi', 'demo1234', 'Demo@2026']) {
    resetRateLimits();
    const res = await w.api.call('POST', '/api/auth/login', { email: DEMO_PERSONAS.OWNER.email, password });
    assert.equal(res.status, 401, `"${password}" must not authenticate a demo account`);
  }
  resetRateLimits();
  const member = await w.api.call('POST', '/api/auth/login', { email: DEMO_PERSONAS.MEMBER.email, password: 'demo1234' });
  assert.equal(member.status, 401);
});

test('a token naming the demo tenant without a live demo session is refused', async (t) => {
  const w = await world();
  t.after(w.close);
  const { token } = await approvedToken(w.api, w.founder);
  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  const demoToken = started.json.token;
  assert.equal((await w.api.call('GET', '/api/admin/overview', undefined, demoToken)).status, 200);

  // Delete the session row out from under the token. The JWT is still
  // perfectly valid and still names the demo org -- and must still be
  // refused, because the tenant is reachable ONLY through a live session.
  await w.db.run('DELETE FROM demo_sessions');
  invalidateOrgDemoCache();
  const res = await w.api.call('GET', '/api/admin/overview', undefined, demoToken);
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'demo_session_ended');
});

test('an unknown or malformed demo link is refused without leaking anything', async (t) => {
  const w = await world();
  t.after(w.close);
  for (const bad of [newAccessToken(), 'short', '../../etc/passwd', 'a'.repeat(300), "' OR 1=1 --"]) {
    const res = await w.api.call('GET', `/api/demo/access/${encodeURIComponent(bad)}`);
    assert.equal(res.status, 404, `"${bad.slice(0, 20)}" is not a valid link`);
    assert.equal(res.json.error, 'invalid_link');
    assert.equal(res.json.ownerName, undefined);
  }
});

// ============================================================
// THE DEMO TENANT AND ITS DATA
// ============================================================
test('the seeded tenant is a real, fully-populated gym', async (t) => {
  const w = await world();
  t.after(w.close);
  const org = await w.db.q1('SELECT * FROM organizations WHERE slug = ?', [DEMO_ORG_SLUG]);
  assert.equal(org.name, 'BeFitter');
  assert.equal(Number(org.is_demo), 1);

  const counts = {};
  for (const [label, sql, params] of [
    ['members', 'SELECT COUNT(*) AS n FROM clients WHERE org_id = ?', [org.id]],
    ['trainers', 'SELECT COUNT(*) AS n FROM trainers WHERE org_id = ?', [org.id]],
    ['programs', 'SELECT COUNT(*) AS n FROM workout_templates WHERE org_id = ?', [org.id]],
    ['nutritionPlans', 'SELECT COUNT(*) AS n FROM nutrition_plans WHERE org_id = ?', [org.id]],
    ['attendance', 'SELECT COUNT(*) AS n FROM attendance WHERE org_id = ?', [org.id]],
    ['payments', 'SELECT COUNT(*) AS n FROM payments WHERE org_id = ?', [org.id]],
    ['communityShares', 'SELECT COUNT(*) AS n FROM community_workout_shares WHERE org_id = ?', [org.id]],
    ['challenges', 'SELECT COUNT(*) AS n FROM community_challenges WHERE org_id = ?', [org.id]],
    ['workoutLogs', 'SELECT COUNT(*) AS n FROM workout_logs WHERE client_id IN (SELECT id FROM clients WHERE org_id = ?)', [org.id]],
    ['personalRecords', 'SELECT COUNT(*) AS n FROM personal_records WHERE client_id IN (SELECT id FROM clients WHERE org_id = ?)', [org.id]],
    ['weightLogs', 'SELECT COUNT(*) AS n FROM weight_logs WHERE client_id IN (SELECT id FROM clients WHERE org_id = ?)', [org.id]],
  ]) counts[label] = Number((await w.db.q1(sql, params)).n);

  assert.ok(counts.members >= 50 && counts.members <= 100, `50-100 members, got ${counts.members}`);
  assert.equal(counts.trainers, 4);
  assert.ok(counts.programs >= 8, 'a catalogue of workout programs');
  assert.ok(counts.nutritionPlans >= 5, 'nutrition plans exist');
  assert.ok(counts.attendance > 500, 'attendance history exists');
  assert.ok(counts.payments > 50, 'payment history exists');
  assert.ok(counts.communityShares > 10, 'the community feed is populated');
  assert.ok(counts.challenges >= 4, 'leaderboard challenges exist');
  assert.ok(counts.workoutLogs > 500, 'training history exists');
  assert.ok(counts.personalRecords > 50, 'personal records exist');
  assert.ok(counts.weightLogs > 200, 'progress data exists');

  // No placeholder content anywhere in the roster.
  const names = (await w.db.q('SELECT u.name FROM users u WHERE u.org_id = ?', [org.id])).map((r) => r.name);
  for (const forbidden of [/^Member \d+$/i, /test\s*user/i, /lorem/i, /^user\d*$/i, /placeholder/i, /^abc/i]) {
    assert.ok(!names.some((n) => forbidden.test(n)), `no placeholder names (${forbidden})`);
  }
  assert.ok(names.includes('Kirthi'), 'the owner is Kirthi');
  assert.ok(names.includes('Aarav Sharma'));
  assert.ok(names.includes('Arjun Deshpande'));
});

test('the owner dashboard reports real, internally consistent numbers', async (t) => {
  const w = await world();
  t.after(w.close);
  const { token } = await approvedToken(w.api, w.founder);
  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  const overview = await w.api.call('GET', '/api/admin/overview', undefined, started.json.token);
  assert.equal(overview.status, 200, JSON.stringify(overview.json));

  const memberCount = Number((await w.db.q1('SELECT COUNT(*) AS n FROM clients WHERE org_id = ?', [w.demoOrgId])).n);
  const body = JSON.stringify(overview.json);
  assert.ok(body.length > 200, 'the dashboard is not empty');
  // Whatever shape the overview takes, the member total it reports must
  // be the real row count -- not a number written into a fixture.
  const totals = JSON.parse(body);
  const foundMemberCount = JSON.stringify(totals).includes(String(memberCount));
  assert.ok(foundMemberCount, `the dashboard reflects the ${memberCount} real member rows`);
});

test('the demo tenant is kept out of real-customer platform aggregates', async (t) => {
  const w = await world();
  t.after(w.close);
  const before = await w.api.call('GET', '/api/console/dashboard', undefined, w.founder.token);
  assert.equal(before.status, 200);
  // The tenant is seeded with 87 clients and 4 trainers; none of them is
  // a customer, and none may appear in the platform's own health numbers.
  assert.equal(before.json.totalClients, 0, 'demo members are not counted as customers');
  assert.equal(before.json.totalTrainers, 0);
  assert.equal(before.json.totalGyms, 0, 'the demo gym is not counted as a customer gym');

  const owner = await createGymOwner(w.api, 'owner@countsforreal.test', 'Counts For Real');
  assert.ok(owner.orgId);
  const after = await w.api.call('GET', '/api/console/dashboard', undefined, w.founder.token);
  assert.equal(after.json.totalGyms, 1, 'a real gym does count');

  // But the founder can still SEE the demo gym in the gym list, labelled.
  const gyms = await w.api.call('GET', '/api/console/gyms', undefined, w.founder.token);
  const demoGym = gyms.json.gyms.find((g) => g.slug === DEMO_ORG_SLUG);
  assert.ok(demoGym, 'the founder can see the demo tenant');
  assert.equal(demoGym.is_demo, true, 'and it is labelled as one');
});

test('reset restores the canonical seed, refuses to run during a live demo, and refuses non-demo orgs', async (t) => {
  const w = await world();
  t.after(w.close);

  // A prospect changes the demo data, the way the spec expects them to.
  await w.db.run('DELETE FROM clients WHERE org_id = ? AND id IN (SELECT id FROM clients WHERE org_id = ? LIMIT 10)',
    [w.demoOrgId, w.demoOrgId]);
  const reduced = Number((await w.db.q1('SELECT COUNT(*) AS n FROM clients WHERE org_id = ?', [w.demoOrgId])).n);
  assert.equal(reduced, 77);

  const reset = await w.api.call('POST', '/api/console/demos/tenant/reset', {}, w.founder.token);
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.equal(reset.json.orgId, w.demoOrgId, 'the org row survives, so demo history is not destroyed');
  assert.equal(Number((await w.db.q1('SELECT COUNT(*) AS n FROM clients WHERE org_id = ?', [w.demoOrgId])).n), 87);

  const audit = await w.db.q1(`SELECT * FROM admin_audit_logs WHERE action = 'demo_tenant_reset'`);
  assert.ok(audit, 'resets are audited');

  // Now with a demo actually running, it must refuse.
  const { token } = await approvedToken(w.api, w.founder);
  await w.api.call('POST', `/api/demo/access/${token}/start`);
  const blocked = await w.api.call('POST', '/api/console/demos/tenant/reset', {}, w.founder.token);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'demo_in_progress');

  // And the seeder itself refuses to delete from an org that is not a demo.
  const { resetDemoTenant } = await import('../src/services/demo/seed.js');
  const realOrgId = id('org');
  await w.db.run('INSERT INTO organizations (id, name, slug, type, is_demo, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [realOrgId, 'A Real Gym', 'a-real-gym', 'gym', now()]);
  await assert.rejects(() => resetDemoTenant(w.db, realOrgId), /refusing_to_reset_a_non_demo_org/);
});

// ============================================================
// FOUNDER ANALYTICS
// ============================================================
test('the founder sees what the prospect actually did', async (t) => {
  const w = await world();
  t.after(w.close);
  const { requestId, token } = await approvedToken(w.api, w.founder);
  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  let current = started.json.token;

  // Dashboard is fired three times so the ranking assertion below is
  // testing an actual ordering rather than an arbitrary tie-break.
  for (const type of ['dashboard_viewed', 'dashboard_viewed', 'dashboard_viewed',
    'members_viewed', 'workout_viewed', 'community_viewed', 'leaderboard_viewed']) {
    assert.equal((await w.api.call('POST', '/api/demo/event', { type }, current)).status, 200);
  }
  // An invented event name is dropped rather than stored.
  const junk = await w.api.call('POST', '/api/demo/event', { type: 'totally_made_up' }, current);
  assert.equal(junk.status, 200);
  assert.equal(junk.json.ignored, true);

  current = (await w.api.call('POST', '/api/demo/switch-role', { persona: 'MEMBER' }, current)).json.token;
  current = (await w.api.call('POST', '/api/demo/switch-role', { persona: 'TRAINER' }, current)).json.token;

  const detail = await w.api.call('GET', `/api/console/demos/${requestId}`, undefined, w.founder.token);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.ownerName, 'Kirthi');
  assert.equal(detail.json.session.state, 'active');
  assert.ok(detail.json.session.startedAt && detail.json.session.expiresAt);
  assert.ok(detail.json.session.usedMs >= 0);
  assert.equal(detail.json.memberViewUsed, true);
  assert.equal(detail.json.trainerViewUsed, true);
  for (const feature of ['Dashboard', 'Members', 'Workouts', 'Community', 'Leaderboard']) {
    assert.ok(detail.json.featuresVisited.includes(feature), `${feature} shows as visited`);
  }
  assert.ok(!detail.json.featuresVisited.includes('totally_made_up'));
  assert.ok(!JSON.stringify(detail.json).includes(token), 'the detail view never exposes the access token');

  const overview = await w.api.call('GET', '/api/console/demos/overview', undefined, w.founder.token);
  assert.equal(overview.status, 200);
  assert.equal(overview.json.totalRequests, 1);
  assert.equal(overview.json.activeNow, 1);
  assert.equal(overview.json.tenant.exists, true);
  assert.equal(overview.json.tenant.memberCount, 87);
  assert.equal(overview.json.featureRanking[0].label, 'Dashboard', 'the most-viewed feature ranks first');
  assert.equal(overview.json.featureRanking[0].views, 3);
});

test('the expiry screen CTA is recorded even though the session is already over', async (t) => {
  const w = await world();
  t.after(w.close);
  const { requestId, token } = await approvedToken(w.api, w.founder);
  await w.api.call('POST', `/api/demo/access/${token}/start`);
  await w.db.run('UPDATE demo_sessions SET status = ?, expires_at = ?', ['expired', new Date(Date.now() - 1000).toISOString()]);

  const cta = await w.api.call('POST', `/api/demo/access/${token}/event`, { type: 'cta_clicked', data: { cta: 'book_setup_call' } });
  assert.equal(cta.status, 200);
  const detail = await w.api.call('GET', `/api/console/demos/${requestId}`, undefined, w.founder.token);
  assert.ok(detail.json.events.some((e) => e.type === 'cta_clicked' && e.data?.cta === 'book_setup_call'));

  // ...but that public endpoint accepts nothing else.
  const abuse = await w.api.call('POST', `/api/demo/access/${token}/event`, { type: 'demo_started' });
  assert.equal(abuse.status, 422, 'the unauthenticated event route accepts only the CTA');
});

// ============================================================
// MIGRATION SAFETY
// ============================================================
// The demo system adds one column to an EXISTING table
// (organizations.is_demo, via init-db.js's guarded migrations). Between a
// deploy and that migration running, the live code meets a database that
// does not have it -- and the first version of requireAuth's demo gate
// treated the resulting SQL error as "this IS a demo org", which answered
// 401 to every authenticated request from every real customer. The whole
// product, down, for the length of the migration window.
//
// These tests pin the behaviour that stops that recurring, by building a
// database deliberately WITHOUT the column.
async function unmigratedDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // Deliberately NOT adding is_demo -- that is the whole point.
  db.exec(`ALTER TABLE subscriptions ADD COLUMN lifecycle_status TEXT CHECK (lifecycle_status IN ('PENDING_PAYMENT','ACTIVE','PAUSED','SUSPENDED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED','TRANSFERRED'))`);
  db.exec('ALTER TABLE users ADD COLUMN branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL');
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    raw: db,
  });
  return mk();
}

test('an ordinary customer is unaffected when the is_demo migration has not run yet', async (t) => {
  resetRateLimits();
  invalidateOrgDemoCache();
  invalidateOrgBillingCache();
  const db = await unmigratedDb();
  const api = await startApp(db);
  t.after(api.close);

  // Proving the premise first: referencing the column really is an error
  // here, not an empty result. Without this the test could pass for the
  // wrong reason if the column were ever added to schema.sql.
  await assert.rejects(() => db.q('SELECT is_demo FROM organizations'), /is_demo/);

  const owner = await createGymOwner(api, 'owner@unmigrated.test', 'Unmigrated Gym');
  const overview = await api.call('GET', '/api/admin/overview', undefined, owner.token);
  assert.equal(overview.status, 200, 'a real gym owner can still use the product');

  const me = await api.call('GET', '/api/auth/me', undefined, owner.token);
  assert.equal(me.status, 200);
  assert.equal(me.json.demo, undefined, 'and is not treated as a demo session');
});

test('the founder console degrades gracefully before the migration, instead of 500ing', async (t) => {
  resetRateLimits();
  invalidateOrgDemoCache();
  invalidateOrgBillingCache();
  const db = await unmigratedDb();
  const api = await startApp(db);
  t.after(api.close);
  const founder = await createFounder(db, api);
  await createGymOwner(api, 'owner@realgym2.test', 'Real Gym Two');

  const dashboard = await api.call('GET', '/api/console/dashboard', undefined, founder.token);
  assert.equal(dashboard.status, 200, 'the platform dashboard still renders');
  assert.equal(dashboard.json.totalGyms, 1, 'and counts the real gym');

  const gyms = await api.call('GET', '/api/console/gyms', undefined, founder.token);
  assert.equal(gyms.status, 200);
  assert.equal(gyms.json.gyms.length, 1);
  assert.equal(gyms.json.gyms[0].is_demo, false, 'nothing is labelled a demo, because nothing can be one');

  const demos = await api.call('GET', '/api/console/demos/overview', undefined, founder.token);
  assert.equal(demos.status, 200, 'Demo Management opens');
  assert.equal(demos.json.tenant.exists, false, 'and says the tenant has not been created');

  // And approving is refused with the actionable message rather than a crash.
  await api.call('POST', '/api/demo/request', REQUEST_BODY);
  const list = await api.call('GET', '/api/console/demos', undefined, founder.token);
  const approve = await api.call('POST', `/api/console/demos/${list.json.demos[0].id}/approve`, {}, founder.token);
  assert.equal(approve.status, 409);
  assert.equal(approve.json.error, 'demo_tenant_missing');
  assert.match(approve.json.message, /seed:demo/);
});

test('a demo tenant can explore billing but can never reach the real payment gateway', async (t) => {
  const w = await world();
  t.after(w.close);

  // Reading billing is part of the product an owner is evaluating, and
  // stays fully open: packages, prices, member payment history, invoices.
  const { token } = await approvedToken(w.api, w.founder);
  const started = await w.api.call('POST', `/api/demo/access/${token}/start`);
  const demoToken = started.json.token;
  const packages = await w.api.call('GET', '/api/admin/packages', undefined, demoToken);
  assert.equal(packages.status, 200, 'the demo owner can see their membership plans');
  assert.ok(packages.json.packages.length >= 3);

  // MOVING money is where it stops. Guarded at the service every payment
  // path funnels through, so this holds for routes that do not exist yet.
  const { createPaymentOrder } = await import('../src/services/payments/paymentOrders.js');
  await assert.rejects(
    () => createPaymentOrder(w.db, {
      subjectType: 'ORG_PACKAGE', subjectId: 'skp_x', orgId: w.demoOrgId, amount: 24000,
    }),
    (e) => e.code === 'demo_payment_blocked',
    'a demo tenant cannot create a payment order');
  assert.equal((await w.db.q('SELECT * FROM payment_orders')).length, 0, 'and none was written');

  const { initiateRefund } = await import('../src/services/payments/refunds.js');
  await assert.rejects(
    () => initiateRefund(w.db, { orderId: 'pord_x', orgId: w.demoOrgId, amount: 100 }),
    (e) => e.code === 'demo_payment_blocked',
    'nor issue a refund');

  // A REAL gym is completely unaffected by the guard.
  const owner = await createGymOwner(w.api, 'owner@paying.test', 'Paying Gym');
  const realOrder = await createPaymentOrder(w.db, {
    subjectType: 'ORG_PACKAGE', subjectId: 'skp_y', orgId: owner.orgId, amount: 24000,
  });
  assert.ok(realOrder?.id, 'a paying customer still creates orders normally');
});

test('approving emails the prospect their link, and never fails the approval if it cannot', async (t) => {
  const w = await world();
  t.after(w.close);
  const { _resetMockEmailStateForTests, _mockOutbox } = await import('../src/services/notifications/emailProvider.js');
  _resetMockEmailStateForTests();

  const { token } = await approvedToken(w.api, w.founder);
  const sent = _mockOutbox();
  const mail = sent.find((m) => m.to === REQUEST_BODY.email.toLowerCase());
  assert.ok(mail, 'the prospect is emailed on approval');
  assert.match(mail.subject, /BeFitter/, 'the subject names their own gym');
  assert.ok(mail.text.includes(token) || mail.html.includes(token), 'and it carries their working link');
  assert.match(mail.text, /Kirthi/, 'addressed to them by name');
  assert.match(mail.text, /don't start until you open the link/, 'and says the clock has not started');

  // The email is reported back so the console can tell the founder
  // whether they still need to send it themselves.
  await w.api.call('POST', '/api/demo/request', { ...REQUEST_BODY, email: 'second@befitter.example' });
  const list = await w.api.call('GET', '/api/console/demos', undefined, w.founder.token);
  const row = list.json.demos.find((d) => d.email === 'second@befitter.example');
  const approval = await w.api.call('POST', `/api/console/demos/${row.id}/approve`, {}, w.founder.token);
  assert.equal(approval.status, 200);
  assert.equal(approval.json.emailed.ok, true);

  // A name from the public request form reaches an HTML email body, so it
  // must be escaped -- this is the least trustworthy string in the system.
  await w.api.call('POST', '/api/demo/request', {
    ...REQUEST_BODY, email: 'xss@befitter.example',
    ownerName: '<script>alert(1)</script>', gymName: 'Gym & "Co"',
  });
  const list2 = await w.api.call('GET', '/api/console/demos', undefined, w.founder.token);
  const evil = list2.json.demos.find((d) => d.email === 'xss@befitter.example');
  await w.api.call('POST', `/api/console/demos/${evil.id}/approve`, {}, w.founder.token);
  const evilMail = _mockOutbox().find((m) => m.to === 'xss@befitter.example');
  assert.ok(evilMail, 'it still sends');
  assert.ok(!evilMail.html.includes('<script>'), 'with the script tag escaped out of the HTML body');
  assert.ok(evilMail.html.includes('&lt;script&gt;'), 'as escaped text');
  assert.ok(evilMail.html.includes('&amp;'), 'and the ampersand escaped too');
});
