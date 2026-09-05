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
// storage.js now fails loudly for 'local' in production (a clear,
// actionable Error) instead of attempting an unsafe write, and logs a
// boot-time warning -- same "operator misconfiguration is an obvious
// error" posture as paymentProductionGate.test.js's config.js gate.
// Needs subprocess isolation because config.nodeEnv (which storage.js
// reads) is resolved once at import time from env vars.
//
// The 's3' driver itself (real @aws-sdk/client-s3 calls -- works against
// AWS S3, Cloudflare R2, or Supabase Storage, all S3-API-compatible) is
// covered further down in this file via _setS3ClientForTests, an
// injectable-client test seam -- exactly the mocked-client posture
// upstashRateLimitStore.test.js already uses for the same reason: no
// live S3-compatible credentials exist in this environment, so this is
// contract-level verification (the driver sends the right S3 commands
// with the right parameters, handles a 404 correctly, never sets a
// public ACL), not proof against a real bucket.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

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

// ============================================================
// S3 DRIVER -- contract-level tests against an injected mock client.
// (STORAGE_DRIVER is read once from process.env at storage.js's own
// module-load time, but these tests need it set to 's3' for THIS
// process without affecting other test files run in the same suite --
// so this one file's env is set via a subprocess-free trick instead:
// directly overwrite the already-imported module's exported binding is
// not possible in ESM, so these run via the same spawnSync-subprocess
// pattern as the tests above, with a mock S3Client constructed inline
// in the child process and installed via _setS3ClientForTests before
// any real saveImage/deleteObject/getObjectStream call.)
// ============================================================

function runS3(code) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH, NODE_ENV: 'development', STORAGE_DRIVER: 's3' },
    encoding: 'utf8', timeout: 10000,
  });
  return { status: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

test('s3 driver: saveImage sends a PutObjectCommand with the right bucket/key/content-type, no public ACL', () => {
  const r = runS3(`
    const { saveImage, _setS3ClientForTests } = await import('file://${storagePath}');
    const calls = [];
    _setS3ClientForTests({ send: async (cmd) => { calls.push(cmd); return {}; } }, 'my-test-bucket');
    const result = await saveImage({ dataUrl: '${TINY_PNG_DATA_URL}', clientId: 'cl_s3test', scope: 'photos', fileId: 'pho_s3test' });
    const put = calls[0];
    console.log(JSON.stringify({
      resultStorage: result.storage,
      isPutObjectCommand: put.constructor.name,
      bucket: put.input.Bucket,
      key: put.input.Key,
      contentType: put.input.ContentType,
      hasAcl: 'ACL' in put.input,
      bodyIsBuffer: Buffer.isBuffer(put.input.Body),
    }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.resultStorage, 's3');
  assert.equal(out.isPutObjectCommand, 'PutObjectCommand');
  assert.equal(out.bucket, 'my-test-bucket');
  assert.equal(out.key, 'photos/cl_s3test/pho_s3test.png');
  assert.equal(out.contentType, 'image/png');
  assert.equal(out.hasAcl, false, 'must never set a public ACL -- the bucket stays private by default');
  assert.equal(out.bodyIsBuffer, true);
});

test('s3 driver: saveImage without STORAGE_S3_BUCKET/credentials configured fails with a clear, actionable error', () => {
  const r = runS3(`
    const { saveImage } = await import('file://${storagePath}');
    try {
      await saveImage({ dataUrl: '${TINY_PNG_DATA_URL}', clientId: 'cl_x', scope: 'photos', fileId: 'pho_x' });
      console.log('UNEXPECTED_SUCCESS');
    } catch (e) {
      console.log('CAUGHT:' + e.message);
    }
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CAUGHT:/);
  assert.match(r.stdout, /STORAGE_S3_BUCKET/);
  assert.match(r.stdout, /STORAGE_S3_ACCESS_KEY_ID/);
  assert.match(r.stdout, /STORAGE_S3_SECRET_ACCESS_KEY/);
});

test('s3 driver: deleteObject sends a DeleteObjectCommand for exactly the given key, and never throws on a client error (best-effort)', () => {
  const r = runS3(`
    const { deleteObject, _setS3ClientForTests } = await import('file://${storagePath}');
    const calls = [];
    _setS3ClientForTests({ send: async (cmd) => { calls.push(cmd); throw new Error('simulated S3 outage'); } }, 'my-test-bucket');
    await deleteObject('photos/cl_1/pho_1.png'); // must not throw despite the client rejecting
    const del = calls[0];
    console.log(JSON.stringify({ ok: true, isDeleteObjectCommand: del.constructor.name, key: del.input.Key, bucket: del.input.Bucket }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.equal(out.isDeleteObjectCommand, 'DeleteObjectCommand');
  assert.equal(out.key, 'photos/cl_1/pho_1.png');
  assert.equal(out.bucket, 'my-test-bucket');
});

test('s3 driver: getObjectStream returns the body + content-type for an existing key, and null (not a throw) for a missing one', () => {
  const r = runS3(`
    const { getObjectStream, _setS3ClientForTests } = await import('file://${storagePath}');
    const { Readable } = await import('node:stream');
    _setS3ClientForTests({
      send: async (cmd) => {
        if (cmd.input.Key === 'photos/cl_1/exists.png') {
          return { Body: Readable.from([Buffer.from('fake-image-bytes')]), ContentType: 'image/png' };
        }
        const err = new Error('NoSuchKey'); err.name = 'NoSuchKey';
        throw err;
      },
    }, 'my-test-bucket');
    const hit = await getObjectStream('photos/cl_1/exists.png');
    const miss = await getObjectStream('photos/cl_1/does-not-exist.png');
    console.log(JSON.stringify({ hitContentType: hit?.contentType, hitHasBody: !!hit?.body, miss }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.hitContentType, 'image/png');
  assert.equal(out.hitHasBody, true);
  assert.equal(out.miss, null);
});
