// ============================================================
// PAYMENT PROVIDER ABSTRACTION — mock (default, zero-risk) | razorpay.
//
// Same shape as src/services/intelligence/aiProvider.js's zero-cost gate,
// deliberately: without real credentials configured, the system can
// NEVER accidentally move real money, the same way it can never
// accidentally bill a paid AI provider. `PAYMENT_PROVIDER=razorpay`
// alone has NO effect without both RAZORPAY_KEY_ID and
// RAZORPAY_KEY_SECRET also being set -- an incomplete config silently
// (and loudly, via providerName()) falls back to mock rather than
// half-configuring a live integration.
//
// The 'mock' provider is not a stub to delete later -- it is how the
// ENTIRE order -> transaction -> webhook -> membership-activation flow
// gets built and tested for real, deterministically, before any real
// gateway credentials exist. See test/payments/*.test.js. Once real
// Razorpay test-mode keys are available, ONE additional live smoke test
// (scripts/payment-smoke.js, matching food-ai-smoke.js's pattern)
// exercises the real API -- nothing about the business logic above this
// module needs to change to make that swap.
//
// RAZORPAY SHAPE: implemented directly from Razorpay's public API docs
// (order creation: POST /v1/orders; checkout-return verification:
// HMAC-SHA256(order_id + '|' + payment_id, key_secret); webhook
// verification: HMAC-SHA256(raw_body, webhook_secret) in the
// X-Razorpay-Signature header). NOT YET LIVE-TESTED against the real
// API -- that requires real credentials this session does not have. Do
// not treat the razorpay path as verified until scripts/payment-smoke.js
// has actually been run against it once real keys exist.
// ============================================================

import crypto from 'node:crypto';

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const REQUESTED_PROVIDER = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

export function providerName() {
  if (REQUESTED_PROVIDER === 'razorpay' && RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) return 'razorpay';
  return 'mock';
}

export function isLiveProviderConfigured() {
  return !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

export function paymentConfigSummary() {
  return {
    provider: providerName(),
    requested: REQUESTED_PROVIDER,
    liveConfigured: isLiveProviderConfigured(),
    webhookSecretConfigured: !!RAZORPAY_WEBHOOK_SECRET,
  };
}

/* ------------------------------------------------------------------ */
/*  Mock provider — deterministic, in-process, no network call ever    */
/* ------------------------------------------------------------------ */

// In-memory only, by design: the mock provider exists purely to make
// the SK OS side of the flow (order/transaction/webhook/activation)
// testable without a real gateway. It is never the source of truth for
// anything durable -- payment_orders/payment_transactions in the DB are.
const _mockOrders = new Map(); // providerOrderId -> { amount, currency, status }

function mockOrderId() {
  return 'mock_order_' + crypto.randomBytes(8).toString('hex');
}
function mockPaymentId() {
  return 'mock_pay_' + crypto.randomBytes(8).toString('hex');
}
function mockSign(orderId, paymentId) {
  // Mirrors Razorpay's own signature formula so verifyCheckoutSignature
  // below is IDENTICAL code for both providers -- only the secret and
  // the two id namespaces differ.
  return crypto.createHmac('sha256', RAZORPAY_KEY_SECRET || 'mock-secret').update(`${orderId}|${paymentId}`).digest('hex');
}

async function mockCreateOrder({ amount, currency, receipt }) {
  const providerOrderId = mockOrderId();
  // Stored in the smallest-currency-unit (paise for INR), exactly like
  // razorpayCreateOrder's real request body -- this is what makes
  // mockBuildWebhookEvent's payload byte-for-byte the same SHAPE a real
  // webhook would have, so parseWebhookPayload's single /100 conversion
  // is correct for both providers rather than needing a mock-specific
  // branch. Storing rupees here instead was a real bug this test suite
  // caught: every mock webhook produced a false-positive amount
  // mismatch, because the shared parser always divides by 100.
  _mockOrders.set(providerOrderId, { amount: Math.round(amount * 100), currency, status: 'created', receipt });
  return { providerOrderId, status: 'CREATED' };
}

/** Simulates the gateway completing a checkout -- returns the
 *  { paymentId, signature } a real checkout would hand back to the
 *  frontend, for exercising the full verify path end to end without a
 *  browser or real gateway. `outcome` lets a caller simulate success or
 *  failure without needing a second code path. Used by the test suite
 *  directly, AND (only while providerName() === 'mock') by
 *  routes/paymentsDev.js's POST /mock/complete, the one browser-callable
 *  stand-in for a real gateway's checkout widget in local/dev use --
 *  see that file's header comment for why this is safe. */
export function mockSimulateCheckout(providerOrderId, { outcome = 'success' } = {}) {
  const order = _mockOrders.get(providerOrderId);
  if (!order) throw new Error(`mockSimulateCheckout: unknown order ${providerOrderId}`);
  if (outcome !== 'success') {
    order.status = 'failed';
    return { paymentId: null, signature: null, failed: true };
  }
  const paymentId = mockPaymentId();
  order.status = 'paid';
  order.paymentId = paymentId;
  return { paymentId, signature: mockSign(providerOrderId, paymentId) };
}

/** TEST-ONLY: builds a webhook payload + valid signature exactly as the
 *  real provider would deliver one, so payment_events/webhook-handling
 *  code can be tested against a realistic shape. */
export function mockBuildWebhookEvent(providerOrderId, { eventType = 'payment.captured' } = {}) {
  const order = _mockOrders.get(providerOrderId);
  if (!order) throw new Error(`mockBuildWebhookEvent: unknown order ${providerOrderId}`);
  const providerEventId = 'mock_evt_' + crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({
    event: eventType,
    payload: {
      payment: { entity: { id: order.paymentId || mockPaymentId(), order_id: providerOrderId, amount: order.amount, currency: order.currency, status: eventType === 'payment.failed' ? 'failed' : 'captured' } },
      order: { entity: { id: providerOrderId, amount: order.amount, currency: order.currency } },
    },
  });
  const signature = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET || 'mock-webhook-secret').update(body).digest('hex');
  return { providerEventId, body, signature };
}

