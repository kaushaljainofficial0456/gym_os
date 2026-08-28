// ============================================================
// ORG PAYMENT REFUNDS -- extends refunds.js's engine (built for
// CLIENT_MEMBERSHIP only) to ORG_PACKAGE and ORG_CAPACITY_ADDON: the
// gym's OWN payments to SK OS, not a client's payment to the gym.
// No schema migration needed -- see refunds.js's own header comment
// and getOrgBillingSnapshot's comment on why the existing 'CANCELLED'
// status value and a join through payment_orders.status are enough.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaymentOrder } from '../src/services/payments/paymentOrders.js';
import { recordCheckoutVerification } from '../src/services/payments/paymentActivation.js';
import { mockSimulateCheckout, _resetMockProviderStateForTests } from '../src/services/payments/paymentProvider.js';
import { initiateRefund } from '../src/services/payments/refunds.js';
import { getOrgBillingSnapshot, reserveCapacitySlot } from '../src/services/enterprise/subscriptionLifecycle.js';

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

const nowIso = '2026-01-01T00:00:00Z';

async function seedOrgActive(db, { orgId = 'o1', capacity = 75, price = 12000 } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, 'Gym', 'gym-' + orgId, nowIso]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES ('admin1', NULL, 'admin1@test.in', 'x', 'SUPER_ADMIN', 'Admin', ?)`, [nowIso]);
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at) VALUES ('pkg1', '75 Clients', ?, ?, 'INR', 365, 1, 'active', ?, ?)`, [capacity, price, nowIso, nowIso]);
  await db.run(`INSERT INTO org_billing_state (org_id, status, updated_at) VALUES (?, 'ACTIVE', ?)`, [orgId, nowIso]);
  const subId = 'osub1';
  await db.run(
    `INSERT INTO org_subscriptions (id, org_id, package_id, client_capacity, price, currency, status, start_date, end_date, created_at, updated_at)
     VALUES (?, ?, 'pkg1', ?, ?, 'INR', 'ACTIVE', ?, '2030-01-01T00:00:00Z', ?, ?)`,
    [subId, orgId, capacity, price, nowIso, nowIso, nowIso]);
  return subId;
}

async function payOrder(db, { subjectType, subjectId, orgId, amount }) {
  const order = await createPaymentOrder(db, { subjectType, subjectId, orgId, amount });
  const { paymentId, signature } = mockSimulateCheckout(order.provider_order_id);
  const result = await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: paymentId, signature });
  assert.equal(result.ok, true);
  return db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
}

test.beforeEach(() => { _resetMockProviderStateForTests(); });

test('ORG_PACKAGE full refund cancels the org subscription and billing state (no schema migration needed)', async () => {
  const db = await memDb();
  const subId = await seedOrgActive(db, { orgId: 'o1', capacity: 75, price: 12000 });
  const order = await payOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: subId, orgId: 'o1', amount: 12000 });
  await db.run(`UPDATE org_subscriptions SET payment_order_id = ? WHERE id = ?`, [order.id, subId]);

  const result = await initiateRefund(db, { orderId: order.id, orgId: 'o1', reason: 'billing dispute', initiatedBy: 'admin1' });
  assert.equal(result.ok, true);
  assert.equal(result.orderStatus, 'REFUNDED');
  assert.equal(result.orgSubscriptionCancelled, true);

  const sub = await db.q1('SELECT status FROM org_subscriptions WHERE id = ?', [subId]);
  assert.equal(sub.status, 'CANCELLED');
  const billing = await db.q1('SELECT status FROM org_billing_state WHERE org_id = ?', ['o1']);
  assert.equal(billing.status, 'CANCELLED');

  const snapshot = await getOrgBillingSnapshot(db, 'o1');
  assert.equal(snapshot.status, 'CANCELLED');
});

test('ORG_PACKAGE partial refund does NOT cancel the subscription (goodwill adjustment, not a revocation)', async () => {
  const db = await memDb();
  const subId = await seedOrgActive(db, { orgId: 'o1', capacity: 75, price: 12000 });
  const order = await payOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: subId, orgId: 'o1', amount: 12000 });
  await db.run(`UPDATE org_subscriptions SET payment_order_id = ? WHERE id = ?`, [order.id, subId]);

  const result = await initiateRefund(db, { orderId: order.id, orgId: 'o1', amount: 2000, initiatedBy: 'admin1' });
  assert.equal(result.ok, true);
  assert.equal(result.orderStatus, 'PARTIALLY_REFUNDED');
  assert.equal(result.orgSubscriptionCancelled, false);

  const sub = await db.q1('SELECT status FROM org_subscriptions WHERE id = ?', [subId]);
  assert.equal(sub.status, 'ACTIVE', 'still active -- a partial refund is a price adjustment, not a cancellation');
});

