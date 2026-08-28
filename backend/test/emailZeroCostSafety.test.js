// ============================================================
// ZERO-COST EMAIL SAFETY TESTS -- mirrors paymentZeroCostSafety.test.js
// exactly. Proves EMAIL_PROVIDER=resend alone, or RESEND_API_KEY alone,
// never activates real email delivery -- both must be set together, or
// the app stays on the free, zero-network mock provider. Subprocess-
// based: emailProvider.js reads its env vars as module-load-time
// consts, so the only faithful way to test different combinations is a
// fresh process per combination.
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
  const m = await import('./backend/src/services/notifications/emailProvider.js');
  console.log(JSON.stringify({ name: m.providerName(), live: m.isLiveProviderConfigured() }));
`;

describe('Zero-cost email safety', () => {
  it('real key present but EMAIL_PROVIDER not set -> stays mock', async () => {
    const r = await runWithEnv(PROBE, { RESEND_API_KEY: 're_fakekeyfortest' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock', 'providerName must stay mock without EMAIL_PROVIDER=resend, even with a real-shaped key present');
  });

  it('EMAIL_PROVIDER=resend but RESEND_API_KEY missing -> stays mock (never a half-configured live mode)', async () => {
    const r = await runWithEnv(PROBE, { EMAIL_PROVIDER: 'resend' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock', 'an incomplete config must silently fall back to mock, never error out or half-activate');
  });

  it('EMAIL_PROVIDER=resend + RESEND_API_KEY -> switches to resend', async () => {
    const r = await runWithEnv(PROBE, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_fakekeyfortest' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'resend', 'the explicit opt-in (flag + key) is the ONLY combination that goes live');
    assert.equal(data.live, true);
  });

  it('no env at all -> mock, isLiveProviderConfigured() false', async () => {
    const r = await runWithEnv(PROBE, {});
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock');
    assert.equal(data.live, false);
  });
});
