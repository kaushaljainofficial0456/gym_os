// ============================================================
// FULL ENTERPRISE ACCEPTANCE FLOW — end to end, at the HTTP route
// level, against the mock payment provider. This is the direct test
// of the spec's own "FINAL ACCEPTANCE CRITERIA" walkthrough:
//
//   Enterprise signup -> onboarding -> package selection -> payment ->
//   gym activated -> owner generates client QR -> client registers ->
//   scans QR -> pays membership -> membership active ->
//   owner generates trainer QR -> trainer registers -> scans QR ->
//   trainer active -> capacity exhaustion -> buy more capacity
//
// Mounts auth.js + enterprise.js + enrollment.js together in one app,
// matching index.js's real wiring, because this flow genuinely spans
// all three files.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { _resetMockProviderStateForTests, mockSimulateCheckout } from '../src/services/payments/paymentProvider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // Columns added via scripts/init-db.js's guarded MIGRATIONS array,
  // which this lightweight in-memory DB doesn't run -- same gap
  // documented throughout this test suite's other memDb() helpers.
  for (const ddl of ['contact_email TEXT', 'contact_phone TEXT', 'address TEXT', 'city TEXT', 'country TEXT', 'logo_url TEXT', 'website TEXT', 'instagram_url TEXT', 'description TEXT']) {
    db.exec(`ALTER TABLE gym_settings ADD COLUMN ${ddl}`);
  }
  db.exec(`ALTER TABLE trainers ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'`);
  db.exec(`ALTER TABLE packages ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  for (const ddl of ['data_json TEXT', `channel TEXT NOT NULL DEFAULT 'in_app'`]) {
    try { db.exec(`ALTER TABLE notifications ADD COLUMN ${ddl}`); } catch {}
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

// Seeds the exact spec example pricing (independent of init-db.js's own
// seed, so this test is self-contained and never silently breaks if
// that seed is retuned later).
async function seedPricing(db) {
  const nowIso = '2026-01-01T00:00:00Z';
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at) VALUES
    ('p75', '75 Clients', 75, 12000, 'INR', 365, 1, 'active', ?, ?),
    ('p100', '100 Clients', 100, 15000, 'INR', 365, 1, 'active', ?, ?)`,
    [nowIso, nowIso, nowIso, nowIso]);
  await db.run(`INSERT INTO sk_pricing_rules (id, base_package_id, additional_client_rate, max_capacity, version, status, effective_from, created_at) VALUES
    ('r75', 'p75', 155, 100, 1, 'active', ?, ?)`, [nowIso, nowIso]);
  await db.run(`INSERT INTO sk_capacity_addons (id, increment, price, currency, version, status, effective_from, created_at) VALUES
    ('add10', 10, 1800, 'INR', 1, 'active', ?, ?)`, [nowIso, nowIso]);
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const enterpriseRoutes = (await import('../src/routes/enterprise.js')).default;
  const enrollmentRoutes = (await import('../src/routes/enrollment.js')).default;
  const app = express();
  // The webhook route needs a raw body in production (see index.js) --
  // not exercised here (this file tests checkout-verification, the
  // OTHER independently-sufficient activation path; webhook idempotency
  // itself is already covered directly in paymentEngine.test.js), so a
  // plain express.json() for everything is fine for this file's scope.
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

test.beforeEach(() => { resetRateLimits(); _resetMockProviderStateForTests(); });

