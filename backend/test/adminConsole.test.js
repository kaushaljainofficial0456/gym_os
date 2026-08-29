// ============================================================
// Admin Console API (/api/console) -- SUPER_ADMIN-only platform
// operator surface. Covers: role gating (non-SUPER_ADMIN blocked),
// real (never fabricated) dashboard aggregates, gyms list/detail,
// suspend/reactivate + audit trail, platform-wide payments/
// reconciliation (reusing Phase 1's engine unchanged), and the audit
// log viewer itself.
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
import { mockSimulateCheckout, _resetMockProviderStateForTests } from '../src/services/payments/paymentProvider.js';
import { createPaymentOrder } from '../src/services/payments/paymentOrders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  db.exec(`ALTER TABLE subscriptions ADD COLUMN lifecycle_status TEXT CHECK (lifecycle_status IN ('PENDING_PAYMENT','ACTIVE','PAUSED','SUSPENDED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED','TRANSFERRED'))`);
  db.exec(`ALTER TABLE users ADD COLUMN branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL`);
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

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const enterpriseRoutes = (await import('../src/routes/enterprise.js')).default;
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/enterprise', enterpriseRoutes(db));
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

async function setupOwner(api, email, orgName) {
  const signup = await api.call('POST', '/api/auth/setup-org', { orgName, ownerName: 'Owner', email, password: 'ownerpass1' });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  return { token: signup.json.token, orgId: signup.json.user.orgId, userId: signup.json.user.id };
}

/** Mirrors scripts/create-super-admin.js's own insert exactly (there is
 *  no HTTP route that could do this -- by design, see that script's own
 *  header comment) -- then logs in through the real /auth/login route,
 *  never fabricating a token by hand. */
async function createSuperAdmin(db, api, email = 'admin@sk-os.test') {
  const userId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [userId, email, await hashPassword('adminpass1'), 'Platform Admin', now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password: 'adminpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

test.beforeEach(() => { resetRateLimits(); _resetMockProviderStateForTests(); });

// ---------------------------------------------------------------
// ACCESS CONTROL
// ---------------------------------------------------------------

test('/api/console/*: an unauthenticated request is rejected', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const res = await api.call('GET', '/api/console/dashboard');
  assert.equal(res.status, 401);
});

test('/api/console/*: a GYM_OWNER (or any non-SUPER_ADMIN) is blocked, never just hidden client-side', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner@test.com', 'Some Gym');
  const res = await api.call('GET', '/api/console/dashboard', undefined, owner.token);
  assert.equal(res.status, 403);
  const gyms = await api.call('GET', '/api/console/gyms', undefined, owner.token);
  assert.equal(gyms.status, 403);
});

// ---------------------------------------------------------------
// DASHBOARD -- real aggregates, never fabricated
// ---------------------------------------------------------------

test('/api/console/dashboard: an empty platform shows real zeros, not example numbers', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const admin = await createSuperAdmin(db, api);
  const res = await api.call('GET', '/api/console/dashboard', undefined, admin.token);
  assert.equal(res.status, 200);
  assert.equal(res.json.totalGyms, 0);
  assert.equal(res.json.activeGyms, 0);
  assert.equal(res.json.totalClients, 0);
  assert.equal(res.json.revenueToday, 0);
});

test('/api/console/dashboard: reflects real gyms/clients created through the normal signup flow', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await setupOwner(api, 'ownerX@test.com', 'Gym X');
  await setupOwner(api, 'ownerY@test.com', 'Gym Y');
  const admin = await createSuperAdmin(db, api);

  const res = await api.call('GET', '/api/console/dashboard', undefined, admin.token);
  assert.equal(res.json.totalGyms, 2);
});

// ---------------------------------------------------------------
// GYMS
// ---------------------------------------------------------------

test('/api/console/gyms: lists every gym platform-wide, with client/trainer counts', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerZ@test.com', 'Gym Z');
  const admin = await createSuperAdmin(db, api);

  const list = await api.call('GET', '/api/console/gyms', undefined, admin.token);
  assert.equal(list.status, 200);
  assert.equal(list.json.gyms.length, 1);
  assert.equal(list.json.gyms[0].id, owner.orgId);
  assert.equal(list.json.gyms[0].client_count, 0);

  const detail = await api.call('GET', `/api/console/gyms/${owner.orgId}`, undefined, admin.token);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.owner.email, 'ownerz@test.com');
  assert.equal(detail.json.billing.status, 'SETUP');
});

