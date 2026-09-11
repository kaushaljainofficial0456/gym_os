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
import { config } from '../../config.js';

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const REQUESTED_PROVIDER = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

// ---- Mock-mode signing secrets -- SECURITY-CRITICAL, read this before
// touching either of these two lines. ----
//
// verifyCheckoutSignature/verifyWebhookSignature used to fall back to the
// LITERAL strings 'mock-secret' / 'mock-webhook-secret' whenever no real
// Razorpay secret was configured. That is a predictable value printed in
// this very source file -- anyone who has ever read it (or a security
// review, or a leaked copy of this repo) can compute a HMAC against it.
// A deployment that ended up running the mock provider in production
// (see config.js's own boot-time gate, which is the PRIMARY defense
// against that ever happening) would accept a forged checkout-return or
// webhook signed with that public literal as if it were a real payment --
// confirmed exploitable against a running instance before this fix.
//
// These two constants replace that literal with 32 bytes of real entropy,
// generated ONCE per process at module load, never logged, never derivable
// from anything public, and never the same value twice across restarts.
// The mock provider's own same-process sign+verify pair (mockSign here /
// verifyCheckoutSignature's mock branch, mockBuildWebhookEvent here /
// verifyWebhookSignature's mock branch) both read the SAME in-memory
// constant, so the mock flow keeps working end to end with zero
// configuration for local dev and the test suite -- there is simply no
// longer a value an external caller (who is not this same running process)
// could ever know or guess to forge a signature against.
const MOCK_CHECKOUT_SECRET = crypto.randomBytes(32).toString('hex');
const MOCK_WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');

/** Thrown by every provider operation when no payment provider is
 *  configured ('none'). Carries an HTTP status + stable code so the
 *  global error handler can turn it into a controlled 503 instead of a
 *  generic 500 -- see index.js. */
export class PaymentsNotConfiguredError extends Error {
  constructor() {
    super('Payments are not configured on this deployment.');
    this.name = 'PaymentsNotConfiguredError';
    this.status = 503;
    this.code = 'payments_not_configured';
  }
}

// Three states, not two. 'mock' is a DEVELOPMENT convenience that can
// mint its own valid-looking signatures in-process; letting it answer
// real production traffic would mean anyone with an account could forge
// a payment (see config.js's gate comment and paymentsDev.js). But
// requiring live Razorpay credentials just to BOOT is the opposite
// failure: a deployment with no payment provider yet cannot run at all,
// even though nothing else in the app depends on payments.
//
// 'none' resolves that: in production without a configured live
// provider, there is no payment provider at all. Every provider
// operation throws PaymentsNotConfiguredError (-> controlled 503) and
// both signature verifiers fail closed, so no payment can be created,
// activated, refunded or forged. Outside production 'mock' still
// applies exactly as before, so dev and the test suite are unchanged.
//
// Configuring PAYMENT_PROVIDER=razorpay + the Razorpay keys switches
// this to 'razorpay' with no code change -- the integration below is
// untouched and stays ready for that.
export function providerName() {
  if (REQUESTED_PROVIDER === 'razorpay' && RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) return 'razorpay';
  if (config.nodeEnv === 'production') return 'none';
  return 'mock';
}

/** True when payments are unavailable on this deployment (production
 *  with no live provider configured). Callers that want to degrade
 *  gracefully -- hide a "Pay" button, skip a checkout step -- can ask
 *  this instead of catching the thrown error. */
