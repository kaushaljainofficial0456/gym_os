// ============================================================
// HARDENING PASS 2 — billing quotes (price lock + upgrade/downgrade
// proration), client membership renewal, the membership lifecycle
// state machine, and explicit tenant isolation. Reuses the same
// memDb/seedPricing/startApp harness as enterpriseFlow.test.js (kept
// self-contained here rather than imported, matching this test suite's
// existing convention of each file owning its own fixture).
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
    ('p75', '75 Clients', 75, 12000, 'INR', 365, 1, 'active', ?, ?),
    ('p100', '100 Clients', 100, 15000, 'INR', 365, 1, 'active', ?, ?)`,
    [nowIso, nowIso, nowIso, nowIso]);
  await db.run(`INSERT INTO sk_pricing_rules (id, base_package_id, additional_client_rate, max_capacity, version, status, effective_from, created_at) VALUES
    ('r75', 'p75', 155, 200, 1, 'active', ?, ?)`, [nowIso, nowIso]);
  await db.run(`INSERT INTO sk_capacity_addons (id, increment, price, currency, version, status, effective_from, created_at) VALUES
    ('add10', 10, 1800, 'INR', 1, 'active', ?, ?)`, [nowIso, nowIso]);
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const enterpriseRoutes = (await import('../src/routes/enterprise.js')).default;
  const enrollmentRoutes = (await import('../src/routes/enrollment.js')).default;
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/enterprise', enterpriseRoutes(db));
  app.use('/api/enrollment', enrollmentRoutes(db));
  app.use('/api/admin', adminRoutes(db));
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

// Buys+activates a gym package via the real quote -> order -> verify
// flow (never inserts org_subscriptions rows directly) so every test
// below exercises the actual production path.
async function buyPackage(api, ownerToken, capacity) {
  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity }, ownerToken);
  assert.equal(quote.status, 200, JSON.stringify(quote.json));
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, ownerToken);
  assert.equal(order.status, 200, JSON.stringify(order.json));
  const { paymentId, signature } = mockSimulateCheckout(order.json.order.provider_order_id);
  const verify = await api.call('POST', '/api/enterprise/payment/verify', { orderId: order.json.order.id, providerPaymentId: paymentId, signature }, ownerToken);
  assert.equal(verify.status, 200);
  return { quote: quote.json.quote, order: order.json.order };
}

async function setupOwner(api, email, orgName) {
  const signup = await api.call('POST', '/api/auth/setup-org', { orgName, ownerName: 'Owner', email, password: 'ownerpass1' });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  return { token: signup.json.token, orgId: signup.json.user.orgId };
}

test.beforeEach(() => { resetRateLimits(); _resetMockProviderStateForTests(); });

// ---------------------------------------------------------------
// BILLING QUOTES: price lock + single-use consumption
// ---------------------------------------------------------------

test('billing quote: /payment/order rejects raw capacity/price -- only a quoteId is accepted', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerq1@test.in', 'Quote Gym');
  const order = await api.call('POST', '/api/enterprise/payment/order', { capacity: 75 }, owner.token);
  assert.equal(order.status, 422, 'the old raw-capacity shape must be rejected by Zod validation (missing quoteId), not silently priced');
});

test('billing quote: consuming the same quote twice is rejected (second /payment/order call fails)', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerq2@test.in', 'Quote Gym 2');
  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, owner.token);
  const order1 = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, owner.token);
  assert.equal(order1.status, 200);
  const order2 = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, owner.token);
  assert.equal(order2.status, 422);
  assert.equal(order2.json.error, 'quote_already_used');
});

test('billing quote: an expired quote is rejected, never paid against stale numbers', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerq3@test.in', 'Quote Gym 3');
  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, owner.token);
  await db.run(`UPDATE billing_quotes SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?`, [quote.json.quote.id]);
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, owner.token);
  assert.equal(order.status, 422);
  assert.equal(order.json.error, 'quote_expired');
});

// ---------------------------------------------------------------
// UPGRADE / DOWNGRADE
// ---------------------------------------------------------------

test('upgrade quote: 75 -> 100 charges the new price minus a prorated credit for the unused remainder of the current period', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerup1@test.in', 'Upgrade Gym');
  await buyPackage(api, owner.token, 75);

  // Pin the current subscription's period to a fixed, deterministic
  // window (avoids any real-clock timing flakiness in the credit math).
  const sub = await db.q1(`SELECT * FROM org_subscriptions WHERE org_id = ? AND status = 'ACTIVE'`, [owner.orgId]);
  const start = Date.now() - 100 * 86_400_000; // started 100 days ago
  const end = Date.now() + 265 * 86_400_000;   // 265 days remaining (365 total)
  await db.run(`UPDATE org_subscriptions SET start_date = ?, end_date = ? WHERE id = ?`, [new Date(start).toISOString(), new Date(end).toISOString(), sub.id]);

  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_UPGRADE', capacity: 100 }, owner.token);
  assert.equal(quote.status, 200, JSON.stringify(quote.json));
  assert.equal(quote.json.direction, 'upgrade');
  const expectedCredit = Math.round(12000 * (265 / 365) * 100) / 100;
  const expectedTotal = Math.max(0, Math.round((15000 - expectedCredit) * 100) / 100);
  assert.equal(quote.json.quote.credit, expectedCredit);
  assert.equal(quote.json.quote.total, expectedTotal);
  assert.ok(quote.json.quote.total > 0 && quote.json.quote.total < 15000, 'upgrade must never simply charge the full new-package price');

  // Paying it supersedes the old row and activates the new capacity.
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, owner.token);
  const { paymentId, signature } = mockSimulateCheckout(order.json.order.provider_order_id);
  await api.call('POST', '/api/enterprise/payment/verify', { orderId: order.json.order.id, providerPaymentId: paymentId, signature }, owner.token);
  const status = await api.call('GET', '/api/enterprise/status', undefined, owner.token);
  assert.equal(status.json.purchasedCapacity, 100);
});

test('downgrade: blocked outright when active clients exceed the requested capacity', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerdown1@test.in', 'Downgrade Gym');
  await buyPackage(api, owner.token, 100);
  // Seed 80 active clients directly -- exceeds the requested 75.
  for (let i = 0; i < 80; i++) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, 'x', 'CLIENT', ?, 1, ?)`,
      [`du${i}`, owner.orgId, `down-filler${i}@test.in`, `Filler ${i}`, '2026-01-01T00:00:00Z']);
    await db.run(`INSERT INTO clients (id, user_id, org_id, status, goal, created_at) VALUES (?, ?, ?, 'ON_TRACK', 'GENERAL', ?)`,
      [`dc${i}`, `du${i}`, owner.orgId, '2026-01-01T00:00:00Z']);
  }
  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_UPGRADE', capacity: 75 }, owner.token);
  assert.equal(quote.status, 409);
  assert.equal(quote.json.error, 'downgrade_blocked');
  assert.equal(quote.json.activeClients, 80);
  assert.match(quote.json.message, /80 active clients/);
  assert.match(quote.json.message, /cannot downgrade to 75/);
});

