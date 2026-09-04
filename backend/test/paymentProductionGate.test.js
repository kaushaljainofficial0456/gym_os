// ============================================================
// F-02 REGRESSION: production must never silently run the mock payment
// provider, and must fail closed if required Razorpay configuration is
// missing.
//
// Before this fix, providerName() falling back to 'mock' had NOTHING to
// do with NODE_ENV -- a production deploy of .env.prod's actual shape
// (RAZORPAY_KEY_ID="" and RAZORPAY_KEY_SECRET="", confirmed by reading
// that file) booted successfully and quietly served every "payment"
// through the in-process mock gateway. POST /api/payments/mock/complete
// (routes/paymentsDev.js) was reachable to any authenticated account and
// handed back a checkout signature that verifyCheckoutSignature would
// then accept -- confirmed exploitable end to end against a running
// instance: three authenticated calls, no real money, no forged
// anything, and a PAYMENT_PENDING subscription flipped to ACTIVE.
//
// Two independent layers now close this:
//   1. config.js refuses to boot at all in production (process.exit(1))
//      unless PAYMENT_PROVIDER=razorpay + all three Razorpay env vars are
//      set -- see dbPolicy.test.js for the established pattern this
//      mirrors exactly (config.js gates at import time, so each scenario
//      needs its own subprocess).
//   2. index.js never mounts POST /api/payments/mock/complete at all when
//      NODE_ENV=production -- see paymentProductionGate.route.test.js for
//      the live-server proof of that specific piece (this file covers the
//      config.js boot gate only, since it needs process.exit()/subprocess
//      semantics that a live Express server test doesn't).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.resolve(__dirname, '..', 'src', 'config.js').replace(/\\/g, '/');
const provPath = path.resolve(__dirname, '..', 'src', 'services', 'payments', 'paymentProvider.js').replace(/\\/g, '/');

// Passes the production JWT + DATABASE_URL gates so ONLY the payment
// gate is under test -- same isolation technique as dbPolicy.test.js's
// own STRONG_SECRET/PG_URL constants.
const STRONG_SECRET = 'x'.repeat(32);
const PG_URL = 'postgresql://skos_app:testpass@example.invalid/neondb?sslmode=verify-full';
const FULL_RAZORPAY_ENV = {
  PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest',
  RAZORPAY_KEY_SECRET: 'fake-key-secret-for-test-only',
  RAZORPAY_WEBHOOK_SECRET: 'fake-webhook-secret-for-test-only',
};

function loadConfig(extraEnv) {
  const env = { PATH: process.env.PATH, NODE_ENV: 'production', JWT_SECRET: STRONG_SECRET, DATABASE_URL: PG_URL, ...extraEnv };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { config } = await import('file://${cfgPath}');
    console.log('BOOTED:' + config.nodeEnv);
  `], { env, encoding: 'utf8', timeout: 10000 });
  return { status: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

// Boots config.js AND paymentProvider.js together, reporting the provider
// actually resolved. The security-critical assertion in the
// payments-disabled cases is not merely "it booted" but that the provider
// is 'none' and NEVER 'mock' -- mock in production is the forgeable-payment
// hazard this whole gate exists for.
function loadProvider(extraEnv) {
  const env = { PATH: process.env.PATH, NODE_ENV: 'production', JWT_SECRET: STRONG_SECRET, DATABASE_URL: PG_URL, ...extraEnv };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { providerName, paymentsDisabled } = await import('file://${provPath}');
    console.log('PROVIDER:' + providerName() + ':' + paymentsDisabled());
  `], { env, encoding: 'utf8', timeout: 10000 });
  return { status: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

test('.env.prod actual shape (empty Razorpay keys) -> boots with payments DISABLED, never mock', () => {
  // These are the literal values committed in .env.prod today (empty
  // strings). This previously refused to boot outright. It now boots with
  // payments disabled: an operator without a payment gateway must still be
  // able to run the rest of the product. The security property is upheld by
  // the provider resolving to 'none' rather than falling back to 'mock'.
  const envv = { PAYMENT_PROVIDER: undefined, RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' };
  const r = loadConfig(envv);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BOOTED:production/);
  assert.match(r.stderr, /payments are DISABLED/i);

  const p = loadProvider(envv);
  assert.match(p.stdout, /PROVIDER:none:true/, 'production without a live provider must resolve to none');
  assert.doesNotMatch(p.stdout, /mock/, 'the mock gateway must never be reachable in production');
});

test('production + no payment env at all -> boots with payments DISABLED, never mock', () => {
  const r = loadConfig({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BOOTED:production/);
  assert.match(r.stderr, /payments are DISABLED/i);
  assert.match(r.stderr, /PAYMENT_PROVIDER=razorpay/, 'the warning must state exactly how to enable Razorpay later');

  const p = loadProvider({});
  assert.match(p.stdout, /PROVIDER:none:true/);
  assert.doesNotMatch(p.stdout, /mock/);
});

test('production + PAYMENT_PROVIDER unset (real-shaped keys present but flag missing) -> boots DISABLED', () => {
  // Keys present but the flag never set means Razorpay was not actually
  // requested, so this is the disabled state, not a misconfiguration --
  // providerName() already ignores the keys without the flag.
  const r = loadConfig({
    RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest',
    RAZORPAY_KEY_SECRET: 'fake-key-secret-for-test-only',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BOOTED:production/);
  assert.match(r.stderr, /payments are DISABLED/i);
});

test('production + PAYMENT_PROVIDER=razorpay + both API keys but NO webhook secret -> refuses to start', () => {
  // This is the exact gap that made F-01 exploitable in the first place:
  // providerName() itself never checked RAZORPAY_WEBHOOK_SECRET, so a
  // deploy could reach 'razorpay' mode (real orders, real checkout) while
  // no webhook could ever legitimately verify. Now caught at boot instead
  // of discovered when a paying customer's subscription never activates.
  const r = loadConfig({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest', RAZORPAY_KEY_SECRET: 'fake-key-secret-for-test-only' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /RAZORPAY_WEBHOOK_SECRET/);
});

test('production + PAYMENT_PROVIDER=razorpay + only RAZORPAY_KEY_ID (no secret, no webhook secret) -> refuses to start', () => {
  const r = loadConfig({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /RAZORPAY_KEY_SECRET/);
});

test('production + fully configured live payment provider -> boots normally', () => {
  const r = loadConfig(FULL_RAZORPAY_ENV);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BOOTED:production/);
});

test('development + no payment config at all -> boots normally (mock provider allowed in dev)', () => {
  const env = { PATH: process.env.PATH, NODE_ENV: 'development' };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { config } = await import('file://${cfgPath}');
    console.log('BOOTED:' + config.nodeEnv);
  `], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /BOOTED:development/);
});

test('staging + no payment config at all -> boots normally (gate is production-only by design)', () => {
  // Deliberate scope: the payment gate mirrors the JWT_SECRET/DATABASE_URL
  // gates' PRODUCTION check specifically, not their staging+production
  // scope -- see config.js's own comment on why. This test pins that as
  // an intentional choice, not an oversight, so a future change can't
  // silently narrow or widen it without a test noticing either way.
  const r = loadConfig({ NODE_ENV: 'staging' });
  assert.equal(r.status, 0, r.stderr);
});