test('/api/console/gyms/:id/suspend and /reactivate: mutate billing state and write an audit record each time', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerSusp@test.com', 'Suspend Gym');
  const admin = await createSuperAdmin(db, api);

  const suspend = await api.call('POST', `/api/console/gyms/${owner.orgId}/suspend`, { reason: 'non-payment' }, admin.token);
  assert.equal(suspend.status, 200);
  let billing = await db.q1('SELECT status FROM org_billing_state WHERE org_id = ?', [owner.orgId]);
  assert.equal(billing.status, 'SUSPENDED');

  const reactivate = await api.call('POST', `/api/console/gyms/${owner.orgId}/reactivate`, undefined, admin.token);
  assert.equal(reactivate.status, 200);
  billing = await db.q1('SELECT status FROM org_billing_state WHERE org_id = ?', [owner.orgId]);
  assert.equal(billing.status, 'ACTIVE');

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  const actions = audit.json.logs.map((l) => l.action);
  assert.ok(actions.includes('gym_suspended'));
  assert.ok(actions.includes('gym_reactivated'));
  const suspendLog = audit.json.logs.find((l) => l.action === 'gym_suspended');
  assert.equal(suspendLog.entity_id, owner.orgId);
  assert.equal(suspendLog.after_json.reason, 'non-payment');
});

test('/api/console/gyms/:id/suspend: a nonexistent gym is a clean 404, never a silent no-op', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const admin = await createSuperAdmin(db, api);
  const res = await api.call('POST', '/api/console/gyms/org_does_not_exist/suspend', {}, admin.token);
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------
// PAYMENTS + RECONCILIATION -- platform-wide, reusing Phase 1
// ---------------------------------------------------------------

test('/api/console/payments: lists payment orders across ALL gyms, not just one', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'payA@test.com', 'Pay Gym A');
  const ownerB = await setupOwner(api, 'payB@test.com', 'Pay Gym B');
  await db.run(`INSERT INTO payment_orders (id, subject_type, subject_id, org_id, amount, currency, provider, status, created_at, updated_at) VALUES (?, 'ORG_PACKAGE', 's1', ?, 12000, 'INR', 'mock', 'SUCCESS', ?, ?)`,
    ['pordA', ownerA.orgId, now(), now()]);
  await db.run(`INSERT INTO payment_orders (id, subject_type, subject_id, org_id, amount, currency, provider, status, created_at, updated_at) VALUES (?, 'ORG_PACKAGE', 's2', ?, 15000, 'INR', 'mock', 'SUCCESS', ?, ?)`,
    ['pordB', ownerB.orgId, now(), now()]);
  const admin = await createSuperAdmin(db, api);

  const res = await api.call('GET', '/api/console/payments', undefined, admin.token);
  assert.equal(res.status, 200);
  const orgNames = res.json.payments.map((p) => p.org_name).sort();
  assert.deepEqual(orgNames, ['Pay Gym A', 'Pay Gym B']);
});

test('/api/console/reconciliation/run + resolve: platform-wide sweep flags a stuck order and the admin can resolve it', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'reconAdmin@test.com', 'Recon Gym');
  // A real mock-provider order, abandoned mid-checkout (never simulated
  // as paid) and backdated past the sweep's staleness window -- exactly
  // the "abandoned checkout" case Phase 1's engine flags for review.
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 's1', orgId: owner.orgId, amount: 12000 });
  await db.run('UPDATE payment_orders SET created_at = ? WHERE id = ?', ['2020-01-01T00:00:00Z', order.id]);
  const admin = await createSuperAdmin(db, api);

  const run = await api.call('POST', '/api/console/reconciliation/run', undefined, admin.token);
  assert.equal(run.status, 200);
  assert.equal(run.json.flagged, 1);

  const list = await api.call('GET', '/api/console/reconciliation', undefined, admin.token);
  assert.equal(list.status, 200);
  assert.equal(list.json.issues.length, 1);
  assert.equal(list.json.issues[0].issue_type, 'STUCK_NON_TERMINAL');

  const resolve = await api.call('POST', `/api/console/reconciliation/${list.json.issues[0].id}/resolve`, { note: 'contacted the gym owner' }, admin.token);
  assert.equal(resolve.status, 200);

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  assert.ok(audit.json.logs.some((l) => l.action === 'platform_reconciliation_run'));
  assert.ok(audit.json.logs.some((l) => l.action === 'reconciliation_issue_resolved'));
});
