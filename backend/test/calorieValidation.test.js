// ============================================================
// Phase 3A Step 1 + 2 — calorie output validation gate tests.
//   * validateCalorieResult(): valid result, NaN/negative/absurd
//     estimated kcal, invalid lower/upper bounds, inverted range,
//     estimate outside range, missing model_version, invalid
//     provider, wrong schema_version (stamped by backend, never
//     trusted from the model)
//   * baseline/mock outputs always pass the gate (behavior preserved)
//   * invalid ML output -> falls back to baseline, provider
//     truthfully persisted as 'baseline'
//
// Provider-dependent behavior runs in isolated subprocesses
// (helpers/providerRunner.js): config.js resolves the provider once
// at startup, so the env must be set before any import.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateCalorieResult, baselineEstimate, CALORIE_SCHEMA_VERSION, MAX_ACTIVE_KCAL } from '../src/services/intelligence/calorieModel.js';
import { runWithProvider, MODULES } from './helpers/providerRunner.js';

const INPUT = () => ({ user: { body_weight_kg: 70 }, session: { duration_minutes: 30, intensity_rating: 'moderate' }, exercises: [] });

// A well-formed provider result (as Sambhav's model would return).
const VALID = () => ({
  schema_version: '9.9', // model-provided value — must be IGNORED/stamped by the backend
  estimated_active_kcal: 300,
  lower_kcal: 255,
  upper_kcal: 345,
  model_version: 'skos-cal-test-v1',
  provider: 'ml'
});

// ---------------- validateCalorieResult unit tests ----------------

test('valid result passes the gate and schema_version is stamped by the backend', () => {
  const check = validateCalorieResult(VALID());
  assert.equal(check.ok, true);
  assert.equal(check.result.schema_version, CALORIE_SCHEMA_VERSION, 'model-provided schema_version ignored');
  assert.equal(check.result.estimated_active_kcal, 300);
});

test('NaN estimated calories -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), estimated_active_kcal: NaN });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /estimated_active_kcal/);
});

test('negative estimated calories -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), estimated_active_kcal: -5 });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /estimated_active_kcal/);
});

test('absurdly large estimated calories -> rejected (documented sane max)', () => {
  assert.ok(MAX_ACTIVE_KCAL > 0 && MAX_ACTIVE_KCAL <= 2000, 'sane maximum documented and bounded');
  const check = validateCalorieResult({ ...VALID(), estimated_active_kcal: MAX_ACTIVE_KCAL + 1 });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /sane maximum/);
});

test('invalid lower bound (negative) -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), lower_kcal: -1 });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /lower_kcal/);
});

test('invalid lower bound (NaN) -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), lower_kcal: NaN });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /lower_kcal/);
});

test('invalid upper bound (negative) -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), upper_kcal: -1 });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /upper_kcal/);
});

test('invalid upper bound (NaN) -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), upper_kcal: NaN });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /upper_kcal/);
});

test('inverted range (lower > upper) -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), estimated_active_kcal: 300, lower_kcal: 400, upper_kcal: 200 });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /range violated/);
});

test('estimate outside range (est > upper) -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), estimated_active_kcal: 300, lower_kcal: 200, upper_kcal: 250 });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /range violated/);
});

test('estimate outside range (est < lower) -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), estimated_active_kcal: 100, lower_kcal: 200, upper_kcal: 345 });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /range violated/);
});

test('missing model_version -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), model_version: '  ' });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /model_version/);
});

test('invalid provider -> rejected', () => {
  const check = validateCalorieResult({ ...VALID(), provider: 'xgboost' });
  assert.equal(check.ok, false);
  assert.match(check.issues.join(' '), /provider/);
});

test('wrong schema_version is enforced, not trusted', () => {
  // model claims an old/invalid version — the gate stamps the backend's version
  const check = validateCalorieResult({ ...VALID(), schema_version: '0.1' });
  assert.equal(check.ok, true);
  assert.equal(check.result.schema_version, CALORIE_SCHEMA_VERSION);
});

test('baseline output always passes the gate (behavior preserved)', () => {
  const b = baselineEstimate(INPUT());
  assert.equal(b.provider, 'baseline');
  assert.equal(validateCalorieResult(b).ok, true);
});

// ---------------- provider-dependent behavior (subprocess) ----------------