export function paymentsDisabled() {
  return providerName() === 'none';
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
  // the two id namespaces differ. Always signs with MOCK_CHECKOUT_SECRET
  // -- never a real Razorpay key, even if one happens to be present in
  // the environment (e.g. PAYMENT_PROVIDER not yet set to 'razorpay'
  // while real-looking keys already exist) -- so a mock signature can
  // never accidentally double as a genuine one.
  return crypto.createHmac('sha256', MOCK_CHECKOUT_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
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
  const signature = crypto.createHmac('sha256', MOCK_WEBHOOK_SECRET).update(body).digest('hex');
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
  const provider = providerName();
  if (provider === 'none') throw new PaymentsNotConfiguredError();
  return provider === 'razorpay' ? razorpayFetchOrderStatus(providerOrderId) : mockFetchOrderStatus(providerOrderId);
}

/** Issues a refund against a captured payment at the gateway. `amount`
 *  is in RUPEES (converted to paise for Razorpay internally, matching
 *  every other amount in this file) -- omit for a full refund of
 *  whatever remains captured. Returns { providerRefundId, status }. */
export async function refundProviderPayment({ providerPaymentId, amount, notes }) {
  const provider = providerName();
  if (provider === 'none') throw new PaymentsNotConfiguredError();
  return provider === 'razorpay' ? razorpayRefundPayment({ providerPaymentId, amount, notes }) : mockRefundPayment({ providerPaymentId, amount });
}

/** Creates a gateway order. Caller MUST have already resolved amount/
 *  currency SERVER-SIDE (see paymentOrders.js) -- this function trusts
 *  whatever it's given, so it must never be called with client-supplied
 *  amounts. */
export async function createProviderOrder({ amount, currency, receipt, notes }) {
  const provider = providerName();
  if (provider === 'none') throw new PaymentsNotConfiguredError();
  if (provider === 'razorpay') return { provider, ...(await razorpayCreateOrder({ amount, currency, receipt, notes })) };
  return { provider, ...(await mockCreateOrder({ amount, currency, receipt })) };
}

/** Verifies a checkout-return signature (order_id + payment_id + signature
 *  the frontend hands back after a successful checkout). Same formula
 *  for both providers -- only the secret differs. FAILS CLOSED: in
 *  razorpay mode, a missing/empty RAZORPAY_KEY_SECRET is never treated as
 *  "fall back to a default" -- it is a broken configuration, and no
 *  signature verifies against it (secret is truthy-checked below, exactly
 *  like verifyWebhookSignature; see that function's comment for the full
 *  reasoning, and MOCK_CHECKOUT_SECRET's own comment above for what mock
 *  mode uses instead of the old 'mock-secret' literal). NEVER treat a
 *  checkout return alone as proof of payment on its own -- see
 *  paymentVerification.js, which requires this AND the webhook to agree
 *  before activating anything (spec: "NEVER activate the package based
 *  solely on frontend success"). */
export function verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature }) {
  const provider = providerName();
  if (provider === 'none') return false; // payments unconfigured -- nothing can be verified, fail closed
  const secret = provider === 'razorpay' ? RAZORPAY_KEY_SECRET : MOCK_CHECKOUT_SECRET;
  if (!secret) return false; // fail closed -- never verify against an empty/missing key
  const expected = crypto.createHmac('sha256', secret).update(`${providerOrderId}|${providerPaymentId}`).digest('hex');
  if (expected.length !== String(signature || '').length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(signature), 'hex')); }
  catch { return false; } // malformed signature (wrong length/hex) -- never a match
}

/** Verifies a webhook's signature against the RAW request body (never
 *  the parsed/re-serialized JSON -- re-serialization can change byte
 *  layout and break the signature even for a genuine webhook). FAILS
 *  CLOSED: a missing OR empty RAZORPAY_WEBHOOK_SECRET in razorpay mode is
 *  never treated as "fall back to a default" -- this is the fix for a
 *  real, confirmed-exploitable gap where a live deployment that forgot to
 *  set this one env var (providerName() only requires PAYMENT_PROVIDER +
 *  the two API keys to report 'razorpay' -- the webhook secret was never
 *  part of that check) silently accepted ANY webhook signed with the
 *  hardcoded 'mock-webhook-secret' literal from this file, with no
 *  authentication of any kind. There is no default to fall back to
 *  anymore: `secret` is only ever the real configured
 *  RAZORPAY_WEBHOOK_SECRET (razorpay mode) or the process-random
 *  MOCK_WEBHOOK_SECRET (mock mode, see its own comment above) -- an empty
 *  string from either source refuses to verify, full stop. */
export function verifyWebhookSignature(rawBody, signature) {
  const provider = providerName();
  if (provider === 'none') return false; // payments unconfigured -- nothing can be verified, fail closed
  const secret = provider === 'razorpay' ? RAZORPAY_WEBHOOK_SECRET : MOCK_WEBHOOK_SECRET;
  if (!secret) return false; // fail closed -- missing/empty RAZORPAY_WEBHOOK_SECRET must never fall back to a guessable default
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== String(signature || '').length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(signature), 'hex')); }
  catch { return false; }
}

/** TEST-ONLY: signs an arbitrary raw body with whichever webhook secret
 *  verifyWebhookSignature would currently check against (the real
 *  RAZORPAY_WEBHOOK_SECRET in razorpay mode, MOCK_WEBHOOK_SECRET in mock
 *  mode). Exists so a test that needs a validly-signed but otherwise
 *  arbitrary body (e.g. deliberately malformed JSON, to test that path
 *  specifically rather than signature verification) never has to
 *  duplicate the secret-selection formula itself -- see
 *  verifyWebhookSignature's own comment on why that secret is no longer a
 *  predictable literal a test (or anyone else) could just hardcode. */
export function _signRawBodyForTests(rawBody) {
  const secret = providerName() === 'razorpay' ? RAZORPAY_WEBHOOK_SECRET : MOCK_WEBHOOK_SECRET;
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
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