test('downgrade: allowed when within the new capacity, and a downgrade fully covered by unused credit activates for free (no payment gateway round-trip)', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerdown2@test.in', 'Downgrade Gym 2');
  await buyPackage(api, owner.token, 100); // Rs 15,000, fresh -- start_date/end_date are ~"today" already, so nearly the full year's credit remains

  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_UPGRADE', capacity: 75 }, owner.token);
  assert.equal(quote.status, 200, JSON.stringify(quote.json));
  assert.equal(quote.json.direction, 'downgrade');
  assert.equal(quote.json.quote.total, 0, 'the almost-full-year credit from the 100-capacity purchase exceeds the 75-capacity price');

  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, owner.token);
  assert.equal(order.status, 200);
  assert.equal(order.json.freeChange, true);
  assert.equal(order.json.order, null, 'zero-amount change never touches the payment gateway');
  assert.equal(order.json.subscription.status, 'ACTIVE', 'activated immediately, not left PENDING_PAYMENT');

  const status = await api.call('GET', '/api/enterprise/status', undefined, owner.token);
  assert.equal(status.json.purchasedCapacity, 75);
});

// ---------------------------------------------------------------
// CLIENT MEMBERSHIP RENEWAL
// ---------------------------------------------------------------

async function joinAsClient(api, owner, db, planId) {
  const qr = await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: planId }, owner.token);
  const clientSignup = await api.call('POST', '/api/auth/register', { name: 'Renewer', email: `renewer-${Date.now()}-${Math.random()}@test.in`, password: 'clientpass1' });
  const join = await api.call('POST', '/api/enrollment/client/join', { payload: qr.json.payload }, clientSignup.json.token);
  const { paymentId, signature } = mockSimulateCheckout(join.json.order.provider_order_id);
  const verify = await api.call('POST', '/api/enrollment/client/payment/verify', { orderId: join.json.order.id, providerPaymentId: paymentId, signature }, clientSignup.json.token);
  return { clientToken: verify.json.token || clientSignup.json.token };
}

