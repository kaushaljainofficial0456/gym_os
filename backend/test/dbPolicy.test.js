// ============================================================
// Database policy guard tests (backend/src/config.js).
//
// Policy: PostgreSQL/Neon is the ONLY database for staging and
// production. SQLite exists for local development/tests only.
//   development + no DATABASE_URL       -> SQLite allowed (boots)
//   production  + no DATABASE_URL       -> refuses to start (FATAL)
//   staging     + no DATABASE_URL       -> refuses to start (FATAL)
//   production  + PG DATABASE_URL       -> PostgreSQL mode accepted
//   production  + admin role in URL     -> refuses to start (FATAL)
//
// config.js gates at import time, so each case boots a subprocess
// (same convention as the existing production JWT-secret test in
// intelligence2.test.js). Fake credentials only — never real ones.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.resolve(__dirname, '..', 'src', 'config.js').replace(/\\/g, '/');

// Passes the production JWT gate so ONLY the database guard is under test.
const STRONG_SECRET = 'x'.repeat(32);
const PG_URL = 'postgresql://skos_app:testpass@example.invalid/neondb?sslmode=verify-full';
// Also passes config.js's production payment-provider gate -- these tests
// are about the DATABASE guard specifically, not payments, so a
// 'production' scenario here needs a fully-configured payment provider
// just to get PAST that unrelated gate (which runs before the database
// checks) and reach the database assertion actually under test. Harmless
// to include for the staging/development scenarios too, since that gate
// is production-only and ignores it either way.
const RAZORPAY_EXTRA = {
  PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_fakekeyfortest',
  RAZORPAY_KEY_SECRET: 'fake-key-secret-for-test-only', RAZORPAY_WEBHOOK_SECRET: 'fake-webhook-secret-for-test-only',
};

function loadConfig({ nodeEnv, databaseUrl }) {
  const env = { PATH: process.env.PATH, NODE_ENV: nodeEnv, JWT_SECRET: STRONG_SECRET, ...RAZORPAY_EXTRA };
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { config } = await import('file://${cfgPath}');
    console.log('DB:' + (config.databaseUrl ? 'postgres' : 'sqlite') + ':ENV:' + config.nodeEnv);
  `], { env, encoding: 'utf8', timeout: 10000 });
  return { status: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

test('development + no DATABASE_URL -> SQLite allowed (app boots)', () => {
  const r = loadConfig({ nodeEnv: 'development' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DB:sqlite:ENV:development/);
});

test('development + PostgreSQL DATABASE_URL -> PostgreSQL mode accepted', () => {
  const r = loadConfig({ nodeEnv: 'development', databaseUrl: PG_URL });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DB:postgres:ENV:development/);
});

test('production + no DATABASE_URL -> refuses to start (never SQLite in production)', () => {
  const r = loadConfig({ nodeEnv: 'production' });
  assert.notEqual(r.status, 0, 'production without DATABASE_URL must exit non-zero');
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /DATABASE_URL/);
});

test('staging + no DATABASE_URL -> refuses to start (never SQLite in staging)', () => {
  const r = loadConfig({ nodeEnv: 'staging' });
  assert.notEqual(r.status, 0, 'staging without DATABASE_URL must exit non-zero');
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /DATABASE_URL/);
});

test('production + PostgreSQL DATABASE_URL -> configuration accepted', () => {
  const r = loadConfig({ nodeEnv: 'production', databaseUrl: PG_URL });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DB:postgres:ENV:production/);
});

test('production + admin role (neondb_owner) in DATABASE_URL -> refuses to start', () => {
  const r = loadConfig({
    nodeEnv: 'production',
    databaseUrl: 'postgresql://neondb_owner:testpass@example.invalid/neondb?sslmode=verify-full'
  });
  assert.notEqual(r.status, 0, 'admin role in production DATABASE_URL must exit non-zero');
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /neondb_owner/);
});
