// ============================================================
// Razorpay Standard Checkout: order creation errors, the Rs 1 minimum,
// the public key id served to the browser, and checkout-signature
// verification -- with FAKE keys and a stubbed fetch, in a child process
// so the provider module reads its environment fresh. Never calls
// Razorpay and never uses real credentials.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_ID = 'rzp_test_FAKEKEYID000';
const FAKE_SECRET = 'fake_secret_for_tests_only';

/** Runs `body` (an async function source taking the provider module `p`)
 *  with Razorpay enabled and fetch replaced by `fetchStub`. */
function inRazorpay(fetchStub, body, extraEnv = {}) {
  const script = `
    globalThis.fetch = ${fetchStub};
    const p = await import(${JSON.stringify(path.join(backend, 'src/services/payments/paymentProvider.js'))});
    const out = await (${body})(p);
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: backend,
    env: { ...process.env, NODE_ENV: 'development', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: FAKE_ID, RAZORPAY_KEY_SECRET: FAKE_SECRET, ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const captureError = `async (p) => {
  try { await p.createProviderOrder({ amount: 499, currency: 'INR', receipt: 'r1' }); return { ok: true }; }
  catch (e) { return { name: e.name, code: e.code, status: e.status, message: e.message }; }
}`;

test('order creation: amount sent in paise with Basic auth; returns the Razorpay order id', () => {
  const out = inRazorpay(`async (url, init) => ({
      ok: true, status: 200,
      json: async () => ({ id: 'order_TEST123', echo: { url, auth: init.headers.Authorization, body: JSON.parse(init.body) } }),
    })`, `async (p) => {
      let seen;
      const real = globalThis.fetch;
      globalThis.fetch = async (url, init) => { seen = { url, auth: init.headers.Authorization, body: JSON.parse(init.body) }; return real(url, init); };
      const r = await p.createProviderOrder({ amount: 499, currency: 'INR', receipt: 'pord_1' });
      return { r, seen };
    }`);
  assert.equal(out.r.provider, 'razorpay');
  assert.equal(out.r.providerOrderId, 'order_TEST123');
  assert.equal(out.seen.url, 'https://api.razorpay.com/v1/orders');
  assert.equal(out.seen.body.amount, 49900, 'Rs 499 -> 49900 paise');
  assert.equal(out.seen.body.currency, 'INR');
  assert.equal(out.seen.body.receipt, 'pord_1');
  assert.equal(out.seen.auth, `Basic ${Buffer.from(`${FAKE_ID}:${FAKE_SECRET}`).toString('base64')}`);
});

test('Razorpay rejecting our keys (401) -> payment_gateway_auth_failed / 502, never a 401 to the member', () => {
  const e = inRazorpay(`async () => ({ ok: false, status: 401, text: async () => 'Authentication failed' })`, captureError);
  assert.equal(e.name, 'PaymentGatewayError');
  assert.equal(e.code, 'payment_gateway_auth_failed');
  assert.equal(e.status, 502);
});

test('other Razorpay API errors -> payment_gateway_error / 500', () => {
  const e = inRazorpay(`async () => ({ ok: false, status: 400, text: async () => '{"error":{"description":"bad"}}' })`, captureError);
  assert.equal(e.code, 'payment_gateway_error');
  assert.equal(e.status, 500);
});

test('network failure reaching Razorpay -> payment_gateway_error / 500', () => {
  const e = inRazorpay(`async () => { throw new TypeError('fetch failed'); }`, captureError);
  assert.equal(e.code, 'payment_gateway_error');
  assert.equal(e.status, 500);
});

test('below Rs 1 (100 paise) is refused before any gateway call', () => {
  const out = inRazorpay(`async () => { throw new Error('gateway must not be called'); }`, `async (p) => {
    const res = [];
    for (const amount of [0.99, 0, -5]) {
      try { await p.createProviderOrder({ amount, currency: 'INR', receipt: 'r' }); res.push('created'); }
      catch (e) { res.push(e.code + ':' + e.status); }
    }
    return res;
  }`);
  assert.deepEqual(out, ['amount_below_minimum:400', 'amount_below_minimum:400', 'amount_below_minimum:400']);
});

test('the browser gets the PUBLIC key id only, and only in Razorpay mode', () => {
  const out = inRazorpay(`async () => ({})`, `async (p) => ({ keyId: p.publicKeyId(), summary: JSON.stringify(p.paymentConfigSummary()) })`);
  assert.equal(out.keyId, FAKE_ID);
  assert.ok(!out.summary.includes(FAKE_SECRET), 'the secret is never in any summary');
  const mock = inRazorpay(`async () => ({})`, `async (p) => ({ keyId: p.publicKeyId() })`, { PAYMENT_PROVIDER: 'mock' });
  assert.equal(mock.keyId, null);
});

test('checkout signature: HMAC-SHA256(order_id|payment_id, key secret); a mismatch never verifies', () => {
  const good = crypto.createHmac('sha256', FAKE_SECRET).update('order_A|pay_B').digest('hex');
  const out = inRazorpay(`async () => ({})`, `async (p) => ({
    good: p.verifyCheckoutSignature({ providerOrderId: 'order_A', providerPaymentId: 'pay_B', signature: ${JSON.stringify(good)} }),
    swapped: p.verifyCheckoutSignature({ providerOrderId: 'order_B', providerPaymentId: 'pay_A', signature: ${JSON.stringify(good)} }),
    tampered: p.verifyCheckoutSignature({ providerOrderId: 'order_A', providerPaymentId: 'pay_B', signature: ${JSON.stringify(good.replace(/.$/, (c) => (c === '0' ? '1' : '0')))} }),
    empty: p.verifyCheckoutSignature({ providerOrderId: 'order_A', providerPaymentId: 'pay_B', signature: '' }),
  })`);
  assert.deepEqual(out, { good: true, swapped: false, tampered: false, empty: false });
});
