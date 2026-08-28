// ============================================================
// Generic payment engine (payment_orders -> payment_transactions ->
// payment_events), tested entirely against the mock provider -- this
// IS the real business logic, not a stand-in for it (see
// paymentProvider.js's own header comment). Covers: idempotent order
// creation, checkout-signature verification, webhook idempotency
// (including the spec's explicit "two payment webhooks arriving
// simultaneously" scenario), amount/currency-mismatch detection, and
// activation-callback dispatch.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaymentOrder } from '../src/services/payments/paymentOrders.js';
import {
  registerActivationHandler, recordCheckoutVerification, recordWebhookEvent,
} from '../src/services/payments/paymentActivation.js';
import {
  mockSimulateCheckout, mockBuildWebhookEvent, _resetMockProviderStateForTests,
} from '../src/services/payments/paymentProvider.js';

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

async function seedOrg(db, id = 'o1') {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [id, 'Gym ' + id, 'gym-' + id, '2026-01-01T00:00:00Z']);
}

test.beforeEach(() => { _resetMockProviderStateForTests(); });

test('createPaymentOrder: creates a real payment_orders row + a mock provider order', async () => {
  const db = await memDb();
  await seedOrg(db);
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000, currency: 'INR' });
  assert.equal(order.status, 'CREATED');
  assert.equal(order.amount, 12000);
  assert.ok(order.provider_order_id?.startsWith('mock_order_'));
});

test('createPaymentOrder: idempotency_key prevents a duplicate order on retry', async () => {
  const db = await memDb();
  await seedOrg(db);
  const first = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000, idempotencyKey: 'retry-key-1' });
  const second = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000, idempotencyKey: 'retry-key-1' });
  assert.equal(first.id, second.id, 'a retried request with the same idempotency key returns the SAME order, never a second one');
  const rows = await db.q('SELECT * FROM payment_orders WHERE idempotency_key = ?', ['retry-key-1']);
  assert.equal(rows.length, 1);
});

test('createPaymentOrder: rejects a non-positive amount outright', async () => {
  const db = await memDb();
  await seedOrg(db);
  await assert.rejects(() => createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 0 }));
  await assert.rejects(() => createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: -100 }));
});

test('recordCheckoutVerification: a valid signature activates exactly once', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('ORG_PACKAGE', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  const { paymentId, signature } = mockSimulateCheckout(order.provider_order_id);

  const result = await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: paymentId, signature });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyFinalized, false);
  assert.equal(activated, 1);

  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'SUCCESS');
});

test('recordCheckoutVerification: a tampered/wrong signature is rejected, never activates', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('ORG_PACKAGE', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  const { paymentId } = mockSimulateCheckout(order.provider_order_id);

  const result = await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: paymentId, signature: 'deadbeef'.repeat(8) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_signature');
  assert.equal(activated, 0);
  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'CREATED', 'must stay unactivated');
});

test('recordWebhookEvent: a valid payment.captured webhook activates the order', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('CLIENT_MEMBERSHIP', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'CLIENT_MEMBERSHIP', subjectId: 'enr1', orgId: 'o1', amount: 1500 });
  mockSimulateCheckout(order.provider_order_id);
  const { body, signature } = mockBuildWebhookEvent(order.provider_order_id);

  const result = await recordWebhookEvent(db, { rawBody: body, signature });
  assert.equal(result.ok, true);
  assert.equal(activated, 1);
  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'SUCCESS');
});

test('recordWebhookEvent: the SAME webhook delivered TWICE never double-activates (duplicate delivery)', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('CLIENT_MEMBERSHIP', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'CLIENT_MEMBERSHIP', subjectId: 'enr1', orgId: 'o1', amount: 1500 });
  mockSimulateCheckout(order.provider_order_id);
  const { body, signature } = mockBuildWebhookEvent(order.provider_order_id);

  const first = await recordWebhookEvent(db, { rawBody: body, signature });
  const second = await recordWebhookEvent(db, { rawBody: body, signature });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true, 'the second identical delivery must be recognized as a duplicate');
  assert.equal(activated, 1, 'activation must have run exactly once despite two deliveries');
});

test('recordWebhookEvent: TWO SIMULTANEOUS webhook deliveries for the same event race safely -- activation still runs exactly once', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('CLIENT_MEMBERSHIP', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'CLIENT_MEMBERSHIP', subjectId: 'enr1', orgId: 'o1', amount: 1500 });
  mockSimulateCheckout(order.provider_order_id);
  const { body, signature } = mockBuildWebhookEvent(order.provider_order_id);

  const [a, b] = await Promise.all([
    recordWebhookEvent(db, { rawBody: body, signature }),
    recordWebhookEvent(db, { rawBody: body, signature }),
  ]);
  assert.ok(a.ok && b.ok);
  const duplicates = [a, b].filter((r) => r.duplicate);
  assert.equal(duplicates.length, 1, 'exactly one of the two simultaneous deliveries must be recognized as the duplicate');
  assert.equal(activated, 1, 'activation must never run twice, race or not');
});

test('checkout-return arrives first, webhook confirms the SAME order afterward -- activation still runs exactly once', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('ORG_PACKAGE', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  const { paymentId, signature } = mockSimulateCheckout(order.provider_order_id);

  const checkoutResult = await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: paymentId, signature });
  const { body, signature: webhookSig } = mockBuildWebhookEvent(order.provider_order_id);
  const webhookResult = await recordWebhookEvent(db, { rawBody: body, signature: webhookSig });

  assert.equal(checkoutResult.ok, true);
  assert.equal(checkoutResult.alreadyFinalized, false, 'checkout-return is the FIRST to finalize');
  assert.equal(webhookResult.ok, true);
  assert.equal(webhookResult.alreadyFinalized, true, 'the webhook arriving after must recognize the order is already finalized');
  assert.equal(activated, 1, 'activation ran exactly once, from whichever channel arrived first');
});

