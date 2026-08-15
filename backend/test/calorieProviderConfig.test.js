// ============================================================
// Phase 3A Step 2 — calorie model provider configuration tests.
//
// config.js is the SINGLE source of truth for CALORIE_MODEL_PROVIDER:
// it is parsed/validated once at startup and resolveProvider() returns
// config.calorieModelProvider — mutating process.env afterwards has no
// effect. Provider-dependent behavior therefore runs in isolated
// subprocesses (helpers/providerRunner.js) where the env var is set
// before any import, the same boundary production uses.
//
//   A. development + missing  -> baseline
//   B. development + baseline -> baseline
//   C. development + mock     -> mock
//   D. development + ml       -> ml
//   E. development + invalid  -> baseline + warning
//   F. production + invalid   -> startup failure (FATAL)
//   G. staging    + invalid   -> startup failure (FATAL)
//   H. production + valid     -> used
//   I. runtime mutation       -> provider stays at the startup value
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCalorieProvider, CALORIE_PROVIDERS, DEFAULT_CALORIE_PROVIDER } from '../src/config.js';
import { runWithProvider, MODULES } from './helpers/providerRunner.js';

const STRONG_SECRET = 'x'.repeat(32);
const PG_URL = 'postgresql://skos_app:testpass@example.invalid/neondb?sslmode=verify-full';
const PROD_EXTRA = { JWT_SECRET: STRONG_SECRET, DATABASE_URL: PG_URL };

// ---------------- parseCalorieProvider unit tests (pure) ----------------

test('supported providers are exactly: baseline, mock, ml', () => {
  assert.deepEqual(CALORIE_PROVIDERS, ['baseline', 'mock', 'ml']);
  assert.equal(DEFAULT_CALORIE_PROVIDER, 'baseline');
});

test('parseCalorieProvider: baseline/mock/ml configurations are valid', () => {
  assert.deepEqual(parseCalorieProvider('baseline'), { ok: true, value: 'baseline' });
  assert.deepEqual(parseCalorieProvider('mock'), { ok: true, value: 'mock' });
  assert.deepEqual(parseCalorieProvider('ml'), { ok: true, value: 'ml' });
});

test('parseCalorieProvider: invalid provider is rejected (never silently mapped)', () => {
  const r = parseCalorieProvider('xgboost');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('parseCalorieProvider: empty/missing provider treated as missing (default applies)', () => {
  assert.equal(parseCalorieProvider('').reason, 'missing');
  assert.equal(parseCalorieProvider(undefined).reason, 'missing');
  assert.equal(parseCalorieProvider(null).reason, 'missing');
});

test('parseCalorieProvider: normalizes case and whitespace consistently', () => {
  assert.equal(parseCalorieProvider('  ML ').value, 'ml');
  assert.equal(parseCalorieProvider('Baseline').value, 'baseline');
  assert.equal(parseCalorieProvider('MOCK').value, 'mock');
});

// ---------------- resolveProvider + startup behavior (subprocess) ----------------

const RESOLVE_SNIPPET = `
  const { config } = await import('${MODULES.config}');
  const { resolveProvider } = await import('${MODULES.calorieModel}');
  console.log('RESOLVED:' + resolveProvider() + ':CONFIG:' + config.calorieModelProvider + ':ENV:' + config.nodeEnv);
`;

test('A. development + missing provider -> baseline', () => {
  const r = runWithProvider({ nodeEnv: 'development', snippet: RESOLVE_SNIPPET });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESOLVED:baseline:CONFIG:baseline:ENV:development/);
});

test('B. development + baseline -> baseline', () => {
  const r = runWithProvider({ nodeEnv: 'development', provider: 'baseline', snippet: RESOLVE_SNIPPET });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESOLVED:baseline/);
});

test('C. development + mock -> mock', () => {
  const r = runWithProvider({ nodeEnv: 'development', provider: 'mock', snippet: RESOLVE_SNIPPET });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESOLVED:mock/);
});

test('D. development + ml -> ml', () => {
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: RESOLVE_SNIPPET });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESOLVED:ml/);
});

test('E. development + invalid provider -> baseline + warning (never silent)', () => {
  const r = runWithProvider({ nodeEnv: 'development', provider: 'bogus', snippet: RESOLVE_SNIPPET });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESOLVED:baseline/);
  assert.match(r.stderr, /WARN/);
  assert.match(r.stderr, /CALORIE_MODEL_PROVIDER/);
});

test('F. production + invalid provider -> refuses to start (FATAL)', () => {
  const r = runWithProvider({ nodeEnv: 'production', provider: 'bogus', snippet: RESOLVE_SNIPPET, extraEnv: PROD_EXTRA });
  assert.notEqual(r.status, 0, 'invalid provider in production must exit non-zero');
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /CALORIE_MODEL_PROVIDER/);
});

test('G. staging + invalid provider -> refuses to start (FATAL)', () => {
  const r = runWithProvider({ nodeEnv: 'staging', provider: 'xgboost', snippet: RESOLVE_SNIPPET, extraEnv: PROD_EXTRA });
  assert.notEqual(r.status, 0, 'invalid provider in staging must exit non-zero');
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /CALORIE_MODEL_PROVIDER/);
});

test('H. production + valid provider is used (ml, mock, baseline)', () => {
  for (const provider of ['ml', 'mock', 'baseline']) {
    const r = runWithProvider({ nodeEnv: 'production', provider, snippet: RESOLVE_SNIPPET, extraEnv: PROD_EXTRA });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`RESOLVED:${provider}`));
  }
});

test('H2. production + missing provider -> safe baseline default', () => {
  const r = runWithProvider({ nodeEnv: 'production', snippet: RESOLVE_SNIPPET, extraEnv: PROD_EXTRA });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESOLVED:baseline:CONFIG:baseline/);
});

test('I. runtime mutation of CALORIE_MODEL_PROVIDER does NOT change the provider', () => {
  // Start with baseline (default), then mutate the env at runtime and confirm
  // resolveProvider() still returns the startup-resolved baseline.
  const snippet = `
    const { resolveProvider } = await import('${MODULES.calorieModel}');
    const before = resolveProvider();
    process.env.CALORIE_MODEL_PROVIDER = 'ml';
    const after = resolveProvider();
    console.log('BEFORE:' + before + ':AFTER:' + after);
  `;
  const r = runWithProvider({ nodeEnv: 'development', snippet });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BEFORE:baseline:AFTER:baseline/, 'runtime env mutation must not switch the provider');
});
