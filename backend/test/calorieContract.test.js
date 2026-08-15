// ============================================================
// Phase 2 — calorie contract v0.2 tests.
//   * input schema_version 0.2 (buildWorkoutCalorieInput)
//   * session aggregates: exercise_count, total_sets, total_reps,
//     total_volume_kg
//   * derived features: volume_per_minute, sets_per_minute,
//     reps_per_minute, relative_load, compound_set_ratio,
//     isolation_set_ratio
//   * per-exercise aggregates: sets, total_reps, total_volume_kg,
//     average_load_kg
//   * skipped exercises -> 0 sets/0 reps/0 volume
//   * zero/unknown weight (bodyweight sets)
//   * empty workout
//   * ML provider stub + baseline fallback + provider persistence
//   * server-authoritative timing: client started_at ignored,
//     future timestamps ignored, missing start -> null duration
//   * unknown exercise_id -> 422 (no silent skip, no partial write)
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { runWithProvider, MODULES } from './helpers/providerRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

const { estimateWorkoutCalories, buildWorkoutCalorieInput, completedSetCount } = await import('../src/services/intelligence/calorieModel.js');

// ---------------- fixtures for unit tests ----------------
const ex = (id, exId, name, exType, movement, equipment, muscle) => ({
  id, exercise_id: exId, name, ex_type: exType, movement, equipment, primary_muscle: muscle,
  library: { ex_type: exType, movement, equipment, primary_muscle: muscle }
});
const BENCH = ex('wxeA', 'libA', 'Bench Press', 'compound', 'horizontal_push', 'BARBELL', 'CHEST');
const PULLDOWN = ex('wxeB', 'libB', 'Lat Pulldown', 'compound', 'vertical_pull', 'CABLE', 'LATS');
const CURLS = ex('wxeC', 'libC', 'Dumbbell Curl', 'isolation', 'elbow_flexion', 'DUMBBELL', 'BICEPS');

const CLIENT = { age: 30, sex: 'M', height_cm: 175 };

function fullSession() {
  return buildWorkoutCalorieInput({
    client: CLIENT,
    workout: { id: 'wko_1' },
    exercises: [BENCH, PULLDOWN, CURLS],
    setsByExercise: {
      wxeA: [
        { set_number: 1, actual_reps: 10, actual_weight: 60, completed: 1 },
        { set_number: 2, actual_reps: 8, actual_weight: 60, completed: 1 },
        { set_number: 3, actual_reps: 8, actual_weight: 60, completed: 1 }
      ],
      wxeB: [
        { set_number: 1, actual_reps: 12, actual_weight: 50, completed: 1 },
        { set_number: 2, actual_reps: 12, actual_weight: 50, completed: 1 }
      ],
      wxeC: [
        { set_number: 1, actual_reps: 10, actual_weight: 15, completed: 1 },
        { set_number: 2, actual_reps: 10, actual_weight: 15, completed: 1 }
      ]
    },
    durationSeconds: 1800,
    bodyWeightKg: 78
  });
}

// ---------------- contract v0.2 ----------------
test('input contract is schema_version 0.2', () => {
  const input = fullSession();
  assert.equal(input.schema_version, '0.2');
  const out = estimateWorkoutCalories(input);
  assert.equal(out.schema_version, '0.2');
});

test('session aggregates: exercise_count, total_sets, total_reps, total_volume_kg', () => {
  const s = fullSession().session;
  assert.equal(s.exercise_count, 3);
  assert.equal(s.total_sets, 7);
  assert.equal(s.total_reps, 70); // 10+8+8+12+12+10+10
  assert.equal(s.total_volume_kg, 3060); // (600+480+480)+(600+600)+(150+150)
});

test('derived features: volume/sets/reps per minute, relative_load, ratios', () => {
  const s = fullSession().session;
  assert.equal(s.volume_per_minute, 102);       // 3060 / 30
  assert.equal(s.sets_per_minute, 0.23);        // 7 / 30
  assert.equal(s.reps_per_minute, 2.33);        // 70 / 30
  assert.equal(s.relative_load, 0.56);          // (3060/70) / 78
  assert.equal(s.compound_set_ratio, 0.71);     // 5 compound sets / 7
  assert.equal(s.isolation_set_ratio, 0.29);    // 2 isolation sets / 7
});

