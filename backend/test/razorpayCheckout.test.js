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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_ID = 'rzp_test_FAKEKEYID000';
const FAKE_SECRET = 'fake_secret_for_tests_only';

/** Runs `body` (an async function source taking the provider module `p`)
 *  with Razorpay enabled and fetch replaced by `fetchStub`. */
function inRazorpay(fetchStub, body, extraEnv = {}) {
  const script = `
    globalThis.fetch = ${fetchStub};
    // A file:// URL, not a bare path: on Windows import('D:\...') is refused.
    const p = await import(${JSON.stringify(pathToFileURL(path.join(backend, 'src/services/payments/paymentProvider.js')).href)});
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

// ---- An unpaid order Razorpay cannot take payment against is re-issued ----
// Idempotency keys are stable per intent, so an order created under the mock
// provider (or another Razorpay account) used to come back on every attempt,
// and Checkout failed on an order id Razorpay had never issued.

const ORDERS_URL = pathToFileURL(path.join(backend, 'src/services/payments/paymentOrders.js')).href;

/** One payment_orders row in memory, enough for createPaymentOrder. */
const fakeDb = (row) => `(() => {
  const rows = [${JSON.stringify(row)}];
  return {
    rows,
    async q1(sql, params) {
      if (/FROM organizations/.test(sql)) return null;
      if (/idempotency_key = \?/.test(sql)) return rows.find((r) => r.idempotency_key === params[0]) || null;
      if (/WHERE id = \?/.test(sql)) return rows.find((r) => r.id === params[0]) || null;
      throw new Error('unexpected q1 ' + sql);
    },
    async run(sql, params) {
      if (!/^\s*UPDATE payment_orders SET provider/.test(sql)) throw new Error('unexpected run ' + sql);
      const [provider, providerOrderId, createdAt, updatedAt, id, oldId] = params;
      const r = rows.find((x) => x.id === id && x.provider_order_id === oldId && x.status === 'CREATED');
      if (r) Object.assign(r, { provider, provider_order_id: providerOrderId, created_at: createdAt, updated_at: updatedAt });
      return { changes: r ? 1 : 0 };
    },
  };
})()`;

const pending = (over) => ({ id: 'pord_1', status: 'CREATED', provider: 'mock', provider_order_id: 'mock_order_old', amount: 1999, currency: 'INR', idempotency_key: 'renew-sub_1-2026-02-23', created_at: '2026-08-28T11:53:37.809Z', ...over });
const reuse = (row) => `async () => {
  const { createPaymentOrder } = await import(${JSON.stringify(ORDERS_URL)});
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(((init && init.method) || 'GET') + ' ' + url); return real(url, init); };
  const db = ${fakeDb(row)};
  const order = await createPaymentOrder(db, { subjectType: 'client_membership', subjectId: 'sub_1', orgId: 'org_1', amount: 1999, idempotencyKey: 'renew-sub_1-2026-02-23' });
  return { order, calls };
}`;
const gateway = `async (url, init) => {
  if (init && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'order_NEW' }) };
  if (url.includes('/orders/order_KNOWN/')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
  return { ok: false, status: 400, text: async () => '{"error":{"description":"The id provided does not exist"}}' };
}`;

test('an unpaid order from the mock provider gets a real Razorpay order, on the same record', () => {
  const { order, calls } = inRazorpay(gateway, reuse(pending()));
  assert.equal(order.id, 'pord_1');
  assert.equal(order.provider, 'razorpay');
  assert.equal(order.provider_order_id, 'order_NEW');
  assert.deepEqual(calls, ['POST https://api.razorpay.com/v1/orders']);
  assert.ok(order.created_at > '2026-08-28T11:53:37.809Z', 'dated as the new attempt, not the stale one');
});

test('an unpaid order from another Razorpay account is re-issued too', () => {
  const { order } = inRazorpay(gateway, reuse(pending({ provider: 'razorpay', provider_order_id: 'order_FROMOTHERKEYS' })));
  assert.equal(order.provider_order_id, 'order_NEW');
});

test('an unpaid order Razorpay knows is returned as it was: a retried tap never makes a second order', () => {
  const { order, calls } = inRazorpay(gateway, reuse(pending({ provider: 'razorpay', provider_order_id: 'order_KNOWN' })));
  assert.equal(order.provider_order_id, 'order_KNOWN');
  assert.ok(!calls.some((c) => c.startsWith('POST')), 'no new order created');
});

test('an order that has been paid is never replaced', () => {
  const { order, calls } = inRazorpay(gateway, reuse(pending({ status: 'SUCCESS' })));
  assert.equal(order.provider_order_id, 'mock_order_old');
  assert.deepEqual(calls, []);
});
