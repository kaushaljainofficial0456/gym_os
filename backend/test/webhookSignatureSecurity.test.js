// ============================================================
// F-01 REGRESSION: Razorpay webhook (and checkout-return) signature
// verification must never fall back to a hardcoded/predictable secret.
//
// Before this fix, verifyWebhookSignature computed its HMAC key as
// `RAZORPAY_WEBHOOK_SECRET || 'mock-webhook-secret'` -- a literal string
// printed in paymentProvider.js. POST /api/enterprise/payment/webhook is
// public by design (Razorpay calls it server-to-server, no session), so
// that literal was the ONLY thing standing between an unauthenticated
// HTTP request and activating a real subscription. Confirmed exploitable
// against a running instance before this fix: a forged payment.captured
// event, signed with nothing but that public string, flipped a
// PAYMENT_PENDING org straight to ACTIVE with zero credentials presented.
// verifyCheckoutSignature had the identical shape (`RAZORPAY_KEY_SECRET
// || 'mock-secret'`) for the OTHER activation path (checkout-return).
//
// paymentProvider.js reads RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET/
// PAYMENT_PROVIDER as module-load-time consts (same as
// paymentZeroCostSafety.test.js's own header explains for the sibling
// provider-selection tests) -- so every scenario below needs a genuinely
// fresh process, not a mutated env on the one already-imported module
// instance. Same runWithEnv/subprocess pattern as
// paymentZeroCostSafety.test.js and zeroCostSafety.test.js.
// ============================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

