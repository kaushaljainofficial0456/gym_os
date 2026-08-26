// ============================================================
// ZERO-COST PAYMENT SAFETY TESTS
//
// Proves the same discipline as zeroCostSafety.test.js applies to the
// payment provider: real Razorpay credentials being PRESENT never
// alone flips the app onto the live gateway. Both PAYMENT_PROVIDER=
// razorpay AND both real keys must be set together -- an incomplete
// or unset config always falls back to the free, zero-network mock
// provider. This matters concretely now that backend/.env holds real
// (test-mode) Razorpay keys: this test is what proves the running
// dev server and the rest of the test suite are NOT silently using
// them unless someone explicitly opts in.
//
// Subprocess-based (see runWithEnv), same as zeroCostSafety.test.js:
// paymentProvider.js reads RAZORPAY_KEY_ID/SECRET/PAYMENT_PROVIDER as
// module-load-time consts, so the only faithful way to test different
// combinations is a fresh process per combination, not mutating
// process.env and re-importing the same cached module instance.
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

const PROBE = `
  const m = await import('./backend/src/services/payments/paymentProvider.js');
  console.log(JSON.stringify({ name: m.providerName(), live: m.isLiveProviderConfigured() }));
`;

describe('Zero-cost payment safety', () => {
  it('real keys present but PAYMENT_PROVIDER not set -> stays mock', async () => {
    const r = await runWithEnv(PROBE, { RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest', RAZORPAY_KEY_SECRET: 'fakesecretfortest' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock', 'providerName must stay mock without PAYMENT_PROVIDER=razorpay, even with real-shaped keys present');
  });

  it('PAYMENT_PROVIDER=razorpay but keys missing -> stays mock (never a half-configured live mode)', async () => {
    const r = await runWithEnv(PROBE, { PAYMENT_PROVIDER: 'razorpay' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock', 'an incomplete config must silently fall back to mock, never error out or half-activate');
  });

  it('PAYMENT_PROVIDER=razorpay + only KEY_ID (no secret) -> stays mock', async () => {
    const r = await runWithEnv(PROBE, { PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock');
  });

  it('PAYMENT_PROVIDER=razorpay + BOTH real-shaped keys -> switches to razorpay', async () => {
    const r = await runWithEnv(PROBE, { PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest', RAZORPAY_KEY_SECRET: 'fakesecretfortest' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'razorpay', 'the explicit opt-in (flag + both keys) is the ONLY combination that goes live');
    assert.equal(data.live, true);
  });

  it('no env at all -> mock, isLiveProviderConfigured() false', async () => {
    const r = await runWithEnv(PROBE, {});
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock');
    assert.equal(data.live, false);
  });
});