test('client renewal: extends from the EXISTING end_date when renewing before expiry (never shortens the membership)', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerrenew1@test.in', 'Renewal Gym');
  await buyPackage(api, owner.token, 75);
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES ('plan_r1', ?, 'Monthly', 1500, 'INR', 30)`, [owner.orgId]);
  const { clientToken } = await joinAsClient(api, owner, db, 'plan_r1');

  const before = await db.q1(`SELECT * FROM subscriptions WHERE org_id = ?`, [owner.orgId]);
  assert.ok(before, 'membership row exists after join+pay');
  const oldEnd = before.end_date;

  const renew = await api.call('POST', '/api/enrollment/client/renew', undefined, clientToken);
  assert.equal(renew.status, 200, JSON.stringify(renew.json));
  const { paymentId, signature } = mockSimulateCheckout(renew.json.order.provider_order_id);
  const verify = await api.call('POST', '/api/enrollment/client/payment/verify', { orderId: renew.json.order.id, providerPaymentId: paymentId, signature }, clientToken);
  assert.equal(verify.status, 200);

  const after = await db.q1('SELECT * FROM subscriptions WHERE id = ?', [before.id]);
  const expectedNewEnd = new Date(Date.parse(oldEnd) + 30 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(after.end_date.slice(0, 10), expectedNewEnd, 'new expiry = OLD expiry + period, not now + period');
});

test('client renewal: an ALREADY EXPIRED membership renews from now, not from the stale old expiry, and reactivates (EXPIRED -> ACTIVE)', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerrenew3@test.in', 'Renewal Gym 3');
  await buyPackage(api, owner.token, 75);
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES ('plan_r3', ?, 'Monthly', 1500, 'INR', 30)`, [owner.orgId]);
  const { clientToken } = await joinAsClient(api, owner, db, 'plan_r3');

  const sub = await db.q1('SELECT * FROM subscriptions WHERE org_id = ?', [owner.orgId]);
  const staleEnd = '2020-01-01T00:00:00.000Z'; // long lapsed
  await db.run(`UPDATE subscriptions SET end_date = ?, status = 'expired', lifecycle_status = 'EXPIRED' WHERE id = ?`, [staleEnd, sub.id]);

  const renew = await api.call('POST', '/api/enrollment/client/renew', undefined, clientToken);
  assert.equal(renew.status, 200);
  const { paymentId, signature } = mockSimulateCheckout(renew.json.order.provider_order_id);
  await api.call('POST', '/api/enrollment/client/payment/verify', { orderId: renew.json.order.id, providerPaymentId: paymentId, signature }, clientToken);

  const after = await db.q1('SELECT * FROM subscriptions WHERE id = ?', [sub.id]);
  assert.equal(after.lifecycle_status, 'ACTIVE', 'EXPIRED -> ACTIVE reactivation');
  assert.equal(after.status, 'active');
  const daysFromNow = Math.round((Date.parse(after.end_date) - Date.now()) / 86_400_000);
  assert.ok(daysFromNow >= 29 && daysFromNow <= 30, `new expiry must be ~30 days from NOW, not from the 2020 stale date (got ${daysFromNow} days out)`);

  const history = await api.call('GET', `/api/admin/members/${(await db.q1('SELECT id FROM clients WHERE org_id = ?', [owner.orgId])).id}/membership/history`, undefined, owner.token);
  assert.ok(history.json.history.some((h) => h.previous_status === 'EXPIRED' && h.new_status === 'ACTIVE' && h.reason === 'renewed_after_expiry'));
});

