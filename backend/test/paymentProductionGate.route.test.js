// ============================================================
// F-02 REGRESSION (live-server half): POST /api/payments/mock/complete
// is never even MOUNTED on a production-booted Express app -- see
// paymentProductionGate.test.js's own header for the config.js boot-gate
// half of this fix, and index.js's comment at the mount site for why both
// layers exist independently.
//
// Boots the REAL buildApp() in a subprocess with NODE_ENV=production +
// a full, fully-configured live payment provider (so config.js's own
// boot gate doesn't reject the process before we even get to test the
// route) and a syntactically-valid-but-unreachable DATABASE_URL
// (postgresql://...@example.invalid/..., same convention as
// dbPolicy.test.js's own PG_URL -- .invalid never resolves). This never
// needs a real Postgres connection: getDb()/pg.Pool only connects lazily
// on the first actual query, and hitting an UNMOUNTED route 404s at
// Express's own routing layer, long before any handler (or the DB) is
// ever touched.
//
// Subprocess, not an in-process import, for the same reason every other
// paymentProvider.js/config.js test here is subprocess-based: both
// modules read their env as module-load-time consts, so a genuinely
// different NODE_ENV needs a genuinely fresh process.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
// The development-mode scenario below boots the real buildApp() with no
// DATABASE_URL, which means getDb() opens SQLite at config.sqlitePath --
// defaulting to backend/data/physique.db, the REAL local dev database, if
// left unset. An absolute SQLITE_PATH overrides that default entirely
// (db.js's path.resolve treats a later absolute segment as authoritative),
// so this points every subprocess here at a throwaway file instead --
// the real dev DB is never opened, let alone written to, by this test.
const SCRATCH_SQLITE = path.join(os.tmpdir(), `skos-test-paymentgate-${process.pid}-${Date.now()}.db`).replace(/\\/g, '/');

const STRONG_SECRET = 'x'.repeat(32);
const PG_URL = 'postgresql://skos_app:testpass@example.invalid/neondb?sslmode=verify-full';

// Runs a fresh Node subprocess that boots the real buildApp(), fires the
// given requests at it, prints their statuses as JSON, and exits.
function runServerProbe(nodeEnv, extraEnv, requests) {
  const env = {
    PATH: process.env.PATH, NODE_ENV: nodeEnv, JWT_SECRET: STRONG_SECRET, DATABASE_URL: PG_URL,
    ...extraEnv,
  };
  const script = `
    const { buildApp } = await import('file://${ROOT}/backend/src/index.js');
    const http = await import('node:http');
    const app = await buildApp();
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = 'http://127.0.0.1:' + port;
    const results = [];
    for (const req of ${JSON.stringify(requests)}) {
      const res = await fetch(base + req.path, { method: req.method || 'GET', headers: req.headers || {} });
      results.push({ path: req.path, status: res.status });
    }
    // buildApp() installs its own access-log middleware, which
    // console.logs a "[req] ..." line for every request it handles --
    // including these probe requests. Prefixing this line makes the real
    // result trivially extractable from stdout regardless of how many
    // access-log lines land before or after it.
    console.log('RESULT_JSON:' + JSON.stringify(results));
    server.close();
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 15000 });
  const resultLine = (child.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON:'));
  return { status: child.status, stdout: resultLine ? resultLine.slice('RESULT_JSON:'.length).trim() : '', stderr: child.stderr || '' };
}

const FULL_RAZORPAY_ENV = {
  PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest',
  RAZORPAY_KEY_SECRET: 'fake-key-secret-for-test-only',
  RAZORPAY_WEBHOOK_SECRET: 'fake-webhook-secret-for-test-only',
};

test('production: POST /api/payments/mock/complete is unmounted -> 404 (route does not exist)', () => {
  const r = runServerProbe('production', FULL_RAZORPAY_ENV, [
    { path: '/api/payments/mock/complete', method: 'POST', headers: { 'content-type': 'application/json' } },
    { path: '/api/payments/provider', method: 'GET' },
  ]);
  assert.equal(r.status, 0, `subprocess should boot and exit cleanly; stderr: ${r.stderr}`);
  const results = JSON.parse(r.stdout);
  const complete = results.find((x) => x.path === '/api/payments/mock/complete');
  const provider = results.find((x) => x.path === '/api/payments/provider');
  assert.equal(complete.status, 404, 'the mock-checkout bridge must not exist as a route at all in production, not merely reject with 409');
  assert.equal(provider.status, 404, 'the whole /api/payments router is unmounted in production, not just the /mock/complete route');
});

test('development: POST /api/payments/mock/complete IS mounted (mock testing stays available outside production)', () => {
  const r = runServerProbe('development', { SQLITE_PATH: SCRATCH_SQLITE, DATABASE_URL: '' }, [
    { path: '/api/payments/provider', method: 'GET' },
  ]);
  assert.equal(r.status, 0, `subprocess should boot and exit cleanly; stderr: ${r.stderr}`);
  const results = JSON.parse(r.stdout);
  const provider = results.find((x) => x.path === '/api/payments/provider');
  // GET /provider has no auth requirement of its own beyond requireAuth on
  // the router -- 401 (no token supplied) proves the ROUTE EXISTS and was
  // reached (an unmounted route would 404 instead, exactly like the
  // production case above); this test is about mounting, not about
  // completing an authenticated call.
  assert.equal(provider.status, 401, 'the route must exist (401 = reached requireAuth, not 404 = route missing) outside production');
});

test.after(async () => {
  // The development-mode scenario above creates a real (throwaway) SQLite
  // file + WAL/SHM siblings on disk; clean them up rather than leaking
  // them into the OS temp directory on every test run.
  const { rm } = await import('node:fs/promises');
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(SCRATCH_SQLITE + suffix, { force: true }).catch(() => {});
  }
});
