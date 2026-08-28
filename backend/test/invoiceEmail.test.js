// ============================================================
// "Email Invoice" (gap #9 of the production-hardening handoff) --
// POST /api/enterprise/invoices/:id/email, at the HTTP route level
// against the mock email provider (see emailProvider.js). Reuses
// enterpriseFlow.test.js's own harness shape (memDb + seedPricing +
// startApp mounting auth/enterprise/enrollment together) since this
// route needs a real signup -> payment -> invoice chain to exercise
// honestly, not hand-inserted rows.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { _resetMockProviderStateForTests, mockSimulateCheckout } from '../src/services/payments/paymentProvider.js';
import { _mockOutbox, _resetMockEmailStateForTests } from '../src/services/notifications/emailProvider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  for (const ddl of ['contact_email TEXT', 'contact_phone TEXT', 'address TEXT', 'city TEXT', 'country TEXT', 'logo_url TEXT', 'website TEXT', 'instagram_url TEXT', 'description TEXT']) {
    db.exec(`ALTER TABLE gym_settings ADD COLUMN ${ddl}`);
  }
  db.exec(`ALTER TABLE trainers ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'`);
  db.exec(`ALTER TABLE packages ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  for (const ddl of ['data_json TEXT', `channel TEXT NOT NULL DEFAULT 'in_app'`]) {
    db.exec(`ALTER TABLE notifications ADD COLUMN ${ddl}`);
  }
  db.exec(`ALTER TABLE subscriptions ADD COLUMN lifecycle_status TEXT CHECK (lifecycle_status IN ('PENDING_PAYMENT','ACTIVE','PAUSED','SUSPENDED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED','TRANSFERRED'))`);
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
  await db.run(`INSERT INTO sk_pricing_rules (id, base_package_id, additional_client_rate, max_capacity, version, status, effective_from, created_at) VALUES
    ('r75', 'p75', 155, 100, 1, 'active', ?, ?)`, [nowIso, nowIso]);
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const enterpriseRoutes = (await import('../src/routes/enterprise.js')).default;
  const enrollmentRoutes = (await import('../src/routes/enrollment.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/enterprise', enterpriseRoutes(db));
  app.use('/api/enrollment', enrollmentRoutes(db));
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
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test.beforeEach(() => { resetRateLimits(); _resetMockProviderStateForTests(); _resetMockEmailStateForTests(); });

test('POST /invoices/:id/email: ORG_PACKAGE invoice (no client) falls back to the owner\'s own account email', async (t) => {
  const db = await memDb();
  await seedPricing(db);
  const api = await startApp(db);
  t.after(() => api.close());

  const signup = await api.call('POST', '/api/auth/setup-org', {
    orgName: 'Iron Forge Test Gym', ownerName: 'Owner Test', email: 'owner@ironforgetest.in', password: 'ownerpass1',
  });
  const ownerToken = signup.json.token;

  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, ownerToken);
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, ownerToken);
  const { paymentId, signature } = mockSimulateCheckout(order.json.order.provider_order_id);
  await api.call('POST', '/api/enterprise/payment/verify', { orderId: order.json.order.id, providerPaymentId: paymentId, signature }, ownerToken);

  const invoices = await api.call('GET', '/api/enterprise/invoices', undefined, ownerToken);
  const invoiceId = invoices.json.invoices[0].id;

  const emailRes = await api.call('POST', `/api/enterprise/invoices/${invoiceId}/email`, {}, ownerToken);
  assert.equal(emailRes.status, 200);
  assert.equal(emailRes.json.ok, true);
  assert.equal(emailRes.json.provider, 'mock');
  assert.equal(emailRes.json.to, 'owner@ironforgetest.in', 'no client on an ORG_PACKAGE invoice -- must fall back to the requesting owner\'s own email');

  const outbox = _mockOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'owner@ironforgetest.in');
  assert.ok(outbox[0].attachmentFilenames[0].endsWith('.pdf'));

  const invoiceRow = await db.q1('SELECT emailed_at FROM invoices WHERE id = ?', [invoiceId]);
  assert.ok(invoiceRow.emailed_at, 'emailed_at must be stamped on a successful send');
});

test('POST /invoices/:id/email: CLIENT_MEMBERSHIP invoice defaults to the actual client\'s email, and an explicit `to` overrides it', async (t) => {
  const db = await memDb();
  await seedPricing(db);
  const api = await startApp(db);
  t.after(() => api.close());

  const signup = await api.call('POST', '/api/auth/setup-org', {
    orgName: 'Iron Forge Test Gym', ownerName: 'Owner Test', email: 'owner2@ironforgetest.in', password: 'ownerpass1',
  });
  const ownerToken = signup.json.token;
  const orgId = signup.json.user.orgId;

  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, ownerToken);
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, ownerToken);
  const gymCheckout = mockSimulateCheckout(order.json.order.provider_order_id);
  await api.call('POST', '/api/enterprise/payment/verify', { orderId: order.json.order.id, providerPaymentId: gymCheckout.paymentId, signature: gymCheckout.signature }, ownerToken);

  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES (?, ?, ?, ?, ?, ?)`,
    ['plan_monthly', orgId, 'Monthly', 1500, 'INR', 30]);
  const clientQr = await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: 'plan_monthly' }, ownerToken);

  const clientSignup = await api.call('POST', '/api/auth/register', { name: 'Rahul Client', email: 'rahul@test.in', password: 'clientpass1' });
  const clientToken = clientSignup.json.token;
  const join = await api.call('POST', '/api/enrollment/client/join', { payload: clientQr.json.payload }, clientToken);
  const clientCheckout = mockSimulateCheckout(join.json.order.provider_order_id);
  await api.call('POST', '/api/enrollment/client/payment/verify', {
    orderId: join.json.order.id, providerPaymentId: clientCheckout.paymentId, signature: clientCheckout.signature,
  }, clientToken);

  const invoices = await api.call('GET', '/api/enterprise/invoices', undefined, ownerToken);
  const clientInvoice = invoices.json.invoices.find((i) => i.subject_type === 'CLIENT_MEMBERSHIP');
  assert.ok(clientInvoice);

  const emailRes = await api.call('POST', `/api/enterprise/invoices/${clientInvoice.id}/email`, {}, ownerToken);
  assert.equal(emailRes.status, 200);
  assert.equal(emailRes.json.to, 'rahul@test.in', 'defaults to the actual client who paid, not the owner');

  const overrideRes = await api.call('POST', `/api/enterprise/invoices/${clientInvoice.id}/email`, { to: 'accounting@ironforgetest.in' }, ownerToken);
  assert.equal(overrideRes.status, 200);
  assert.equal(overrideRes.json.to, 'accounting@ironforgetest.in', 'an explicit `to` in the body always wins over the resolved default');

  const outbox = _mockOutbox();
  assert.equal(outbox.length, 2);
});