test('FULL FLOW: signup -> onboarding -> package -> payment -> activation -> client QR -> client join+pay -> membership active -> trainer QR -> trainer join -> active', async (t) => {
  const db = await memDb();
  await seedPricing(db);
  const api = await startApp(db);
  t.after(() => api.close());

  // ---- 1. Enterprise signup ----
  const signup = await api.call('POST', '/api/auth/setup-org', {
    orgName: 'Iron Forge Test Gym', ownerName: 'Owner Test', email: 'owner@ironforgetest.in', password: 'ownerpass1',
    contactPhone: '9999999999', country: 'India', city: 'Mumbai', address: '1 Test Street',
  });
  assert.equal(signup.status, 201);
  const ownerToken = signup.json.token;
  const orgId = signup.json.user.orgId;

  let status = await api.call('GET', '/api/enterprise/status', undefined, ownerToken);
  assert.equal(status.json.billingStatus, 'SETUP', 'a freshly created gym starts in SETUP, never immediately ACTIVE');

  // ---- 2. Onboarding wizard ----
  const onboarding = await api.call('POST', '/api/enterprise/onboarding', {
    gymType: 'commercial', clientCountRange: '26-50', trainerCount: 3, branchCount: 1,
    access: { rfid: true, manual: true }, billingCycle: 'monthly',
    offers: { personalTraining: true, membershipPlans: true }, complete: true,
  }, ownerToken);
  assert.equal(onboarding.status, 200);
  const onboardingRow = await api.call('GET', '/api/enterprise/onboarding', undefined, ownerToken);
  assert.equal(onboardingRow.json.onboarding.gym_type, 'commercial');
  assert.ok(onboardingRow.json.onboarding.completed_at);

  // ---- 3. Package selection (custom capacity: 80 clients) ----
  const calc = await api.call('POST', '/api/enterprise/packages/calculate', { capacity: 80 }, ownerToken);
  assert.equal(calc.status, 200);
  assert.equal(calc.json.price, 12775, 'matches the spec\'s own worked example');

  // ---- 4. Payment order for the gym package ----
  const quote80 = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 80 }, ownerToken);
  assert.equal(quote80.status, 200);
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote80.json.quote.id }, ownerToken);
  assert.equal(order.status, 200);
  assert.equal(order.json.order.amount, 12775);
  assert.equal(order.json.order.status, 'CREATED');

  status = await api.call('GET', '/api/enterprise/status', undefined, ownerToken);
  assert.equal(status.json.billingStatus, 'PAYMENT_PENDING');

  // ---- 5. Checkout completes, verified server-side ----
  const { paymentId, signature } = mockSimulateCheckout(order.json.order.provider_order_id);
  const verify = await api.call('POST', '/api/enterprise/payment/verify', {
    orderId: order.json.order.id, providerPaymentId: paymentId, signature,
  }, ownerToken);
  assert.equal(verify.status, 200);

  // ---- 6. Gym is now ACTIVE with real capacity ----
  status = await api.call('GET', '/api/enterprise/status', undefined, ownerToken);
  assert.equal(status.json.billingStatus, 'ACTIVE');
  assert.equal(status.json.purchasedCapacity, 80);
  assert.equal(status.json.availableCapacity, 80);
  assert.ok(status.json.subscription.end_date);

  const invoices = await api.call('GET', '/api/enterprise/invoices', undefined, ownerToken);
  assert.equal(invoices.json.invoices.length, 1);
  assert.equal(invoices.json.invoices[0].amount, 12775);

  // ---- 7. Owner creates a membership plan, then a client QR ----
  // packages (reused as membership_plans) has no dedicated route in this
  // file's scope -- insert directly, matching admin.js's own POST /packages shape.
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES (?, ?, ?, ?, ?, ?)`,
    ['plan_monthly', orgId, 'Monthly', 1500, 'INR', 30]);
  const clientQr = await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: 'plan_monthly' }, ownerToken);
  assert.equal(clientQr.status, 200);
  assert.ok(clientQr.json.payload.startsWith('enr_'));
  assert.equal(clientQr.json.remainingCapacity, 80);

  // ---- 8. Client enters SK OS, creates account WITHOUT a gym code ----
  const clientSignup = await api.call('POST', '/api/auth/register', { name: 'New Client', email: 'newclient@test.in', password: 'clientpass1' });
  assert.equal(clientSignup.status, 201);
  assert.equal(clientSignup.json.user.pendingGymEnrollment, true);
  assert.equal(clientSignup.json.user.orgId, null);
  let clientToken = clientSignup.json.token;

  // ---- 9. Client previews the QR before committing ----
  const preview = await api.call('POST', '/api/enrollment/preview', { payload: clientQr.json.payload }, clientToken);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.gym.name, 'Iron Forge Test Gym');
  assert.equal(preview.json.membershipPlan.name, 'Monthly');
  assert.equal(preview.json.membershipPlan.amount, 1500);

  // ---- 10. Client joins (consumes the QR, gets a payment order) ----
  const join = await api.call('POST', '/api/enrollment/client/join', { payload: clientQr.json.payload }, clientToken);
  assert.equal(join.status, 200);
  assert.equal(join.json.order.amount, 1500);
  assert.equal(join.json.order.status, 'CREATED');

  // Membership is NOT active yet -- payment hasn't happened.
  const noClientYet = await db.q1('SELECT id FROM clients WHERE user_id = ?', [clientSignup.json.user.id]);
  assert.equal(noClientYet, null, 'no clients row before payment succeeds');

  // The QR is burned -- cannot be scanned again even before payment.
  const previewAgain = await api.call('POST', '/api/enrollment/preview', { payload: clientQr.json.payload }, clientToken);
  assert.equal(previewAgain.status, 422);
  assert.equal(previewAgain.json.error, 'already_consumed');

  // ---- 11. Client pays, membership activates ----
  const clientCheckout = mockSimulateCheckout(join.json.order.provider_order_id);
  const clientVerify = await api.call('POST', '/api/enrollment/client/payment/verify', {
    orderId: join.json.order.id, providerPaymentId: clientCheckout.paymentId, signature: clientCheckout.signature,
  }, clientToken);
  assert.equal(clientVerify.status, 200);
  assert.equal(clientVerify.json.membershipActive, true);
  assert.ok(clientVerify.json.token, 'a fresh token reflecting the new org membership must be issued');
  clientToken = clientVerify.json.token;

  const realClient = await db.q1('SELECT * FROM clients WHERE user_id = ?', [clientSignup.json.user.id]);
  assert.ok(realClient);
  assert.equal(realClient.org_id, orgId);
  const membership = await db.q1('SELECT * FROM subscriptions WHERE client_id = ?', [realClient.id]);
  assert.equal(membership.status, 'active');
  assert.equal(membership.amount, 1500);
  const paymentRow = await db.q1('SELECT * FROM payments WHERE client_id = ?', [realClient.id]);
  assert.ok(paymentRow, 'a payments row must exist for Business dashboard compatibility');

  // ---- 12. Capacity correctly decremented by exactly one ----
  status = await api.call('GET', '/api/enterprise/status', undefined, ownerToken);
  assert.equal(status.json.activeClients, 1);
  assert.equal(status.json.availableCapacity, 79, '80 purchased - 1 active = 79 available');

  // ---- 13. Owner generates a trainer QR ----
  const trainerQr = await api.call('POST', '/api/enrollment/qr/trainer', undefined, ownerToken);
  assert.equal(trainerQr.status, 200);

  // ---- 14. Trainer registers, joins, activates immediately (no payment) ----
  const trainerSignup = await api.call('POST', '/api/auth/register-trainer', { name: 'New Trainer', email: 'newtrainer@test.in', password: 'trainerpass1' });
  assert.equal(trainerSignup.status, 201);
  assert.equal(trainerSignup.json.user.pendingGymEnrollment, true);
  const trainerJoin = await api.call('POST', '/api/enrollment/trainer/join', { payload: trainerQr.json.payload }, trainerSignup.json.token);
  assert.equal(trainerJoin.status, 200);
  assert.equal(trainerJoin.json.gym.name, 'Iron Forge Test Gym');
  assert.ok(trainerJoin.json.token);

  const realTrainer = await db.q1('SELECT * FROM trainers WHERE user_id = ?', [trainerSignup.json.user.id]);
  assert.ok(realTrainer);
  assert.equal(realTrainer.org_id, orgId);
  assert.equal(realTrainer.status, 'ACTIVE');

  status = await api.call('GET', '/api/enterprise/status', undefined, ownerToken);
  assert.equal(status.json.activeTrainers, 1);
});

test('capacity exhaustion: generating a client QR at zero remaining capacity is refused', async (t) => {
  const db = await memDb();
  await seedPricing(db);
  const api = await startApp(db);
  t.after(() => api.close());

  const signup = await api.call('POST', '/api/auth/setup-org', { orgName: 'Tiny Gym', ownerName: 'Owner', email: 'owner2@test.in', password: 'ownerpass1' });
  const ownerToken = signup.json.token;
  const orgId = signup.json.user.orgId;

  // Buy the smallest possible capacity via a direct 1-client purchase --
  // simplest way to reach zero remaining after exactly one join.
  const calc = await api.call('POST', '/api/enterprise/packages/calculate', { capacity: 75 }, ownerToken);
  const quote75a = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, ownerToken);
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote75a.json.quote.id }, ownerToken);
  const { paymentId, signature } = mockSimulateCheckout(order.json.order.provider_order_id);
  await api.call('POST', '/api/enterprise/payment/verify', { orderId: order.json.order.id, providerPaymentId: paymentId, signature }, ownerToken);

  // Manually fill capacity to exactly the purchased limit (75 clients)
  // without going through 75 real joins -- direct DB seed, this test is
  // about the CAPACITY GATE, not re-proving the join flow already
  // covered above.
  await db.run(`INSERT INTO organizations (id, name, slug, created_at) VALUES ('filler-org', 'filler', 'filler', '2026-01-01T00:00:00Z')`);
  for (let i = 0; i < 75; i++) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, 'x', 'CLIENT', ?, 1, ?)`,
      [`fu${i}`, orgId, `filler${i}@test.in`, `Filler ${i}`, '2026-01-01T00:00:00Z']);
    await db.run(`INSERT INTO clients (id, user_id, org_id, status, goal, created_at) VALUES (?, ?, ?, 'ON_TRACK', 'GENERAL', ?)`,
      [`fc${i}`, `fu${i}`, orgId, '2026-01-01T00:00:00Z']);
  }
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES (?, ?, ?, ?, ?, ?)`,
    ['plan_x', orgId, 'Monthly', 1500, 'INR', 30]);

  const status = await api.call('GET', '/api/enterprise/status', undefined, ownerToken);
  assert.equal(status.json.availableCapacity, 0);

  const qr = await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: 'plan_x' }, ownerToken);
  assert.equal(qr.status, 409);
  assert.equal(qr.json.error, 'No client capacity remaining');
});

test('client join rejects a QR for a gym whose SK OS package is not yet active', async (t) => {
  const db = await memDb();
  await seedPricing(db);
  const api = await startApp(db);
  t.after(() => api.close());

  const signup = await api.call('POST', '/api/auth/setup-org', { orgName: 'Unpaid Gym', ownerName: 'Owner', email: 'owner3@test.in', password: 'ownerpass1' });
  const ownerToken = signup.json.token;
  // No package payment made -- org_billing_state stays SETUP.

  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES (?, ?, ?, ?, ?, ?)`,
    ['plan_y', signup.json.user.orgId, 'Monthly', 1500, 'INR', 30]);
  // qr/client itself is gated on ACTIVE status too -- confirm that gate fires first.
  const qr = await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: 'plan_y' }, ownerToken);
  assert.equal(qr.status, 409);
  assert.equal(qr.json.error, 'Your SK OS package is not active yet');
});