/* ------------------------------------------------------------------ */
/*  Razorpay provider — real API shape, gated behind PAYMENT_PROVIDER=
    razorpay + both real keys. Order creation is LIVE-TESTED against
    Razorpay's real TEST-mode Orders API (see scripts/payment-smoke.js,
    run 2026-08-26 -- confirmed a real order_id back). Checkout-widget
    completion and webhook delivery are NOT live-tested -- those need a
    real browser session (PaymentCheckout.jsx) and a webhook URL
    registered in the Razorpay dashboard, neither of which an
    unattended script can drive.                                      */
/* ------------------------------------------------------------------ */

async function razorpayCreateOrder({ amount, currency, receipt, notes }) {
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    // Razorpay wants amount in the smallest currency unit (paise for INR).
    body: JSON.stringify({ amount: Math.round(amount * 100), currency, receipt, notes: notes || {} }),
  });
  if (!res.ok) throw new Error(`razorpay order creation ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { providerOrderId: data.id, status: 'CREATED' };
}

/** Fetches an order's LATEST payment attempt from the gateway itself. */
async function razorpayFetchOrderStatus(providerOrderId) {
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1/orders/${providerOrderId}/payments`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error(`razorpay order-status fetch ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const payments = data.items || [];
  if (!payments.length) return { found: true, status: 'CREATED', amount: null, currency: null, providerPaymentId: null };
  // Razorpay returns payment attempts oldest-first -- the last item is
  // the most recent attempt, which is the order's current truth.
  const latest = payments[payments.length - 1];
  const statusMap = { created: 'CREATED', authorized: 'PROCESSING', captured: 'SUCCESS', failed: 'FAILED', refunded: 'REFUNDED' };
  return {
    found: true,
    status: statusMap[latest.status] || null,
    amount: latest.amount != null ? latest.amount / 100 : null,
    currency: latest.currency || null,
    providerPaymentId: latest.id,
  };
}

function mockFetchOrderStatus(providerOrderId) {
  const order = _mockOrders.get(providerOrderId);
  if (!order) return { found: false };
  const statusMap = { created: 'CREATED', paid: 'SUCCESS', failed: 'FAILED' };
  return {
    found: true,
    status: statusMap[order.status] || null,
    amount: order.amount != null ? order.amount / 100 : null,
    currency: order.currency || null,
    providerPaymentId: order.paymentId || null,
  };
}

async function razorpayRefundPayment({ providerPaymentId, amount, notes }) {
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const body = { notes: notes || {} };
  if (amount != null) body.amount = Math.round(amount * 100); // omitted entirely = full refund of whatever remains captured
  const res = await fetch(`https://api.razorpay.com/v1/payments/${providerPaymentId}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`razorpay refund ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { providerRefundId: data.id, status: data.status === 'processed' ? 'SUCCESS' : 'PROCESSING' };
}

function mockRefundPayment({ providerPaymentId }) {
  if (!providerPaymentId) throw new Error('mockRefundPayment: providerPaymentId required');
  return { providerRefundId: 'mock_rfnd_' + crypto.randomBytes(8).toString('hex'), status: 'SUCCESS' };
}

/* ------------------------------------------------------------------ */
/*  Public, provider-agnostic API                                      */
/* ------------------------------------------------------------------ */

/** Fetches the gateway's own view of an order's payment status --
 *  independent of anything SK OS has stored. Used ONLY by the
 *  reconciliation sweep (services/payments/reconciliation.js) to detect
 *  drift between what we believe happened and what the provider
 *  actually recorded -- never used to activate anything directly (only
 *  a verified webhook/checkout-signature does that; see
 *  paymentActivation.js's own header comment on why). */
export async function fetchProviderOrderStatus(providerOrderId) {
  return providerName() === 'razorpay' ? razorpayFetchOrderStatus(providerOrderId) : mockFetchOrderStatus(providerOrderId);
}

/** Issues a refund against a captured payment at the gateway. `amount`
 *  is in RUPEES (converted to paise for Razorpay internally, matching
 *  every other amount in this file) -- omit for a full refund of
 *  whatever remains captured. Returns { providerRefundId, status }. */
export async function refundProviderPayment({ providerPaymentId, amount, notes }) {
  return providerName() === 'razorpay' ? razorpayRefundPayment({ providerPaymentId, amount, notes }) : mockRefundPayment({ providerPaymentId, amount });
}

/** Creates a gateway order. Caller MUST have already resolved amount/
 *  currency SERVER-SIDE (see paymentOrders.js) -- this function trusts
 *  whatever it's given, so it must never be called with client-supplied
 *  amounts. */
export async function createProviderOrder({ amount, currency, receipt, notes }) {
  const provider = providerName();
  if (provider === 'razorpay') return { provider, ...(await razorpayCreateOrder({ amount, currency, receipt, notes })) };
  return { provider, ...(await mockCreateOrder({ amount, currency, receipt })) };
}

/** Verifies a checkout-return signature (order_id + payment_id + signature
 *  the frontend hands back after a successful checkout). Same formula
 *  for both providers -- only the secret differs, and mock's default
 *  secret is used automatically when no real one is configured. NEVER
 *  treat a checkout return alone as proof of payment on its own --
 *  see paymentVerification.js, which requires this AND the webhook to
 *  agree before activating anything (spec: "NEVER activate the package
 *  based solely on frontend success"). */
export function verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature }) {
  const secret = providerName() === 'razorpay' ? RAZORPAY_KEY_SECRET : (RAZORPAY_KEY_SECRET || 'mock-secret');
  const expected = crypto.createHmac('sha256', secret).update(`${providerOrderId}|${providerPaymentId}`).digest('hex');
  if (expected.length !== String(signature || '').length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(signature), 'hex')); }
  catch { return false; } // malformed signature (wrong length/hex) -- never a match
}