test('ORG_PACKAGE refund never cancels a NEWER subscription that already superseded the refunded one', async () => {
  const db = await memDb();
  const oldSubId = await seedOrgActive(db, { orgId: 'o1', capacity: 75, price: 12000 });
  const oldOrder = await payOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: oldSubId, orgId: 'o1', amount: 12000 });
  await db.run(`UPDATE org_subscriptions SET payment_order_id = ? WHERE id = ?`, [oldOrder.id, oldSubId]);
  // Owner upgrades: the old row is superseded, a new one becomes ACTIVE
  // (mirrors activateOrgSubscription's own supersede logic).
  await db.run(`UPDATE org_subscriptions SET status = 'SUPERSEDED', updated_at = ? WHERE id = ?`, [nowIso, oldSubId]);
  const newSubId = 'osub2';
  await db.run(
    `INSERT INTO org_subscriptions (id, org_id, package_id, client_capacity, price, currency, status, start_date, end_date, created_at, updated_at)
     VALUES (?, 'o1', 'pkg1', 100, 15000, 'INR', 'ACTIVE', ?, '2030-01-01T00:00:00Z', ?, ?)`,
    [newSubId, nowIso, nowIso, nowIso]);

  // Now refund the OLD (already-superseded) order.
  const result = await initiateRefund(db, { orderId: oldOrder.id, orgId: 'o1', initiatedBy: 'admin1' });
  assert.equal(result.ok, true);
  assert.equal(result.orgSubscriptionCancelled, false, 'nothing to cancel -- this order\'s own subscription row is already superseded, not active');

  const newSub = await db.q1('SELECT status FROM org_subscriptions WHERE id = ?', [newSubId]);
  assert.equal(newSub.status, 'ACTIVE', 'the CURRENT subscription (paid for by a different order) must never be touched by refunding an old one');
});

test('ORG_CAPACITY_ADDON: a fully refunded add-on purchase is excluded from purchased capacity -- no status flip needed', async () => {
  const db = await memDb();
  const subId = await seedOrgActive(db, { orgId: 'o1', capacity: 75, price: 12000 });
  const addonOrder = await payOrder(db, { subjectType: 'ORG_CAPACITY_ADDON', subjectId: 'addon-purchase-1', orgId: 'o1', amount: 1800 });
  await db.run(
    `INSERT INTO org_capacity_purchases (id, org_id, subscription_id, increment, price, currency, payment_order_id, created_at)
     VALUES ('addon-purchase-1', 'o1', ?, 10, 1800, 'INR', ?, ?)`, [subId, addonOrder.id, nowIso]);

  let snapshot = await getOrgBillingSnapshot(db, 'o1');
  assert.equal(snapshot.purchasedCapacity, 85, '75 base + 10 add-on before any refund');

  const result = await initiateRefund(db, { orderId: addonOrder.id, orgId: 'o1', initiatedBy: 'admin1' });
  assert.equal(result.ok, true);
  assert.equal(result.orderStatus, 'REFUNDED');

  snapshot = await getOrgBillingSnapshot(db, 'o1');
  assert.equal(snapshot.purchasedCapacity, 75, 'the refunded 10 no longer counts -- back to just the base package');

  // reserveCapacitySlot's own independent SQL computation must agree --
  // fill exactly 75 clients (the correct post-refund ceiling) and
  // confirm the 76th reservation is refused.
  for (let i = 0; i < 75; i++) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, 'o1', ?, 'x', 'CLIENT', ?, 1, ?)`, [`u${i}`, `u${i}@test.in`, `U ${i}`, nowIso]);
    await db.run(`INSERT INTO clients (id, user_id, org_id, status, goal, created_at) VALUES (?, ?, 'o1', 'ON_TRACK', 'GENERAL', ?)`, [`c${i}`, `u${i}`, nowIso]);
  }
  const reserved = await reserveCapacitySlot(db, 'o1');
  assert.equal(reserved, false, 'no room left post-refund -- if the refund exclusion were missing here too, this would wrongly succeed at slot 76/85');
});

test('ORG_CAPACITY_ADDON: a PARTIAL refund of an add-on purchase does NOT remove it from capacity', async () => {
  const db = await memDb();
  const subId = await seedOrgActive(db, { orgId: 'o1', capacity: 75, price: 12000 });
  const addonOrder = await payOrder(db, { subjectType: 'ORG_CAPACITY_ADDON', subjectId: 'addon-purchase-1', orgId: 'o1', amount: 1800 });
  await db.run(
    `INSERT INTO org_capacity_purchases (id, org_id, subscription_id, increment, price, currency, payment_order_id, created_at)
     VALUES ('addon-purchase-1', 'o1', ?, 10, 1800, 'INR', ?, ?)`, [subId, addonOrder.id, nowIso]);

  const result = await initiateRefund(db, { orderId: addonOrder.id, orgId: 'o1', amount: 500, initiatedBy: 'admin1' });
  assert.equal(result.ok, true);
  assert.equal(result.orderStatus, 'PARTIALLY_REFUNDED');

  const snapshot = await getOrgBillingSnapshot(db, 'o1');
  assert.equal(snapshot.purchasedCapacity, 85, 'a partial refund is a price adjustment -- the 10-client increment is still fully in effect');
});
