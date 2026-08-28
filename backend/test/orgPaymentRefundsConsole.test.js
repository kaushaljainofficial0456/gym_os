// ============================================================
// POST /api/console/gyms/:id/payments/:orderId/refund -- the platform-
// side entry point for refunding a gym's OWN payment to SK OS
// (ORG_PACKAGE / ORG_CAPACITY_ADDON), as opposed to a client's payment
// to the gym (which is the owner's own call, via admin.js). Goes
// through the REAL HTTP signup -> quote -> payment/order -> verify
// flow (never inserts payment_orders rows by hand) so this proves the
// route against exactly what a real gym purchase produces.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  db.exec(`ALTER TABLE subscriptions ADD COLUMN lifecycle_status TEXT CHECK (lifecycle_status IN ('PENDING_PAYMENT','ACTIVE','PAUSED','SUSPENDED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED','TRANSFERRED'))`);
  db.exec(`ALTER TABLE users ADD COLUMN branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL`);
  db.exec(`ALTER TABLE trainers ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'`);
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

async function seedPricing(db) {
  const nowIso = '2026-01-01T00:00:00Z';
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at) VALUES
    ('p75', '75 Clients', 75, 12000, 'INR', 365, 1, 'active', ?, ?)`, [nowIso, nowIso]);
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const enterpriseRoutes = (await import('../src/routes/enterprise.js')).default;
  const enrollmentRoutes = (await import('../src/routes/enrollment.js')).default;
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/enterprise', enterpriseRoutes(db));
  app.use('/api/enrollment', enrollmentRoutes(db));
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
  return { token: signup.json.token, orgId: signup.json.user.orgId };
}

async function createSuperAdmin(db, api, email = 'admin@sk-os.test') {
  const userId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [userId, email, await hashPassword('adminpass1'), 'Platform Admin', now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password: 'adminpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

/** Real signup -> quote -> order -> verify, exactly what a gym owner's
 *  browser does -- returns the resulting payment_order id. */
async function buyOrgPackage(api, ownerToken) {
  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, ownerToken);
  assert.equal(quote.status, 200, JSON.stringify(quote.json));
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, ownerToken);
  assert.equal(order.status, 200, JSON.stringify(order.json));
  const { paymentId, signature } = mockSimulateCheckout(order.json.order.provider_order_id);
  const verify = await api.call('POST', '/api/enterprise/payment/verify', { orderId: order.json.order.id, providerPaymentId: paymentId, signature }, ownerToken);
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  return order.json.order.id;
}

test.beforeEach(() => { resetRateLimits(); _resetMockProviderStateForTests(); });

test('SUPER_ADMIN can refund a gym\'s ORG_PACKAGE payment; the gym\'s billing state is cancelled', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner1@test.in', 'Refund Gym');
  const admin = await createSuperAdmin(db, api);
  const orderId = await buyOrgPackage(api, owner.token);

  const res = await api.call('POST', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refund`, { reason: 'duplicate charge' }, admin.token);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.orderStatus, 'REFUNDED');
  assert.equal(res.json.orgSubscriptionCancelled, true);

  const status = await api.call('GET', '/api/enterprise/status', undefined, owner.token);
  assert.equal(status.json.billingStatus, 'CANCELLED');

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  assert.ok(audit.json.logs.some((l) => l.action === 'org_payment_refunded' && l.entity_id === orderId), 'the refund must be in the platform audit trail');
});

test('a non-SUPER_ADMIN (gym owner) is blocked from the console refund route, never just hidden client-side', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner2@test.in', 'Refund Gym 2');
  const orderId = await buyOrgPackage(api, owner.token);

  const res = await api.call('POST', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refund`, {}, owner.token);
  assert.equal(res.status, 403);
});

test('a CLIENT_MEMBERSHIP order is rejected by this route -- that refund belongs to the gym owner, not the platform', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner3@test.in', 'Refund Gym 3');
  const admin = await createSuperAdmin(db, api);
  await buyOrgPackage(api, owner.token); // activates the gym

  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES ('plan1', ?, 'Monthly', 1500, 'INR', 30)`, [owner.orgId]);
  const qr = await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: 'plan1' }, owner.token);
  const clientSignup = await api.call('POST', '/api/auth/register', { name: 'Client', email: 'client3@test.in', password: 'clientpass1' });
  const join = await api.call('POST', '/api/enrollment/client/join', { payload: qr.json.payload }, clientSignup.json.token);
  const { paymentId, signature } = mockSimulateCheckout(join.json.order.provider_order_id);
  await api.call('POST', '/api/enrollment/client/payment/verify', { orderId: join.json.order.id, providerPaymentId: paymentId, signature }, clientSignup.json.token);

  const res = await api.call('POST', `/api/console/gyms/${owner.orgId}/payments/${join.json.order.id}/refund`, {}, admin.token);
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'not_an_org_payment');
});

test('a payment order id belonging to a DIFFERENT gym returns 404, never leaks or cross-refunds', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'ownerA@test.in', 'Gym A');
  const ownerB = await setupOwner(api, 'ownerB@test.in', 'Gym B');
  const admin = await createSuperAdmin(db, api);
  const orderIdB = await buyOrgPackage(api, ownerB.token);

  const res = await api.call('POST', `/api/console/gyms/${ownerA.orgId}/payments/${orderIdB}/refund`, {}, admin.token);
  assert.equal(res.status, 404);

  const statusB = await api.call('GET', '/api/enterprise/status', undefined, ownerB.token);
  assert.equal(statusB.json.billingStatus, 'ACTIVE', "Gym B's own subscription must be completely unaffected");
});