test('client renewal: a double-click before the first renewal payment resolves reuses the SAME order (idempotent)', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerrenew2@test.in', 'Renewal Gym 2');
  await buyPackage(api, owner.token, 75);
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES ('plan_r2', ?, 'Monthly', 1500, 'INR', 30)`, [owner.orgId]);
  const { clientToken } = await joinAsClient(api, owner, db, 'plan_r2');

  const renew1 = await api.call('POST', '/api/enrollment/client/renew', undefined, clientToken);
  const renew2 = await api.call('POST', '/api/enrollment/client/renew', undefined, clientToken);
  assert.equal(renew1.json.order.id, renew2.json.order.id, 'a double-click must not create two separate renewal orders');
});

// ---------------------------------------------------------------
// MEMBERSHIP LIFECYCLE STATE MACHINE
// ---------------------------------------------------------------

test('membership lifecycle: owner can suspend then resume; an invalid jump (cancel -> resume) is rejected', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerlife1@test.in', 'Lifecycle Gym');
  await buyPackage(api, owner.token, 75);
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES ('plan_l1', ?, 'Monthly', 1500, 'INR', 30)`, [owner.orgId]);
  await joinAsClient(api, owner, db, 'plan_l1');
  const client = await db.q1('SELECT id FROM clients WHERE org_id = ?', [owner.orgId]);

  const suspend = await api.call('POST', `/api/admin/members/${client.id}/membership/suspend`, { reason: 'non-payment' }, owner.token);
  assert.equal(suspend.status, 200, JSON.stringify(suspend.json));
  assert.equal(suspend.json.subscription.lifecycle_status, 'SUSPENDED');
  assert.equal(suspend.json.subscription.status, 'active', 'coarse status column stays in the vocabulary every existing route already understands');

  const resume = await api.call('POST', `/api/admin/members/${client.id}/membership/resume`, undefined, owner.token);
  assert.equal(resume.status, 200);
  assert.equal(resume.json.subscription.lifecycle_status, 'ACTIVE');

  const cancel = await api.call('POST', `/api/admin/members/${client.id}/membership/cancel`, undefined, owner.token);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.subscription.status, 'cancelled');

  const invalidResume = await api.call('POST', `/api/admin/members/${client.id}/membership/resume`, undefined, owner.token);
  assert.equal(invalidResume.status, 409);
  assert.equal(invalidResume.json.error, 'invalid_transition');

  const history = await api.call('GET', `/api/admin/members/${client.id}/membership/history`, undefined, owner.token);
  assert.equal(history.status, 200);
  const transitions = history.json.history.map((h) => `${h.previous_status}->${h.new_status}`);
  assert.deepEqual(transitions, ['ACTIVE->CANCELLED', 'SUSPENDED->ACTIVE', 'ACTIVE->SUSPENDED'], 'newest first, every transition recorded immutably');
});

// ---------------------------------------------------------------
// TENANT ISOLATION (explicit, per the spec's "CRITICAL" callout)
// ---------------------------------------------------------------