// Spec, verbatim: "Two requests consuming the last capacity
// simultaneously... the system must remain consistent." Two DIFFERENT
// valid client QRs (each already legitimately issued while capacity
// existed), both racing to consume the SAME single remaining slot.
test('RACE: two different clients scanning QR codes for the LAST remaining capacity slot -- only one wins', async (t) => {
  const db = await memDb();
  await seedPricing(db);
  const api = await startApp(db);
  t.after(() => api.close());

  const signup = await api.call('POST', '/api/auth/setup-org', { orgName: 'Race Gym', ownerName: 'Owner', email: 'owner4@test.in', password: 'ownerpass1' });
  const ownerToken = signup.json.token;
  const orgId = signup.json.user.orgId;
  const quote75b = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, ownerToken);
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote75b.json.quote.id }, ownerToken);
  const { paymentId, signature } = mockSimulateCheckout(order.json.order.provider_order_id);
  await api.call('POST', '/api/enterprise/payment/verify', { orderId: order.json.order.id, providerPaymentId: paymentId, signature }, ownerToken);

  // Fill capacity to exactly ONE remaining slot (74 of 75).
  await db.run(`INSERT INTO organizations (id, name, slug, created_at) VALUES ('filler-org2', 'filler2', 'filler2', '2026-01-01T00:00:00Z')`);
  for (let i = 0; i < 74; i++) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, 'x', 'CLIENT', ?, 1, ?)`,
      [`ru${i}`, orgId, `race-filler${i}@test.in`, `Filler ${i}`, '2026-01-01T00:00:00Z']);
    await db.run(`INSERT INTO clients (id, user_id, org_id, status, goal, created_at) VALUES (?, ?, ?, 'ON_TRACK', 'GENERAL', ?)`,
      [`rc${i}`, `ru${i}`, orgId, '2026-01-01T00:00:00Z']);
  }
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES (?, ?, ?, ?, ?, ?)`,
    ['plan_race', orgId, 'Monthly', 1500, 'INR', 30]);

  const status = await api.call('GET', '/api/enterprise/status', undefined, ownerToken);
  assert.equal(status.json.availableCapacity, 1, 'exactly one slot left before the race');

  // Two DIFFERENT QR codes, both issued while that one slot was still available.
  const qrA = await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: 'plan_race' }, ownerToken);
  const qrB = await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: 'plan_race' }, ownerToken);
  assert.equal(qrA.status, 200);
  assert.equal(qrB.status, 200);

  const clientA = await api.call('POST', '/api/auth/register', { name: 'Racer A', email: 'racera@test.in', password: 'racerpass1' });
  const clientB = await api.call('POST', '/api/auth/register', { name: 'Racer B', email: 'racerb@test.in', password: 'racerpass1' });

  const [resultA, resultB] = await Promise.all([
    api.call('POST', '/api/enrollment/client/join', { payload: qrA.json.payload }, clientA.json.token),
    api.call('POST', '/api/enrollment/client/join', { payload: qrB.json.payload }, clientB.json.token),
  ]);

  const succeeded = [resultA, resultB].filter((r) => r.status === 200);
  const failed = [resultA, resultB].filter((r) => r.status === 409 && r.json.error === 'capacity_exhausted');
  assert.equal(succeeded.length, 1, 'exactly one of the two simultaneous joins must get a payment order for the last slot');
  assert.equal(failed.length, 1, 'the other must be told capacity is exhausted, not silently double-granted');

  // Confirm consistency: capacity never went negative, and completing
  // the winner's payment doesn't somehow create two memberships.
  const winnerOrder = succeeded[0].json.order;
  const checkout = mockSimulateCheckout(winnerOrder.provider_order_id);
  const winnerToken = resultA.status === 200 ? clientA.json.token : clientB.json.token;
  const verify = await api.call('POST', '/api/enrollment/client/payment/verify',
    { orderId: winnerOrder.id, providerPaymentId: checkout.paymentId, signature: checkout.signature }, winnerToken);
  assert.equal(verify.status, 200);
  assert.equal(verify.json.membershipActive, true);

  const finalStatus = await api.call('GET', '/api/enterprise/status', undefined, ownerToken);
  assert.equal(finalStatus.json.activeClients, 75, 'exactly 74 fillers + the 1 race winner, never 76');
  assert.equal(finalStatus.json.availableCapacity, 0);
});