test('a webhook reporting a mismatched amount is flagged DISPUTED, never activated', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('ORG_PACKAGE', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  mockSimulateCheckout(order.provider_order_id);
  const { body, signature } = mockBuildWebhookEvent(order.provider_order_id);
  // Tamper the webhook body's reported amount AFTER signing would be
  // impossible for a real attacker (the signature covers the raw body),
  // so simulate the more realistic case instead: the order's own
  // server-recorded amount silently drifted from what was actually
  // charged (e.g. a race with a price change). Assert directly against
  // the order row to prove the mismatch path, independent of how it
  // was triggered.
  await db.run(`UPDATE payment_orders SET amount = 99999 WHERE id = ?`, [order.id]);

  const result = await recordWebhookEvent(db, { rawBody: body, signature });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'amount_or_currency_mismatch');
  assert.equal(activated, 0, 'a mismatched payment must never activate anything');
  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'DISPUTED');
});

test('recordWebhookEvent: an unrecognized event type is a graceful no-op, never a crash', async () => {
  const db = await memDb();
  await seedOrg(db);
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  mockSimulateCheckout(order.provider_order_id);
  const { body, signature } = mockBuildWebhookEvent(order.provider_order_id, { eventType: 'some.unrecognized.event' });
  const result = await recordWebhookEvent(db, { rawBody: body, signature });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unrecognized_event_type');
});

test('recordWebhookEvent: a bad signature is rejected before any event is even logged', async () => {
  const db = await memDb();
  await seedOrg(db);
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  mockSimulateCheckout(order.provider_order_id);
  const { body } = mockBuildWebhookEvent(order.provider_order_id);
  const result = await recordWebhookEvent(db, { rawBody: body, signature: 'not-a-real-signature' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_webhook_signature');
  const events = await db.q('SELECT * FROM payment_events');
  assert.equal(events.length, 0, 'an unverified webhook must never even be logged as a real event');
});

test('a failed payment (payment.failed webhook) marks the order FAILED, never activates', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('ORG_PACKAGE', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  mockSimulateCheckout(order.provider_order_id, { outcome: 'failure' });
  const { body, signature } = mockBuildWebhookEvent(order.provider_order_id, { eventType: 'payment.failed' });
  const result = await recordWebhookEvent(db, { rawBody: body, signature });
  assert.equal(result.ok, true);
  assert.equal(activated, 0);
  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'FAILED');
});

test('recordWebhookEvent: a malformed (non-JSON) body is reported, never thrown, never logged', async () => {
  const db = await memDb();
  await seedOrg(db);
  const rawBody = 'not-json-at-all';
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'mock-webhook-secret';
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const result = await recordWebhookEvent(db, { rawBody, signature });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'malformed_webhook_payload');
  const events = await db.q('SELECT * FROM payment_events');
  assert.equal(events.length, 0, 'a malformed payload never gets logged as a real event');
});

test('recordWebhookEvent: a delivery whose activation handler crashes is retryable once stale, but not before (payment recovery)', async () => {
  const db = await memDb();
  await seedOrg(db);
  let attempts = 0;
  registerActivationHandler('CLIENT_MEMBERSHIP', async () => {
    attempts++;
    if (attempts === 1) throw new Error('simulated activation crash');
  });
  const order = await createPaymentOrder(db, { subjectType: 'CLIENT_MEMBERSHIP', subjectId: 'enr1', orgId: 'o1', amount: 1500 });
  mockSimulateCheckout(order.provider_order_id);
  const { body, signature } = mockBuildWebhookEvent(order.provider_order_id);

  // First delivery: activation handler throws -- the whole finalize
  // transaction (status flip to SUCCESS included) rolls back with it.
  // The provider genuinely got charged; SK OS must not look like it
  // never happened, and must not be stuck that way forever.
  await assert.rejects(() => recordWebhookEvent(db, { rawBody: body, signature }));
  let row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.notEqual(row.status, 'SUCCESS', 'a crashed activation must not leave the order looking successful');
  let events = await db.q('SELECT * FROM payment_events');
  assert.equal(events.length, 1);
  assert.equal(events[0].processed_at, null, 'processed_at stays NULL after a crash -- this is what makes a retry possible');

  // An immediate redelivery (well within the staleness window) must
  // still be treated as an in-flight duplicate, not retried yet -- this
  // is what keeps the genuinely-concurrent-duplicate scenario safe
  // (see the "TWO SIMULTANEOUS" test above).
  const immediateRetry = await recordWebhookEvent(db, { rawBody: body, signature });
  assert.equal(immediateRetry.ok, true);
  assert.equal(immediateRetry.duplicate, true);
  assert.equal(attempts, 1, 'an immediate redelivery must not re-attempt activation yet');

  // Simulate real time passing (the provider's own retry, minutes/hours
  // later) by backdating the logged event past the staleness threshold.
  await db.run(`UPDATE payment_events SET created_at = ? WHERE order_id = ?`, ['2020-01-01T00:00:00Z', order.id]);

  const staleRetry = await recordWebhookEvent(db, { rawBody: body, signature });
  assert.equal(staleRetry.ok, true);
  assert.equal(staleRetry.alreadyFinalized, false);
  assert.equal(attempts, 2, 'a stale (crashed) delivery must be re-attempted');
  row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'SUCCESS');
  events = await db.q('SELECT * FROM payment_events');
  assert.equal(events.length, 1, 'the SAME event row is reused across retries, never duplicated');
  assert.ok(events[0].processed_at, 'processed_at is finally stamped once activation actually succeeds');
});