test('tenant isolation: Gym A owner cannot suspend, view, or act on Gym B\'s client', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'tenantA@test.in', 'Gym A');
  const ownerB = await setupOwner(api, 'tenantB@test.in', 'Gym B');
  await buyPackage(api, ownerB.token, 75);
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES ('plan_tb', ?, 'Monthly', 1500, 'INR', 30)`, [ownerB.orgId]);
  await joinAsClient(api, ownerB, db, 'plan_tb');
  const bClient = await db.q1('SELECT id FROM clients WHERE org_id = ?', [ownerB.orgId]);

  // A tries to act on B's client directly by id -- must be invisible, not just unauthorized-but-informative.
  const suspend = await api.call('POST', `/api/admin/members/${bClient.id}/membership/suspend`, undefined, ownerA.token);
  assert.equal(suspend.status, 404);

  const history = await api.call('GET', `/api/admin/members/${bClient.id}/membership/history`, undefined, ownerA.token);
  assert.equal(history.status, 404);

  // A's own member list must never include B's client.
  const membersA = await api.call('GET', '/api/admin/members', undefined, ownerA.token);
  assert.equal(membersA.status, 200);
  assert.equal(membersA.json.members.find((m) => m.id === bClient.id), undefined);

  // A's QR list must never include B's tokens, and A cannot revoke B's QR by id.
  const qrB = await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: 'plan_tb' }, ownerB.token);
  const revokeAttempt = await api.call('POST', `/api/enrollment/qr/${qrB.json.id}/revoke`, undefined, ownerA.token);
  // Deliberately a generic 409 (same message as "already consumed/expired"),
  // not a 404 -- the route never confirms OR denies that a token id
  // belongs to someone else, which is itself the tenant-isolation
  // property being tested here (no existence oracle across orgs).
  assert.equal(revokeAttempt.status, 409);
  assert.equal(revokeAttempt.json.error, 'Token cannot be revoked (already consumed, expired, or not found)');
  const stillAvailable = await db.q1(`SELECT status FROM enrollment_tokens WHERE id = ?`, [qrB.json.id]);
  assert.equal(stillAvailable.status, 'AVAILABLE', "Gym B's QR must be completely unaffected by Gym A's attempt");

  // A's own billing status must never reflect B's purchased capacity.
  const statusA = await api.call('GET', '/api/enterprise/status', undefined, ownerA.token);
  assert.equal(statusA.json.purchasedCapacity, 0);
});

// Regression: GET /qr joins enrollment_tokens against packages (for
// membership_plan_name) -- once a real packages row exists for the org
// (both tables have org_id AND status columns), an unqualified WHERE
// clause becomes genuinely ambiguous and SQLite rejects the query
// outright. Caught live in browser verification, not by any earlier
// automated test -- none had a packages row in scope when calling this
// route. See enrollment.js's GET /qr for the fix (every condition now
// prefixed with the enrollment_tokens alias).
test('GET /enrollment/qr does not 500 once the org has a real client-facing membership plan (packages row)', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerqrbug@test.in', 'QR Bug Gym');
  await buyPackage(api, owner.token, 75);
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days, status) VALUES ('plan_qrbug', ?, 'Monthly', 1500, 'INR', 30, 'active')`, [owner.orgId]);
  await api.call('POST', '/api/enrollment/qr/client', { membershipPlanId: 'plan_qrbug' }, owner.token);

  const list = await api.call('GET', '/api/enrollment/qr?purpose=CLIENT', undefined, owner.token);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.json.tokens.length, 1);
  assert.equal(list.json.tokens[0].membership_plan_name, 'Monthly');

  const filteredByStatus = await api.call('GET', '/api/enrollment/qr?status=AVAILABLE', undefined, owner.token);
  assert.equal(filteredByStatus.status, 200, JSON.stringify(filteredByStatus.json));
  assert.equal(filteredByStatus.json.tokens.length, 1);
});