const OUT_SNIPPET = `
  const cal = await import('${MODULES.calorieModel}');
  const out = cal.estimateWorkoutCalories(${JSON.stringify(INPUT())});
  console.log('OUT:' + JSON.stringify({
    provider: out.provider, model_version: out.model_version,
    est: out.estimated_active_kcal, schema_version: out.schema_version,
    note: out.note || null, gateOk: cal.validateCalorieResult(out).ok
  }));
`;

test('mock provider output is labeled and always passes the gate', () => {
  const r = runWithProvider({ nodeEnv: 'development', provider: 'mock', snippet: OUT_SNIPPET });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.provider, 'mock');
  assert.equal(out.model_version, 'skos-cal-mock-v1');
  assert.equal(out.est, 300);
  assert.equal(out.gateOk, true);
});

test('invalid ML output falls back to baseline, never persisted raw', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: -999, lower_kcal: 0, upper_kcal: 0, model_version: 'skos-cal-test-v1' }));
    const out = cal.estimateWorkoutCalories(${JSON.stringify(INPUT())});
    console.log('OUT:' + JSON.stringify({
      provider: out.provider, model_version: out.model_version,
      est: out.estimated_active_kcal, schema_version: out.schema_version,
      note: out.note || null
    }));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.provider, 'baseline', 'fallback is truthfully labeled baseline');
  assert.equal(out.model_version, 'skos-cal-baseline-v1');
  assert.ok(out.est > 0, 'fallback produces a sane positive estimate');
  assert.ok(out.note && out.note.includes('fallback') && out.note.includes('invalid'), 'fallback labeled as invalid-output fallback');
  assert.equal(out.schema_version, CALORIE_SCHEMA_VERSION);
});

test('valid ML output is accepted and stamped (gate does not break a real model)', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: 310, lower_kcal: 260, upper_kcal: 360, model_version: 'skos-cal-mlv1' }));
    const out = cal.estimateWorkoutCalories(${JSON.stringify(INPUT())});
    console.log('OUT:' + JSON.stringify({
      provider: out.provider, model_version: out.model_version,
      est: out.estimated_active_kcal, schema_version: out.schema_version
    }));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.provider, 'ml');
  assert.equal(out.est, 310);
  assert.equal(out.model_version, 'skos-cal-mlv1');
  assert.equal(out.schema_version, CALORIE_SCHEMA_VERSION);
});

test('invalid ML output is persisted as provider="baseline" (never raw)', () => {
  // Subprocess: provider=ml set before import, fake model returns garbage,
  // estimate + persist against a real in-memory DB, then inspect the row.
  const snippet = `
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(fs.readFileSync('${MODULES.schema}', 'utf8'));
    db.exec("INSERT INTO organizations (id, name, slug, created_at) VALUES ('o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z')");
    db.exec("INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'c@a.in', 'x', 'CLIENT', 'C', 1, '2026-01-01T00:00:00Z')");
    db.exec("INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES ('c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z')");
    db.exec("INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at) VALUES ('wko_1', 'o1', 'c1', 'Push Day', '2026-08-15', 'assigned', '2026-08-15T00:00:00Z')");
    const adapter = {
      async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
      async q1(sql, params = []) { const stmt = db.prepare(sql); const rows = params.length ? stmt.all(...params) : stmt.all(); return rows[0] || null; },
      async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); }
    };
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: Number.POSITIVE_INFINITY, lower_kcal: 0, upper_kcal: 0, model_version: '' }));
    const out = cal.estimateWorkoutCalories(${JSON.stringify(INPUT())});
    await cal.persistCalorieResult(adapter, 'wko_1', out);
    const w = await adapter.q1('SELECT estimated_active_kcal, lower_kcal, upper_kcal, model_version, schema_version, calorie_provider FROM workouts WHERE id = ?', ['wko_1']);
    console.log('ROW:' + JSON.stringify(w));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const w = JSON.parse(r.stdout.match(/ROW:(\{.*\})/)[1]);
  assert.ok(w.estimated_active_kcal > 0, 'sane baseline estimate persisted, never the invalid ML value');
  assert.ok(w.lower_kcal <= w.estimated_active_kcal && w.estimated_active_kcal <= w.upper_kcal, 'range wraps midpoint');
  assert.equal(w.model_version, 'skos-cal-baseline-v1');
  assert.equal(w.schema_version, CALORIE_SCHEMA_VERSION);
  assert.equal(w.calorie_provider, 'baseline', 'fallback truthfully persisted as baseline — never mislabeled ml');
});