test('per-exercise aggregates: sets, total_reps, total_volume_kg, average_load_kg', () => {
  const es = fullSession().exercises;
  const bench = es.find((e) => e.exercise_id === 'libA');
  const curls = es.find((e) => e.exercise_id === 'libC');
  assert.deepEqual(
    { sets: bench.sets, total_reps: bench.total_reps, total_volume_kg: bench.total_volume_kg, average_load_kg: bench.average_load_kg },
    { sets: 3, total_reps: 26, total_volume_kg: 1560, average_load_kg: 60 }
  );
  assert.deepEqual(
    { sets: curls.sets, total_reps: curls.total_reps, total_volume_kg: curls.total_volume_kg, average_load_kg: curls.average_load_kg },
    { sets: 2, total_reps: 20, total_volume_kg: 300, average_load_kg: 15 }
  );
});

test('skipped exercises contribute 0 sets / 0 reps / 0 volume', () => {
  const input = buildWorkoutCalorieInput({
    client: CLIENT,
    workout: { id: 'wko_1' },
    exercises: [BENCH, PULLDOWN, CURLS],
    setsByExercise: { wxeA: [{ set_number: 1, actual_reps: 10, actual_weight: 60, completed: 1 }] },
    durationSeconds: 600,
    bodyWeightKg: 78
  });
  assert.equal(input.session.exercise_count, 1, 'only performed exercises count');
  assert.equal(input.session.total_sets, 1);
  assert.equal(input.session.total_reps, 10);
  assert.equal(input.session.total_volume_kg, 600);
  const skipped = input.exercises.find((e) => e.exercise_id === 'libB');
  assert.equal(skipped.sets, 0);
  assert.equal(skipped.total_reps, 0);
  assert.equal(skipped.total_volume_kg, 0);
  assert.equal(skipped.completed_sets.length, 0);
  assert.equal(completedSetCount(input), 1);
});

test('incomplete sets are excluded (only completed sets are features)', () => {
  const input = buildWorkoutCalorieInput({
    client: CLIENT,
    workout: { id: 'wko_1' },
    exercises: [BENCH],
    setsByExercise: {
      wxeA: [
        { set_number: 1, actual_reps: 10, actual_weight: 60, completed: 1 },
        { set_number: 2, actual_reps: 8, actual_weight: 60, completed: 0 } // skipped/incomplete
      ]
    },
    durationSeconds: 600,
    bodyWeightKg: 78
  });
  assert.equal(input.session.total_sets, 1);
  assert.equal(input.session.total_reps, 10);
  assert.equal(completedSetCount(input), 1);
});

test('zero/unknown weight (bodyweight) is not fabricated — volume 0, no crash', () => {
  const input = buildWorkoutCalorieInput({
    client: CLIENT,
    workout: { id: 'wko_1' },
    exercises: [BENCH],
    setsByExercise: {
      wxeA: [
        { set_number: 1, actual_reps: 15, actual_weight: 0, completed: 1 },
        { set_number: 2, actual_reps: 12, actual_weight: 0, completed: 1 }
      ]
    },
    durationSeconds: 600,
    bodyWeightKg: 78
  });
  const e = input.exercises[0];
  assert.equal(e.total_reps, 27);
  assert.equal(e.total_volume_kg, 0);
  assert.equal(e.average_load_kg, 0);
  assert.equal(input.session.total_volume_kg, 0);
  const out = estimateWorkoutCalories(input);
  assert.ok(Number.isFinite(out.estimated_active_kcal));
});

test('empty workout — zeros, null ratios, estimate still returns a labeled baseline', () => {
  const input = buildWorkoutCalorieInput({
    client: CLIENT,
    workout: { id: 'wko_1' },
    exercises: [],
    setsByExercise: {},
    durationSeconds: 600,
    bodyWeightKg: 78
  });
  assert.equal(input.session.exercise_count, 0);
  assert.equal(input.session.total_sets, 0);
  assert.equal(input.session.total_reps, 0);
  assert.equal(input.session.total_volume_kg, 0);
  assert.equal(input.session.relative_load, null);
  assert.equal(input.session.compound_set_ratio, null);
  assert.equal(input.session.isolation_set_ratio, null);
  const out = estimateWorkoutCalories(input);
  assert.equal(out.provider, 'baseline');
  assert.equal(out.schema_version, '0.2');
});

