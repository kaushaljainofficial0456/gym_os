// ============================================================
// Refund engine -- full/partial refunds against a payment_order, and
// their deterministic effect on the CLIENT_MEMBERSHIP transition graph.
// See services/payments/refunds.js's own header comment for scope
// (CLIENT_MEMBERSHIP only, for now) and the amount/currency-never-
// mutated design.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaymentOrder } from '../src/services/payments/paymentOrders.js';
import { recordCheckoutVerification } from '../src/services/payments/paymentActivation.js';
import { mockSimulateCheckout, _resetMockProviderStateForTests } from '../src/services/payments/paymentProvider.js';
import { initiateRefund, remainingRefundable, listRefunds } from '../src/services/payments/refunds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // lifecycle_status is an ADDITIVE column applied via init-db.js's
  // guarded MIGRATIONS list, not part of the base schema.sql -- other
  // test files (e.g. hardeningPass2.test.js) apply it the same way.
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

async function seedOrg(db, id = 'o1') {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [id, 'Gym ' + id, 'gym-' + id, '2026-01-01T00:00:00Z']);
}

async function seedUser(db, { id, orgId, role = 'CLIENT', email }) {
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, 'x', ?, 'Test User', ?)`,
    [id, orgId, email, role, '2026-01-01T00:00:00Z']);
}

async function seedClient(db, { id, userId, orgId }) {
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?, ?, ?, ?)', [id, userId, orgId, '2026-01-01T00:00:00Z']);
}

async function seedSubscription(db, { id, orgId, clientId, amount, lifecycle = 'ACTIVE' }) {
  await db.run(
    `INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, start_date, end_date, lifecycle_status)
     VALUES (?, ?, ?, 'Monthly', ?, '2026-01-01', '2026-02-01', ?)`,
    [id, orgId, clientId, amount, lifecycle]);
}

test.beforeEach(() => { _resetMockProviderStateForTests(); });

/** Renewal-shaped order: client_id set directly at creation, exactly
 *  like /client/renew does. */
async function seedPaidRenewalOrder(db, { orgId, clientId, amount }) {
  const order = await createPaymentOrder(db, { subjectType: 'CLIENT_MEMBERSHIP', subjectId: 'sub-placeholder', orgId, clientId, amount });
  const { paymentId, signature } = mockSimulateCheckout(order.provider_order_id);
  const result = await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: paymentId, signature });
  assert.equal(result.ok, true);
  return db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
}

test('initiateRefund: a full refund marks the order REFUNDED and completes the membership REFUND_PENDING -> REFUNDED transition', async () => {
  const db = await memDb();
  await seedOrg(db);
  await seedUser(db, { id: 'u1', orgId: 'o1', email: 'c1@test.com' });
  await seedClient(db, { id: 'cli1', userId: 'u1', orgId: 'o1' });
  await seedSubscription(db, { id: 'sub1', orgId: 'o1', clientId: 'cli1', amount: 1500 });
  const order = await seedPaidRenewalOrder(db, { orgId: 'o1', clientId: 'cli1', amount: 1500 });

  const result = await initiateRefund(db, { orderId: order.id, orgId: 'o1', reason: 'client requested', initiatedBy: 'u1' });
  assert.equal(result.ok, true);
  assert.equal(result.refund.status, 'SUCCESS');
  assert.equal(result.refund.type, 'FULL');
  assert.equal(result.orderStatus, 'REFUNDED');
  assert.equal(result.membership.lifecycle_status, 'REFUNDED');

  const orderRow = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(orderRow.status, 'REFUNDED');
  assert.equal(orderRow.amount, 1500, 'the original order amount is never mutated by a refund');

  const history = await db.q('SELECT * FROM membership_status_history WHERE subscription_id = ? ORDER BY created_at', ['sub1']);
  assert.deepEqual(history.map((h) => h.new_status), ['REFUND_PENDING', 'REFUNDED'], 'both graph edges are used, not a shortcut write');
});

test('initiateRefund: a partial refund leaves the membership ACTIVE and the order PARTIALLY_REFUNDED', async () => {
  const db = await memDb();
  await seedOrg(db);
  await seedUser(db, { id: 'u1', orgId: 'o1', email: 'c1@test.com' });
  await seedClient(db, { id: 'cli1', userId: 'u1', orgId: 'o1' });
  await seedSubscription(db, { id: 'sub1', orgId: 'o1', clientId: 'cli1', amount: 1500 });
  const order = await seedPaidRenewalOrder(db, { orgId: 'o1', clientId: 'cli1', amount: 1500 });

  const result = await initiateRefund(db, { orderId: order.id, orgId: 'o1', amount: 500, initiatedBy: 'u1' });
  assert.equal(result.ok, true);
  assert.equal(result.refund.type, 'PARTIAL');
  assert.equal(result.orderStatus, 'PARTIALLY_REFUNDED');
  assert.equal(result.membership, null, 'a partial refund must never terminate the membership');

  const sub = await db.q1('SELECT * FROM subscriptions WHERE id = ?', ['sub1']);
  assert.equal(sub.lifecycle_status, 'ACTIVE');
});

test('initiateRefund: two partial refunds that together exhaust the order finish it as REFUNDED', async () => {
  const db = await memDb();
  await seedOrg(db);
  await seedUser(db, { id: 'u1', orgId: 'o1', email: 'c1@test.com' });
  await seedClient(db, { id: 'cli1', userId: 'u1', orgId: 'o1' });
  await seedSubscription(db, { id: 'sub1', orgId: 'o1', clientId: 'cli1', amount: 1000 });
  const order = await seedPaidRenewalOrder(db, { orgId: 'o1', clientId: 'cli1', amount: 1000 });

  const first = await initiateRefund(db, { orderId: order.id, orgId: 'o1', amount: 400, initiatedBy: 'u1' });
  assert.equal(first.orderStatus, 'PARTIALLY_REFUNDED');
  const second = await initiateRefund(db, { orderId: order.id, orgId: 'o1', amount: 600, initiatedBy: 'u1' });
  assert.equal(second.orderStatus, 'REFUNDED');
  assert.equal(second.membership.lifecycle_status, 'REFUNDED');

  const refunds = await listRefunds(db, { orgId: 'o1', orderId: order.id });
  assert.equal(refunds.length, 2);
});

test('initiateRefund: refunding more than the remaining refundable amount is rejected outright', async () => {
  const db = await memDb();
  await seedOrg(db);
  await seedUser(db, { id: 'u1', orgId: 'o1', email: 'c1@test.com' });
  await seedClient(db, { id: 'cli1', userId: 'u1', orgId: 'o1' });
  await seedSubscription(db, { id: 'sub1', orgId: 'o1', clientId: 'cli1', amount: 1000 });
  const order = await seedPaidRenewalOrder(db, { orgId: 'o1', clientId: 'cli1', amount: 1000 });

  await initiateRefund(db, { orderId: order.id, orgId: 'o1', amount: 700, initiatedBy: 'u1' });
  const overRefund = await initiateRefund(db, { orderId: order.id, orgId: 'o1', amount: 400, initiatedBy: 'u1' });
  assert.equal(overRefund.ok, false);
  assert.equal(overRefund.reason, 'exceeds_remaining_refundable');
  assert.equal(overRefund.remaining, 300);

  const state = await remainingRefundable(db, order.id);
  assert.equal(state.refunded, 700);
  assert.equal(state.remaining, 300);
});

test('initiateRefund: an order that never actually succeeded cannot be refunded', async () => {
  const db = await memDb();
  await seedOrg(db);
  await seedUser(db, { id: 'u1', orgId: 'o1', email: 'c1@test.com' });
  await seedClient(db, { id: 'cli1', userId: 'u1', orgId: 'o1' });
  const order = await createPaymentOrder(db, { subjectType: 'CLIENT_MEMBERSHIP', subjectId: 'sub-placeholder', orgId: 'o1', clientId: 'cli1', amount: 1000 });
  // Never completed checkout -- order stays CREATED.

  const result = await initiateRefund(db, { orderId: order.id, orgId: 'o1', initiatedBy: 'u1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'order_not_refundable');
});

test('initiateRefund: resolves the client through enrollment_tokens for a fresh-join order (client_id NULL at creation)', async () => {
  const db = await memDb();
  await seedOrg(db);
  await seedUser(db, { id: 'owner1', orgId: 'o1', role: 'GYM_OWNER', email: 'owner@test.com' });
  await seedUser(db, { id: 'u1', orgId: 'o1', email: 'c1@test.com' });
  await seedClient(db, { id: 'cli1', userId: 'u1', orgId: 'o1' });
  await seedSubscription(db, { id: 'sub1', orgId: 'o1', clientId: 'cli1', amount: 1500 });
  await db.run(
    `INSERT INTO enrollment_tokens (id, org_id, created_by, purpose, token_hash, status, expires_at, consumed_by, consumed_at, created_at)
     VALUES ('enr1', 'o1', 'owner1', 'CLIENT', 'hash1', 'CONSUMED', '2026-12-01T00:00:00Z', 'u1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  // A fresh join's order has client_id NULL, exactly like enrollment.js's
  // /client/join route creates it -- resolveClientForOrder must fall
  // back to enrollment_tokens.consumed_by -> clients.user_id.
  const order = await createPaymentOrder(db, { subjectType: 'CLIENT_MEMBERSHIP', subjectId: 'enr1', orgId: 'o1', amount: 1500 });
  const { paymentId, signature } = mockSimulateCheckout(order.provider_order_id);
  await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: paymentId, signature });

  const result = await initiateRefund(db, { orderId: order.id, orgId: 'o1', initiatedBy: 'owner1' });
  assert.equal(result.ok, true);
  assert.equal(result.refund.client_id, 'cli1', 'the client is correctly resolved via the enrollment token, not order.client_id');
  assert.equal(result.membership.lifecycle_status, 'REFUNDED');
});
