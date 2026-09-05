// ============================================================
// F-06 REGRESSION: production security headers on API responses.
//
// Boots the real buildApp() in a subprocess (same technique as
// paymentProductionGate.route.test.js -- see that file's header for why
// a subprocess and a throwaway SQLite path, never the real dev DB, are
// needed) and checks the header set on a plain, unauthenticated
// /api/health response. The FRONTEND's own headers (a different CSP,
// permitting Razorpay/Google/camera) are set by vercel.json, not this
// Express app, and are exercised separately -- see vite.config.js's
// `preview.headers`, verified live against the real production build.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const SCRATCH_SQLITE = path.join(os.tmpdir(), `skos-test-headers-${process.pid}-${Date.now()}.db`).replace(/\\/g, '/');

function runServerProbe(nodeEnv, extraEnv) {
  const env = {
    PATH: process.env.PATH, NODE_ENV: nodeEnv, JWT_SECRET: 'x'.repeat(32),
    ...extraEnv,
  };
  const script = `
    const { buildApp } = await import('file://${ROOT}/backend/src/index.js');
    const http = await import('node:http');
    const app = await buildApp();
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const res = await fetch('http://127.0.0.1:' + port + '/api/health');
    const headers = {};
    for (const [k, v] of res.headers) headers[k] = v;
    console.log('RESULT_JSON:' + JSON.stringify(headers));
    server.close();
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 15000 });
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON:'));
  return { status: child.status, headers: line ? JSON.parse(line.slice('RESULT_JSON:'.length)) : null, stderr: child.stderr };
}

const FULL_RAZORPAY_ENV = {
  DATABASE_URL: 'postgresql://skos_app:testpass@example.invalid/neondb?sslmode=verify-full',
  PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_fake', RAZORPAY_KEY_SECRET: 'fake-key-secret', RAZORPAY_WEBHOOK_SECRET: 'fake-webhook-secret',
};

test('production: x-powered-by is absent', () => {
  const r = runServerProbe('production', FULL_RAZORPAY_ENV);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('production: API responses carry a locked-down CSP (default-src none)', () => {
  const r = runServerProbe('production', FULL_RAZORPAY_ENV);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('production: Strict-Transport-Security is present', () => {
  const r = runServerProbe('production', FULL_RAZORPAY_ENV);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.headers['strict-transport-security'], /max-age=\d+/);
  // No includeSubDomains/preload -- see index.js's own comment on why
  // those are not set speculatively without a confirmed custom domain.
  assert.doesNotMatch(r.headers['strict-transport-security'], /includeSubDomains/);
  assert.doesNotMatch(r.headers['strict-transport-security'], /preload/);
});

test('production: the rest of the existing header set is unchanged (no regression)', () => {
  const r = runServerProbe('production', FULL_RAZORPAY_ENV);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['x-xss-protection'], '0');
  assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(r.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=(), payment=()');
});

test('development: no HSTS header (must never force HTTPS on localhost)', () => {
  const r = runServerProbe('development', { SQLITE_PATH: SCRATCH_SQLITE });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.headers['strict-transport-security'], undefined);
  assert.equal(r.headers['x-powered-by'], undefined, 'x-powered-by stays disabled in every environment, not just production');
});

test.after(async () => {
  const { rm } = await import('node:fs/promises');
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(SCRATCH_SQLITE + suffix, { force: true }).catch(() => {});
  }
});