/** Verifies a webhook's signature against the RAW request body (never
 *  the parsed/re-serialized JSON -- re-serialization can change byte
 *  layout and break the signature even for a genuine webhook). */
export function verifyWebhookSignature(rawBody, signature) {
  const secret = providerName() === 'razorpay' ? RAZORPAY_WEBHOOK_SECRET : (RAZORPAY_WEBHOOK_SECRET || 'mock-webhook-secret');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== String(signature || '').length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(signature), 'hex')); }
  catch { return false; }
}

/** Normalizes a provider's webhook body into SK OS's own shape --
 *  { providerEventId, eventType, providerOrderId, providerPaymentId,
 *  amount, currency, status }. Razorpay and mock share the exact same
 *  payload.payment.entity/payload.order.entity shape by construction
 *  (see mockBuildWebhookEvent above), so one parser covers both. */
export function parseWebhookPayload(rawBody) {
  const data = JSON.parse(rawBody);
  const payment = data.payload?.payment?.entity;
  const order = data.payload?.order?.entity;
  return {
    eventType: data.event,
    providerOrderId: payment?.order_id || order?.id || null,
    providerPaymentId: payment?.id || null,
    amount: payment?.amount != null ? payment.amount / 100 : (order?.amount != null ? order.amount / 100 : null), // paise -> rupees
    currency: payment?.currency || order?.currency || null,
    rawStatus: payment?.status || null,
  };
}

/** Maps a provider's own status vocabulary to SK OS's internal
 *  CREATED|PENDING|PROCESSING|SUCCESS|FAILED|CANCELLED|EXPIRED|REFUNDED|
 *  PARTIALLY_REFUNDED|DISPUTED enum (payment_orders/payment_transactions
 *  CHECK constraint) -- never lets a raw provider string leak into a
 *  column that other code branches on. */
export function mapProviderEventToStatus(eventType) {
  const map = {
    'payment.created': 'CREATED',
    'payment.authorized': 'PROCESSING',
    'payment.pending': 'PENDING',
    'payment.captured': 'SUCCESS',
    'order.paid': 'SUCCESS',
    'payment.failed': 'FAILED',
    'payment.cancelled': 'CANCELLED',
    'refund.created': 'REFUNDED',
    'refund.processed': 'REFUNDED',
    'payment.dispute.created': 'DISPUTED',
  };
  return map[eventType] || null; // an unrecognized event type is never guessed at -- caller must handle null explicitly
}

// TEST-ONLY: clears mock provider in-process state between test files/cases.
export function _resetMockProviderStateForTests() {
  _mockOrders.clear();
}