test('POST /invoices/:id/email: an invoice belonging to a different org 404s, never leaks another gym\'s invoice or sends anything', async (t) => {
  const db = await memDb();
  await seedPricing(db);
  const api = await startApp(db);
  t.after(() => api.close());

  const signupA = await api.call('POST', '/api/auth/setup-org', { orgName: 'Gym A', ownerName: 'Owner A', email: 'ownerA@test.in', password: 'ownerpass1' });
  const quoteA = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, signupA.json.token);
  const orderA = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quoteA.json.quote.id }, signupA.json.token);
  const checkoutA = mockSimulateCheckout(orderA.json.order.provider_order_id);
  await api.call('POST', '/api/enterprise/payment/verify', { orderId: orderA.json.order.id, providerPaymentId: checkoutA.paymentId, signature: checkoutA.signature }, signupA.json.token);
  const invoicesA = await api.call('GET', '/api/enterprise/invoices', undefined, signupA.json.token);
  const invoiceIdA = invoicesA.json.invoices[0].id;

  const signupB = await api.call('POST', '/api/auth/setup-org', { orgName: 'Gym B', ownerName: 'Owner B', email: 'ownerB@test.in', password: 'ownerpass1' });

  const res = await api.call('POST', `/api/enterprise/invoices/${invoiceIdA}/email`, {}, signupB.json.token);
  assert.equal(res.status, 404);
  assert.equal(_mockOutbox().length, 0, 'nothing must be sent for an invoice that does not belong to the caller\'s org');
});

test('POST /invoices/:id/email: rejects an invalid `to` in the body before ever resolving or sending anything', async (t) => {
  const db = await memDb();
  await seedPricing(db);
  const api = await startApp(db);
  t.after(() => api.close());

  const signup = await api.call('POST', '/api/auth/setup-org', { orgName: 'Iron Forge', ownerName: 'Owner', email: 'owner3@test.in', password: 'ownerpass1' });
  const ownerToken = signup.json.token;
  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, ownerToken);
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, ownerToken);
  const checkout = mockSimulateCheckout(order.json.order.provider_order_id);
  await api.call('POST', '/api/enterprise/payment/verify', { orderId: order.json.order.id, providerPaymentId: checkout.paymentId, signature: checkout.signature }, ownerToken);
  const invoices = await api.call('GET', '/api/enterprise/invoices', undefined, ownerToken);

  const res = await api.call('POST', `/api/enterprise/invoices/${invoices.json.invoices[0].id}/email`, { to: 'not-an-email' }, ownerToken);
  assert.equal(res.status, 422);
  assert.equal(_mockOutbox().length, 0);
});
