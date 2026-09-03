// ============================================================
// F-12i REGRESSION: uploaded files must never silently fail to persist
// in production.
//
// This app deploys as a Vercel serverless function (vercel.json's
// `functions` block) -- its filesystem outside /tmp is read-only, and
// /tmp itself is ephemeral and not shared across instances. The 'local'
// storage driver (this app's default) writes under a path inside the
// deployed bundle, not /tmp -- in production that either throws
// immediately or silently produces a file a later request can't see.
// There is no working 's3' driver yet either (it already refuses to
// pretend otherwise -- see the existing "S3 storage driver is not
// configured yet" branch).
//
// storage.js now fails loudly (a clear, actionable Error) instead of
// attempting an unsafe write, and logs a boot-time warning -- same
// "operator misconfiguration is an obvious error" posture as
// paymentProductionGate.test.js's config.js gate. Needs subprocess
// isolation because config.nodeEnv (which storage.js reads) is resolved
// once at import time from env vars.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storagePath = path.resolve(__dirname, '..', 'src', 'storage.js').replace(/\\/g, '/');

const STRONG_SECRET = 'x'.repeat(32);
const PG_URL = 'postgresql://skos_app:testpass@example.invalid/neondb?sslmode=verify-full';
const FULL_RAZORPAY_ENV = {
  PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest',
  RAZORPAY_KEY_SECRET: 'fake-key-secret-for-test-only',
  RAZORPAY_WEBHOOK_SECRET: 'fake-webhook-secret-for-test-only',
};

// A real 32x32 PNG data URL -- must clear saveImage's own min-dimension
// check (32x32) to actually reach the production storage-driver gate
// under test here, rather than an earlier "image too small" rejection.
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGUlEQVR4nO3BMQEAAADCoPVP7WENoAAAAG4MIAABt9NlCQAAAABJRU5ErkJggg==';

function run(code, extraEnv) {
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'production', JWT_SECRET: STRONG_SECRET, DATABASE_URL: PG_URL,
    ...FULL_RAZORPAY_ENV, ...extraEnv,
  };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 10000 });
  return { status: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

test('production boot with STORAGE_DRIVER unset (defaults to local) logs a loud warning, does not crash the whole app', () => {
  const r = run(`
    const { STORAGE_DRIVER } = await import('file://${storagePath}');
    console.log('DRIVER:' + STORAGE_DRIVER);
  `, { STORAGE_DRIVER: undefined });
  assert.equal(r.status, 0, 'importing storage.js alone must not crash the app -- only an actual upload attempt should fail');
  assert.match(r.stdout, /DRIVER:local/);
  assert.match(r.stderr, /STORAGE_DRIVER=local in production/i);
  assert.match(r.stderr, /S3/);
});

test('production + STORAGE_DRIVER=local: an actual upload attempt fails with a clear, actionable error, never a raw filesystem exception', async () => {
  const r = run(`
    const { saveImage } = await import('file://${storagePath}');
    try {
      await saveImage({ dataUrl: '${TINY_PNG_DATA_URL}', clientId: 'cl_test', scope: 'photos', fileId: 'pho_test' });
      console.log('UNEXPECTED_SUCCESS');
    } catch (e) {
      console.log('CAUGHT:' + e.message);
    }
  `, { STORAGE_DRIVER: undefined });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /UNEXPECTED_SUCCESS/, 'a local-driver upload must never appear to succeed in production');
  assert.match(r.stdout, /CAUGHT:/);
  assert.match(r.stdout, /production/i);
  assert.match(r.stdout, /STORAGE_DRIVER=s3/);
  assert.doesNotMatch(r.stdout, /EROFS|ENOENT/, 'must be the clear custom message, not a raw fs error leaking a path');
});

test('development (not production): STORAGE_DRIVER=local still works exactly as before -- this gate is production-only', async () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { saveImage } = await import('file://${storagePath}');
    const r = await saveImage({ dataUrl: '${TINY_PNG_DATA_URL}', clientId: 'cl_devtest', scope: 'tmp', fileId: 'pho_devtest_' + Date.now() });
    console.log('OK:' + r.storage);
  `], { env: { PATH: process.env.PATH, NODE_ENV: 'development' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /OK:local/);
});
