// ============================================================
// Fraud/risk monitoring -- confirmed a complete blank slate before
// this pass. Every detector must: (a) only fire on genuinely
// threshold-crossing real data, (b) never duplicate an already-open
// flag for the same entity+reason, (c) never itself mutate anything
// besides risk_events -- flagging for review is the only effect.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { hashPassword } from '../src/auth.js';
import { id, now } from '../src/ids.js';
import { runRiskScan, listRiskEvents, resolveRiskEvent, markReviewing } from '../src/services/risk/riskEngine.js';

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
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db,
  });
  return mk();
}

async function seedOrg(db, orgId = 'o1') {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, 'Gym', 'gym-' + orgId, now()]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, 'x', 'GYM_OWNER', 'Owner', ?)`,
    [`usr_${orgId}`, orgId, `owner_${orgId}@test.com`, now()]);
}

async function insertToken(db, { orgId, createdBy, createdAt }) {
  await db.run(
    `INSERT INTO enrollment_tokens (id, org_id, created_by, purpose, token_hash, status, expires_at, created_at) VALUES (?, ?, ?, 'CLIENT', ?, 'AVAILABLE', ?, ?)`,
    [id('enr'), orgId, createdBy, id('hash'), new Date(Date.now() + 600_000).toISOString(), createdAt]);
}

async function insertFailedPayment(db, { orgId, createdAt }) {
  await db.run(
    `INSERT INTO payment_orders (id, subject_type, subject_id, org_id, amount, currency, provider, status, created_at, updated_at) VALUES (?, 'ORG_PACKAGE', 's1', ?, 1000, 'INR', 'mock', 'FAILED', ?, ?)`,
    [id('pord'), orgId, createdAt, createdAt]);
}

async function insertSuccessfulRefund(db, { orgId, createdAt }) {
  const orderId = id('pord');
  await db.run(
    `INSERT INTO payment_orders (id, subject_type, subject_id, org_id, amount, currency, provider, status, created_at, updated_at) VALUES (?, 'CLIENT_MEMBERSHIP', 's1', ?, 1000, 'INR', 'mock', 'REFUNDED', ?, ?)`,
    [orderId, orgId, createdAt, createdAt]);
  await db.run(
    `INSERT INTO refunds (id, payment_order_id, org_id, type, amount, currency, status, created_at, updated_at) VALUES (?, ?, ?, 'FULL', 1000, 'INR', 'SUCCESS', ?, ?)`,
    [id('rfnd'), orderId, orgId, createdAt, createdAt]);
}

test.beforeEach(() => { resetRateLimits(); });

test('runRiskScan: an empty platform raises nothing', async () => {
  const db = await memDb();
  const summary = await runRiskScan(db);
  assert.deepEqual(summary, { rapidQrGeneration: 0, multipleFailedPayments: 0, unusualRefundVolume: 0, totalRaised: 0 });
});

test('detectRapidQrGeneration: flags a user who generated >= threshold QR tokens within the window, never below it', async () => {
  const db = await memDb();
  await seedOrg(db);
  const recent = new Date().toISOString();
  for (let i = 0; i < 10; i++) await insertToken(db, { orgId: 'o1', createdBy: 'usr_o1', createdAt: recent });

  const summary = await runRiskScan(db);
  assert.equal(summary.rapidQrGeneration, 1);
  const events = await listRiskEvents(db, { status: 'OPEN' });
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'RAPID_QR_GENERATION');
  assert.equal(events[0].entity_id, 'usr_o1');
  assert.ok(events[0].risk_score > 0);
});

test('detectRapidQrGeneration: below the threshold raises nothing', async () => {
  const db = await memDb();
  await seedOrg(db);
  const recent = new Date().toISOString();
  for (let i = 0; i < 3; i++) await insertToken(db, { orgId: 'o1', createdBy: 'usr_o1', createdAt: recent });

  const summary = await runRiskScan(db);
  assert.equal(summary.rapidQrGeneration, 0);
});

test('runRiskScan: re-running never raises a duplicate for an already-OPEN flag', async () => {
  const db = await memDb();
  await seedOrg(db);
  const recent = new Date().toISOString();
  for (let i = 0; i < 10; i++) await insertToken(db, { orgId: 'o1', createdBy: 'usr_o1', createdAt: recent });

  const first = await runRiskScan(db);
  assert.equal(first.rapidQrGeneration, 1);
  const second = await runRiskScan(db);
  assert.equal(second.rapidQrGeneration, 0, 'the same still-open flag must not be raised twice');
  const events = await listRiskEvents(db);
  assert.equal(events.length, 1);
});

test('detectMultipleFailedPayments: flags an org with >= threshold recent failures', async () => {
  const db = await memDb();
  await seedOrg(db);
  const recent = new Date().toISOString();
  for (let i = 0; i < 5; i++) await insertFailedPayment(db, { orgId: 'o1', createdAt: recent });

  const summary = await runRiskScan(db);
  assert.equal(summary.multipleFailedPayments, 1);
  const events = await listRiskEvents(db);
  assert.equal(events.find((e) => e.reason === 'MULTIPLE_FAILED_PAYMENTS').entity_id, 'o1');
});

test('detectUnusualRefundVolume: flags an org with >= threshold successful refunds in the window', async () => {
  const db = await memDb();
  await seedOrg(db);
  const recent = new Date().toISOString();
  for (let i = 0; i < 5; i++) await insertSuccessfulRefund(db, { orgId: 'o1', createdAt: recent });

  const summary = await runRiskScan(db);
  assert.equal(summary.unusualRefundVolume, 1);
});

test('stale events (outside the detection window) are never flagged', async () => {
  const db = await memDb();
  await seedOrg(db);
  const longAgo = '2020-01-01T00:00:00.000Z';
  for (let i = 0; i < 10; i++) await insertToken(db, { orgId: 'o1', createdBy: 'usr_o1', createdAt: longAgo });

  const summary = await runRiskScan(db);
  assert.equal(summary.rapidQrGeneration, 0, 'QR tokens generated years ago must never trigger a "rapid" flag today');
});

test('markReviewing / resolveRiskEvent: lifecycle works and never auto-bans/suspends anything', async () => {
  const db = await memDb();
  await seedOrg(db);
  const recent = new Date().toISOString();
  for (let i = 0; i < 10; i++) await insertToken(db, { orgId: 'o1', createdBy: 'usr_o1', createdAt: recent });
  await runRiskScan(db);
  const [event] = await listRiskEvents(db, { status: 'OPEN' });

  const reviewing = await markReviewing(db, { eventId: event.id });
  assert.equal(reviewing, true);
  const [afterReview] = await listRiskEvents(db, { status: 'REVIEWING' });
  assert.equal(afterReview.id, event.id);

  const resolved = await resolveRiskEvent(db, { eventId: event.id, resolvedBy: 'usr_o1', note: 'confirmed legitimate bulk onboarding' });
  assert.equal(resolved, true);
  const [afterResolve] = await listRiskEvents(db, { status: 'RESOLVED' });
  assert.equal(afterResolve.note, 'confirmed legitimate bulk onboarding');

  // The flagged user's account itself was never touched by any of this.
  const user = await db.q1('SELECT active FROM users WHERE id = ?', ['usr_o1']);
  assert.equal(user.active, 1, 'flagging/resolving a risk event must never itself disable an account');
});

// ---------------------------------------------------------------
// ROUTE-LEVEL
// ---------------------------------------------------------------

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/console', consoleRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

async function createSuperAdmin(db, api, email = 'admin@sk-os.test') {
  const userId = id('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [userId, email, await hashPassword('adminpass1'), 'Platform Admin', now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password: 'adminpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

test('POST /api/console/risk/scan + resolve: end to end via HTTP, audited', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await seedOrg(db);
  const recent = new Date().toISOString();
  for (let i = 0; i < 10; i++) await insertToken(db, { orgId: 'o1', createdBy: 'usr_o1', createdAt: recent });
  const admin = await createSuperAdmin(db, api);

  const scan = await api.call('POST', '/api/console/risk/scan', undefined, admin.token);
  assert.equal(scan.status, 200);
  assert.equal(scan.json.rapidQrGeneration, 1);

  const list = await api.call('GET', '/api/console/risk', undefined, admin.token);
  assert.equal(list.json.events.length, 1);

  const resolve = await api.call('POST', `/api/console/risk/${list.json.events[0].id}/resolve`, { note: 'legit' }, admin.token);
  assert.equal(resolve.status, 200);

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  assert.ok(audit.json.logs.some((l) => l.action === 'risk_scan_run'));
  assert.ok(audit.json.logs.some((l) => l.action === 'risk_event_resolved'));
});