async function runWithEnv(script, env = {}) {
  const fullEnv = { PATH: process.env.PATH, NODE_ENV: 'test', ...env };
  try {
    const { stdout, stderr } = await exec('node', ['--input-type=module', '-e', script], { cwd: ROOT, env: fullEnv, timeout: 15000 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout?.trim() || '', stderr: e.stderr?.trim() || '', exitCode: e.code || 1 };
  }
}

// Runs `probeBody` (an async arrow-function body string, referencing the
// already-imported module as `m` and node:crypto as `crypto`) inside a
// fresh subprocess with the given env, printing its result as JSON.
async function probe(probeBody, env) {
  const script = `
    const m = await import('./backend/src/services/payments/paymentProvider.js');
    const crypto = await import('node:crypto');
    const result = await (async () => { ${probeBody} })();
    console.log(JSON.stringify(result));
  `;
  const r = await runWithEnv(script, env);
  if (r.exitCode !== 0) throw new Error(`probe subprocess failed (exit ${r.exitCode}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const RAZORPAY_LIVE_ENV = {
  PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest',
  RAZORPAY_KEY_SECRET: 'fake-key-secret-for-test-only',
};

describe('F-01: webhook signature verification fails closed (no hardcoded fallback)', () => {
  it('1. valid signature + a configured RAZORPAY_WEBHOOK_SECRET -> accepted', async () => {
    const result = await probe(`
      const body = JSON.stringify({ event: 'payment.captured', payload: {} });
      const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
      return { name: m.providerName(), ok: m.verifyWebhookSignature(body, sig) };
    `, { ...RAZORPAY_LIVE_ENV, RAZORPAY_WEBHOOK_SECRET: 'a-real-configured-webhook-secret' });
    assert.equal(result.name, 'razorpay', 'sanity: provider really is live for this scenario');
    assert.equal(result.ok, true, 'a signature correctly computed against the configured secret must verify');
  });

  it('2. invalid signature (configured secret, wrong signature) -> rejected', async () => {
    const result = await probe(`
      const body = JSON.stringify({ event: 'payment.captured', payload: {} });
      return { ok: m.verifyWebhookSignature(body, 'deadbeef'.repeat(8)) };
    `, { ...RAZORPAY_LIVE_ENV, RAZORPAY_WEBHOOK_SECRET: 'a-real-configured-webhook-secret' });
    assert.equal(result.ok, false, 'a wrong signature must never verify, even with a real secret configured');
  });

  it('3. RAZORPAY_WEBHOOK_SECRET missing entirely -> rejected, no matter what signature is presented', async () => {
    const result = await probe(`
      const body = JSON.stringify({ event: 'payment.captured', payload: {} });
      // The exact original PoC: sign with the literal that used to be the fallback.
      const forgedSig = crypto.createHmac('sha256', 'mock-webhook-secret').update(body).digest('hex');
      return { name: m.providerName(), forged: m.verifyWebhookSignature(body, forgedSig) };
    `, RAZORPAY_LIVE_ENV); // RAZORPAY_WEBHOOK_SECRET intentionally omitted
    assert.equal(result.name, 'razorpay', 'sanity: providerName() does not itself require the webhook secret (that is exactly the gap this fix closes)');
    assert.equal(result.forged, false, 'a missing RAZORPAY_WEBHOOK_SECRET must fail closed -- no fallback secret exists to forge against');
  });

  it('4. RAZORPAY_WEBHOOK_SECRET explicitly set to an empty string -> rejected', async () => {
    const result = await probe(`
      const body = JSON.stringify({ event: 'payment.captured', payload: {} });
      const forgedSig = crypto.createHmac('sha256', 'mock-webhook-secret').update(body).digest('hex');
      const emptySig = crypto.createHmac('sha256', '').update(body).digest('hex');
      return { forgedRejected: m.verifyWebhookSignature(body, forgedSig) === false, emptyKeyRejected: m.verifyWebhookSignature(body, emptySig) === false };
    `, { ...RAZORPAY_LIVE_ENV, RAZORPAY_WEBHOOK_SECRET: '' });
    assert.equal(result.forgedRejected, true, 'an explicitly empty secret must fail closed, same as a missing one');
    assert.equal(result.emptyKeyRejected, true, 'even a signature computed against an empty-string key must not verify -- there is no "empty key" special case');
  });

  it('5. the old hardcoded "mock-webhook-secret" literal never verifies against a REAL configured secret', async () => {
    const result = await probe(`
      const body = JSON.stringify({ event: 'payment.captured', payload: {} });
      const forgedSig = crypto.createHmac('sha256', 'mock-webhook-secret').update(body).digest('hex');
      return { ok: m.verifyWebhookSignature(body, forgedSig) };
    `, { ...RAZORPAY_LIVE_ENV, RAZORPAY_WEBHOOK_SECRET: 'a-real-configured-webhook-secret-that-is-not-the-old-literal' });
    assert.equal(result.ok, false, 'a signature forged with the historical default literal must not verify against a real secret');
  });

  it('the mock provider itself no longer uses a fixed literal either (mock-mode secret is random per process)', async () => {
    const result = await probe(`
      const body = JSON.stringify({ event: 'payment.captured', payload: {} });
      const attackerSig = crypto.createHmac('sha256', 'mock-webhook-secret').update(body).digest('hex');
      return { name: m.providerName(), forgedInMockMode: m.verifyWebhookSignature(body, attackerSig) };
    `, {}); // no env at all -> mock mode
    assert.equal(result.name, 'mock');
    assert.equal(result.forgedInMockMode, false, 'even in mock mode, the old literal must not forge a valid signature -- mock mode has no predictable secret anymore');
  });

  it('the mock provider\'s own in-process sign+verify pair still works end to end (no regression for local/test use)', async () => {
    const result = await probe(`
      const order = await m.createProviderOrder({ amount: 100, currency: 'INR', receipt: 'r1' });
      const checkout = m.mockSimulateCheckout(order.providerOrderId);
      const webhook = m.mockBuildWebhookEvent(order.providerOrderId);
      return {
        checkoutOk: m.verifyCheckoutSignature({ providerOrderId: order.providerOrderId, providerPaymentId: checkout.paymentId, signature: checkout.signature }),
        webhookOk: m.verifyWebhookSignature(webhook.body, webhook.signature),
      };
    `, {});
    assert.equal(result.checkoutOk, true, 'mock checkout signing/verification must keep working with zero configuration');
    assert.equal(result.webhookOk, true, 'mock webhook signing/verification must keep working with zero configuration');
  });
});

describe('F-01 (checkout-signature counterpart): verifyCheckoutSignature also fails closed', () => {
  // The historical vulnerability lived specifically in the NO-Razorpay-
  // config state (providerName() === 'mock', RAZORPAY_KEY_SECRET falsy --
  // exactly .env.prod's shape, both keys blank, and exactly what the
  // original F-02 PoC ran against): the old code's mock branch was
  // `RAZORPAY_KEY_SECRET || 'mock-secret'`, so with no key configured it
  // signed AND verified against the literal 'mock-secret' -- a value
  // printed in this source file. Testing this against a fully-configured
  // razorpay-live env (as an earlier draft of this test mistakenly did)
  // proves nothing: providerName() would be 'razorpay' there, so the old
  // code's mock-secret branch was never reached in the first place --
  // verified by running this exact scenario against the pre-fix source,
  // where it passed for the wrong reason. This is the scenario that
  // actually pins the fix.
  it('the old hardcoded "mock-secret" literal cannot forge a checkout signature when no Razorpay config exists at all', async () => {
    const result = await probe(`
      const forgedSig = crypto.createHmac('sha256', 'mock-secret').update('order_1|pay_1').digest('hex');
      return { name: m.providerName(), forged: m.verifyCheckoutSignature({ providerOrderId: 'order_1', providerPaymentId: 'pay_1', signature: forgedSig }) };
    `, {}); // no env at all -- the exact original F-02 PoC's configuration
    assert.equal(result.name, 'mock', 'sanity: this is genuinely the no-config mock-mode scenario the original PoC exploited');
    assert.equal(result.forged, false, 'the historical default literal must not forge a checkout signature -- mock mode has no predictable secret anymore');
  });

  it('the old hardcoded "mock-secret" literal never forges a checkout signature against a real configured key either', async () => {
    const result = await probe(`
      const forgedSig = crypto.createHmac('sha256', 'mock-secret').update('order_1|pay_1').digest('hex');
      return { ok: m.verifyCheckoutSignature({ providerOrderId: 'order_1', providerPaymentId: 'pay_1', signature: forgedSig }) };
    `, RAZORPAY_LIVE_ENV);
    assert.equal(result.ok, false, 'a signature forged with the historical default literal must not verify against the real configured key');
  });

  it('a validly-computed checkout signature against the real configured key still verifies (no regression)', async () => {
    const result = await probe(`
      const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update('order_1|pay_1').digest('hex');
      return { ok: m.verifyCheckoutSignature({ providerOrderId: 'order_1', providerPaymentId: 'pay_1', signature: sig }) };
    `, RAZORPAY_LIVE_ENV);
    assert.equal(result.ok, true);
  });
});