// ---------------- provider architecture (isolated subprocesses) ----------------
// config.js resolves CALORIE_MODEL_PROVIDER ONCE at startup (single source of
// truth), so provider-dependent behavior runs in subprocesses where the env
// is set before any import — the same boundary production uses.
test('ML provider is a stub today — falls back to baseline and is clearly labeled', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    const out = cal.estimateWorkoutCalories({
      user: { age: 30, sex: 'male', height_cm: 175, body_weight_kg: 78 },
      session: { duration_minutes: 30, intensity_rating: 'moderate' },
      exercises: []
    });
    console.log('OUT:' + JSON.stringify({ provider: out.provider, model_version: out.model_version, note: out.note || null }));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.provider, 'baseline', 'unimplemented ml provider falls back to baseline');
  assert.equal(out.model_version, 'skos-cal-baseline-v1');
  assert.ok(out.note && out.note.includes('fallback'), 'fallback is explicitly labeled');
  // never present a baseline result as an ML prediction
  assert.notEqual(out.provider, 'ml');
});

test('mock provider is clearly labeled as mock', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    const out = cal.estimateWorkoutCalories({
      user: { age: 30, sex: 'male', height_cm: 175, body_weight_kg: 78 },
      session: { duration_minutes: 30, intensity_rating: 'moderate' },
      exercises: []
    });
    console.log('OUT:' + JSON.stringify({ provider: out.provider, model_version: out.model_version, est: out.estimated_active_kcal }));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'mock', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.provider, 'mock');
  assert.equal(out.model_version, 'skos-cal-mock-v1');
  assert.equal(out.est, 300);
});

// ---------------- route-level hardening ----------------
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

const idp = (p) => 'id_' + Math.random().toString(36).slice(2, 10);

async function workoutApi() {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'c@a.in', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'FAT_LOSS', 30, 'M', 175, 80, 78, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ['libA', 'Bench Press', 'CHEST', 'BARBELL', 'horizontal_push', 'compound']);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ['libB', 'Lat Pulldown', 'LATS', 'CABLE', 'vertical_pull', 'compound']);
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

test('unknown exercise_id -> 422, workout not completed, nothing logged', async (t) => {
  const { db, call, close, wId } = await workoutApi();
  t.after(() => close());
  const r = await call('POST', `/workouts/${wId}/complete`, {
    logs: [{ exercise_id: 'wxeZZZ', sets: [{ actual_reps: 10, actual_weight: 60 }] }]
  });
  assert.equal(r.status, 422);
  assert.match(r.json.error, /does not belong/);
  const w = await db.q1('SELECT status FROM workouts WHERE id = ?', [wId]);
  assert.equal(w.status, 'assigned', 'workout untouched on 422');
  const logs = await db.q('SELECT * FROM workout_logs WHERE workout_id = ?', [wId]);
  assert.equal(logs.length, 0, 'no partial logging');
});

test('future client started_at is ignored (no fabricated duration)', async (t) => {
  const { db, call, close, wId } = await workoutApi();
  t.after(() => close());
  const r = await call('POST', `/workouts/${wId}/complete`, {
    started_at: new Date('2030-01-01T00:00:00Z').toISOString(),
    logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }]
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.duration_min, null, 'future client timestamp must not create a duration');
  const w = await db.q1('SELECT started_at, duration_min FROM workouts WHERE id = ?', [wId]);
  assert.equal(w.started_at, null);
  assert.equal(w.duration_min, null);
});

test('calorie result is persisted with provider + model_version + schema_version 0.2', async (t) => {
  const { db, call, close, wId } = await workoutApi();
  t.after(() => close());
  const r = await call('POST', `/workouts/${wId}/complete`, {
    logs: [{ exercise_id: 'wxeA', sets: [
      { actual_reps: 10, actual_weight: 60 },
      { actual_reps: 8, actual_weight: 60 }
    ] }]
  });
  assert.equal(r.status, 200);
  const w = await db.q1('SELECT estimated_active_kcal, lower_kcal, upper_kcal, model_version, schema_version, calorie_provider, calorie_estimated_at FROM workouts WHERE id = ?', [wId]);
  assert.ok(w.estimated_active_kcal > 0, 'estimate persisted');
  assert.ok(w.lower_kcal <= w.estimated_active_kcal && w.estimated_active_kcal <= w.upper_kcal, 'range wraps midpoint');
  assert.equal(w.model_version, 'skos-cal-baseline-v1');
  assert.equal(w.schema_version, '0.2');
  assert.equal(w.calorie_provider, 'baseline', 'provider clearly persisted — never mislabeled');
  assert.ok(w.calorie_estimated_at, 'estimated_at persisted');
});
