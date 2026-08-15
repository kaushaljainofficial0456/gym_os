// ============================================================
// Phase 3A Step 1 — calorie output validation gate tests.
//   * validateCalorieResult(): valid result, NaN/negative/absurd
//     estimated kcal, invalid lower/upper bounds, inverted range,
//     estimate outside range, missing model_version, invalid
//     provider, wrong schema_version (stamped by backend, never
//     trusted from the model)
//   * invalid ML output -> falls back to baseline, provider
//     truthfully persisted as 'baseline' (unit + route-level)
//   * baseline/mock outputs always pass the gate (behavior preserved)
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

const {
  estimateWorkoutCalories,
  validateCalorieResult,
  baselineEstimate,
  CALORIE_SCHEMA_VERSION,
  MAX_ACTIVE_KCAL,
  __setMlEstimateForTests
} = await import('../src/services/intelligence/calorieModel.js');

const INPUT = { user: { body_weight_kg: 70 }, session: { duration_minutes: 30, intensity_rating: 'moderate' }, exercises: [] };

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

test('baseline and mock outputs always pass the gate (behavior preserved)', () => {
  const prev = process.env.CALORIE_MODEL_PROVIDER;
  try {
    const b = baselineEstimate(INPUT);
    assert.equal(validateCalorieResult(b).ok, true);
    process.env.CALORIE_MODEL_PROVIDER = 'mock';
    const m = estimateWorkoutCalories(INPUT);
    assert.equal(m.provider, 'mock');
    assert.equal(validateCalorieResult(m).ok, true);
  } finally {
    if (prev === undefined) delete process.env.CALORIE_MODEL_PROVIDER;
    else process.env.CALORIE_MODEL_PROVIDER = prev;
  }
});

// ---------------- invalid ML output -> baseline fallback ----------------

test('invalid ML output falls back to baseline, never persisted raw (unit)', () => {
  const prev = process.env.CALORIE_MODEL_PROVIDER;
  __setMlEstimateForTests(() => ({ estimated_active_kcal: -999, lower_kcal: 0, upper_kcal: 0, model_version: 'skos-cal-test-v1' }));
  try {
    process.env.CALORIE_MODEL_PROVIDER = 'ml';
    const out = estimateWorkoutCalories(INPUT);
    assert.equal(out.provider, 'baseline', 'fallback is truthfully labeled baseline');
    assert.equal(out.model_version, 'skos-cal-baseline-v1');
    assert.ok(out.estimated_active_kcal > 0, 'fallback produces a sane positive estimate');
    assert.ok(out.note && out.note.includes('fallback') && out.note.includes('invalid'), 'fallback labeled as invalid-output fallback');
    assert.equal(out.schema_version, CALORIE_SCHEMA_VERSION);
  } finally {
    __setMlEstimateForTests(null);
    if (prev === undefined) delete process.env.CALORIE_MODEL_PROVIDER;
    else process.env.CALORIE_MODEL_PROVIDER = prev;
  }
});

test('valid ML output is accepted and stamped (gate does not break a real model)', () => {
  const prev = process.env.CALORIE_MODEL_PROVIDER;
  __setMlEstimateForTests(() => ({ estimated_active_kcal: 310, lower_kcal: 260, upper_kcal: 360, model_version: 'skos-cal-mlv1' }));
  try {
    process.env.CALORIE_MODEL_PROVIDER = 'ml';
    const out = estimateWorkoutCalories(INPUT);
    assert.equal(out.provider, 'ml');
    assert.equal(out.estimated_active_kcal, 310);
    assert.equal(out.model_version, 'skos-cal-mlv1');
    assert.equal(out.schema_version, CALORIE_SCHEMA_VERSION);
  } finally {
    __setMlEstimateForTests(null);
    if (prev === undefined) delete process.env.CALORIE_MODEL_PROVIDER;
    else process.env.CALORIE_MODEL_PROVIDER = prev;
  }
});

// ---------------- route-level: fallback persisted as provider='baseline' ----------------

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

async function workoutApi() {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'c@a.in', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'FAT_LOSS', 30, 'M', 175, 80, 78, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ['libA', 'Bench Press', 'CHEST', 'BARBELL', 'horizontal_push', 'compound']);
  await db.run(`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, 'assigned', ?)`,
    ['wko_1', 'o1', 'c1', 'Push Day', '2026-08-15', '2026-08-15T00:00:00Z']);
  await db.run(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['wxeA', 'wko_1', 'libA', 0, 'Bench Press', 3, '10', '60', 90]);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/workouts', workoutRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client One' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close, wId: 'wko_1' };
}

test('invalid ML output at /complete: workout commits, calorie persisted as baseline', async (t) => {
  const prev = process.env.CALORIE_MODEL_PROVIDER;
  __setMlEstimateForTests(() => ({ estimated_active_kcal: Number.POSITIVE_INFINITY, lower_kcal: 0, upper_kcal: 0, model_version: '' }));
  try {
    process.env.CALORIE_MODEL_PROVIDER = 'ml';
    const { db, call, close, wId } = await workoutApi();
    t.after(() => close());
    const r = await call('POST', `/workouts/${wId}/complete`, {
      logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }]
    });
    assert.equal(r.status, 200, 'workout completion never fails on bad ML output');
    const w = await db.q1('SELECT status, estimated_active_kcal, lower_kcal, upper_kcal, model_version, schema_version, calorie_provider FROM workouts WHERE id = ?', [wId]);
    assert.equal(w.status, 'completed', 'workout still commits');
    assert.ok(w.estimated_active_kcal > 0, 'sane baseline estimate persisted, never the invalid ML value');
    assert.ok(w.lower_kcal <= w.estimated_active_kcal && w.estimated_active_kcal <= w.upper_kcal, 'range wraps midpoint');
    assert.equal(w.model_version, 'skos-cal-baseline-v1');
    assert.equal(w.schema_version, CALORIE_SCHEMA_VERSION);
    assert.equal(w.calorie_provider, 'baseline', 'fallback truthfully persisted as baseline — never mislabeled ml');
  } finally {
    __setMlEstimateForTests(null);
    if (prev === undefined) delete process.env.CALORIE_MODEL_PROVIDER;
    else process.env.CALORIE_MODEL_PROVIDER = prev;
  }
});
