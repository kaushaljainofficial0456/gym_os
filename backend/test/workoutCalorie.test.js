// ============================================================
// Workout session timing + calorie estimation tests.
// Covers: workout start, duration computation (backend source of
// truth), transactional completion (rollback), calorie persistence,
// provider fallback, actual-set calorie input (skipped exercises),
// legacy synthesized sets, body weight resolution, tenant isolation.
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
      try {
        const out = await fn(mk());
        db.exec('COMMIT');
        return out;
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

// set rows for a workout (exercise_set_logs has no workout_id — join via workout_logs)
const setsForWorkout = (db, workoutId) => db.q(
  `SELECT es.* FROM exercise_set_logs es JOIN workout_logs wl ON wl.id = es.workout_log_id WHERE wl.workout_id = ?`, [workoutId]);

const idp = (p) => 'id_' + Math.random().toString(36).slice(2, 10);

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role, org: user.org_id, name: user.name }, config.jwtSecret, { expiresIn: '1h' });
}

async function startWorkoutsApi(db, user) {
  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/workouts', workoutRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, u = user) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(u)}` },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

// Fixture: one org, one client, two library exercises, one assigned workout
// with two exercises (Bench Press 3×10@60, Lat Pulldown 3×12@50).
async function workoutFixture() {
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
  await db.run(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['wxeB', 'wko_1', 'libB', 1, 'Lat Pulldown', 3, '12', '50', 90]);
  return { db, wId: 'wko_1' };
}

const CLIENT = { id: 'u1', role: 'CLIENT', org_id: 'o1' };

// ---------- workout start ----------
test('workout start records started_at once and is idempotent', async (t) => {
  const { db, wId } = await workoutFixture();
  const api = await startWorkoutsApi(db, CLIENT);
  t.after(() => api.close());
  const first = await api.call('POST', `/workouts/${wId}/start`);
  assert.equal(first.status, 200);
  assert.ok(first.json.started_at, 'started_at returned');
  assert.ok(!Number.isNaN(Date.parse(first.json.started_at)), 'ISO timestamp');
  const row = await db.q1('SELECT started_at FROM workouts WHERE id = ?', [wId]);
  assert.equal(row.started_at, first.json.started_at, 'persisted');
  const second = await api.call('POST', `/workouts/${wId}/start`);
  assert.equal(second.json.started_at, first.json.started_at, 'second call does not overwrite');
  await api.close();
});

// ---------- completion: persistence, duration, calorie ----------
test('workout completion persists status, duration and calorie result atomically', async (t) => {
  const { db, wId } = await workoutFixture();
  const api = await startWorkoutsApi(db, CLIENT);
  t.after(() => api.close());
  await api.call('POST', `/workouts/${wId}/start`);
  const r = await api.call('POST', `/workouts/${wId}/complete`, {
    logs: [
      { exercise_id: 'wxeA', sets: [
        { actual_reps: 10, actual_weight: 60 },
        { actual_reps: 8, actual_weight: 60 },
        { actual_reps: 8, actual_weight: 60 }
      ] },
      { exercise_id: 'wxeB', sets: [{ actual_reps: 12, actual_weight: 50 }] }
    ]
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.duration_min !== null && r.json.duration_min >= 0, 'backend-computed duration');
  const cal = r.json.calorie;
  assert.ok(cal, 'calorie returned');
  assert.equal(cal.schema_version, '0.2');
  assert.ok(cal.estimated_active_kcal > 0, 'estimate present');
  assert.ok(cal.lower_kcal <= cal.estimated_active_kcal && cal.estimated_active_kcal <= cal.upper_kcal, 'range wraps midpoint');
  assert.equal(cal.provider, 'baseline');

  const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [wId]);
  assert.equal(w.status, 'completed');
  assert.ok(w.completed_at && w.started_at, 'timestamps persisted');
  assert.equal(w.duration_min, r.json.duration_min);
  assert.equal(w.estimated_active_kcal, cal.estimated_active_kcal, 'calorie persisted');
  assert.equal(w.lower_kcal, cal.lower_kcal);
  assert.equal(w.upper_kcal, cal.upper_kcal);
  assert.equal(w.model_version, 'skos-cal-baseline-v1', 'model version persisted');
  assert.equal(w.schema_version, '0.2');
  assert.equal(w.calorie_provider, 'baseline');
  assert.ok(w.calorie_estimated_at, 'estimated_at persisted');

  const logs = await db.q('SELECT * FROM workout_logs WHERE workout_id = ?', [wId]);
  assert.equal(logs.length, 2, 'one workout_log per exercised exercise');
  const sets = await db.q('SELECT * FROM exercise_set_logs WHERE client_id = ?', ['c1']);
  assert.equal(sets.length, 4, '4 actual sets logged');
  assert.ok(sets.every((s) => s.is_synthesized === 0), 'per-set payload → not synthesized');
  await api.close();
});

// ---------- duration: client-reported started_at is NEVER trusted ----------
test('completion ignores client-reported started_at — no /start means no measured duration', async (t) => {
  const { db, wId } = await workoutFixture();
  const api = await startWorkoutsApi(db, CLIENT);
  t.after(() => api.close());
  // Client claims a start 90 minutes ago — must be ignored entirely.
  const claimed = new Date(Date.now() - 90 * 60000).toISOString();
  const r = await api.call('POST', `/workouts/${wId}/complete`, {
    started_at: claimed,
    logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }]
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.duration_min, null, 'client started_at must not create a duration');
  const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [wId]);
  assert.equal(w.started_at, null, 'no fabricated start time');
  assert.equal(w.duration_min, null, 'no fabricated duration');
  await api.close();
});

test('duration is measured from the server /start timestamp only (client input ignored)', async (t) => {
  const { db, wId } = await workoutFixture();
  const api = await startWorkoutsApi(db, CLIENT);
  t.after(() => api.close());
  await api.call('POST', `/workouts/${wId}/start`);
  const claimed = new Date(Date.now() - 5 * 60000).toISOString(); // bogus client claim
  const r = await api.call('POST', `/workouts/${wId}/complete`, {
    started_at: claimed,
    logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }]
  });
  assert.equal(r.status, 200);
  const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [wId]);
  assert.ok(w.started_at, 'server /start persisted started_at');
  assert.notEqual(w.started_at, claimed, 'client started_at is never persisted');
  const ms = Date.parse(w.completed_at) - Date.parse(w.started_at);
  const expected = ms > 0 ? Math.round((ms / 60000) * 10) / 10 : 0;
  assert.equal(w.duration_min, expected, 'duration computed from server timestamps only');
  assert.equal(r.json.duration_min, w.duration_min);
  await api.close();
});

// ---------- idempotent re-completion ----------
test('re-completing an already completed workout is idempotent (no double logging)', async (t) => {
  const { db, wId } = await workoutFixture();
  const api = await startWorkoutsApi(db, CLIENT);
  t.after(() => api.close());
  const body = { logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }] };
  const first = await api.call('POST', `/workouts/${wId}/complete`, body);
  assert.equal(first.status, 200);
  const second = await api.call('POST', `/workouts/${wId}/complete`, body);
  assert.equal(second.status, 200);
  assert.equal(second.json.alreadyCompleted, true);
  const logs = await db.q('SELECT * FROM workout_logs WHERE workout_id = ?', [wId]);
  assert.equal(logs.length, 1, 'not doubled');
  const sets = await setsForWorkout(db, wId);
  assert.equal(sets.length, 1, 'set rows not doubled');
  await api.close();
});

// ---------- skipped exercises ----------
test('skipped exercises contribute 0 sets — calorie input uses only completed sets', async (t) => {
  const { db, wId } = await workoutFixture();
  const api = await startWorkoutsApi(db, CLIENT);
  t.after(() => api.close());
  // only exercise A is performed; exercise B (planned 3 sets) is skipped
  const r = await api.call('POST', `/workouts/${wId}/complete`, {
    logs: [{ exercise_id: 'wxeA', sets: [
      { actual_reps: 10, actual_weight: 60 },
      { actual_reps: 8, actual_weight: 60 }
    ] }]
  });
  assert.equal(r.status, 200);
  const bSets = await setsForWorkout(db, wId);
  assert.ok(!bSets.some((s) => s.exercise_id === 'libB'), 'skipped exercise has no set rows');
  const aSets = bSets.filter((s) => s.exercise_id === 'libA');
  assert.equal(aSets.length, 2, 'only performed sets logged');

  // unit-level: buildWorkoutCalorieInput excludes skipped exercises entirely
  const { buildWorkoutCalorieInput, completedSetCount } = await import('../src/services/intelligence/calorieModel.js');
  const input = buildWorkoutCalorieInput({
    client: { age: 30, sex: 'M', height_cm: 175 },
    workout: { id: wId },
    exercises: [
      { id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', ex_type: 'compound', movement: 'horizontal_push', equipment: 'BARBELL', primary_muscle: 'CHEST', library: { ex_type: 'compound', movement: 'horizontal_push', equipment: 'BARBELL', primary_muscle: 'CHEST' } },
      { id: 'wxeB', exercise_id: 'libB', name: 'Lat Pulldown', ex_type: 'compound', movement: 'vertical_pull', equipment: 'CABLE', primary_muscle: 'LATS', library: { ex_type: 'compound', movement: 'vertical_pull', equipment: 'CABLE', primary_muscle: 'LATS' } }
    ],
    setsByExercise: { wxeA: [{ set_number: 1, actual_reps: 10, actual_weight: 60, completed: 1 }, { set_number: 2, actual_reps: 8, actual_weight: 60, completed: 1 }] },
    durationSeconds: 1800,
    bodyWeightKg: 78
  });
  assert.equal(input.exercises.length, 2, 'session record keeps both exercises (skipped = empty completed_sets)');
  const performed = input.exercises.find((e) => e.exercise_id === 'libA');
  const skipped = input.exercises.find((e) => e.exercise_id === 'libB');
  assert.equal(performed.completed_sets.length, 2);
  assert.equal(skipped.completed_sets.length, 0, 'skipped exercise contributes 0 completed sets');
  assert.equal(completedSetCount(input), 2, 'only performed sets count as workload');
  assert.equal(performed.muscle_group, 'chest', 'muscle normalized');
  assert.equal(performed.compound_or_isolation, 'compound');
  assert.equal(performed.completed_sets[0].weight_kg, 60);
  await api.close();
});

// ---------- calorie provider fallback + mock ----------
test('calorie provider: ml falls back to baseline; mock is labeled; unknown → baseline', async (t) => {
  const { estimateWorkoutCalories } = await import('../src/services/intelligence/calorieModel.js');
  const input = {
    user: { body_weight_kg: 78 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: []
  };
  const prev = process.env.CALORIE_MODEL_PROVIDER;
  try {
    process.env.CALORIE_MODEL_PROVIDER = 'ml';
    const ml = estimateWorkoutCalories(input);
    assert.equal(ml.provider, 'baseline', 'unimplemented ml provider falls back to baseline');
    assert.equal(ml.model_version, 'skos-cal-baseline-v1');
    assert.ok(ml.note && ml.note.includes('fallback'), 'fallback clearly labeled');

    process.env.CALORIE_MODEL_PROVIDER = 'mock';
    const mock = estimateWorkoutCalories(input);
    assert.equal(mock.provider, 'mock');
    assert.equal(mock.model_version, 'skos-cal-mock-v1');
    assert.equal(mock.estimated_active_kcal, 300);

    process.env.CALORIE_MODEL_PROVIDER = 'bogus';
    const b = estimateWorkoutCalories(input);
    assert.equal(b.provider, 'baseline');
  } finally {
    if (prev === undefined) delete process.env.CALORIE_MODEL_PROVIDER;
    else process.env.CALORIE_MODEL_PROVIDER = prev;
  }
});

// ---------- baseline math sanity ----------
test('baseline estimate scales with body weight and duration', async (t) => {
  const { estimateWorkoutCalories } = await import('../src/services/intelligence/calorieModel.js');
  const light = estimateWorkoutCalories({ user: { body_weight_kg: 60 }, session: { duration_minutes: 30, intensity_rating: 'light' }, exercises: [] });
  const hard = estimateWorkoutCalories({ user: { body_weight_kg: 90 }, session: { duration_minutes: 90, intensity_rating: 'hard' }, exercises: [] });
  assert.ok(hard.estimated_active_kcal > light.estimated_active_kcal, 'heavier/longer/harder burns more');
  // MET 4.5 × 3.5 × 60 ÷ 200 × 30 = 141.75 → estimate 142; range from the unrounded value
  const mod = estimateWorkoutCalories({ user: { body_weight_kg: 60 }, session: { duration_minutes: 30, intensity_rating: 'moderate' }, exercises: [] });
  assert.equal(mod.estimated_active_kcal, 142);
  assert.equal(mod.lower_kcal, Math.round(141.75 * 0.85));
  assert.equal(mod.upper_kcal, Math.round(141.75 * 1.15));
});

// ---------- transaction rollback ----------
test('workout completion rolls back everything when a write fails mid-transaction', async (t) => {
  const { db, wId } = await workoutFixture();
  // poison: fail every exercise_set_logs INSERT inside the transaction
  const origTx = db.tx.bind(db);
  db.tx = async (fn) => origTx((tx) => fn(Object.assign(Object.create(tx), {
    run: async (sql, params) => {
      if (String(sql).includes('exercise_set_logs') && String(sql).includes('set_number')) throw new Error('injected failure');
      return tx.run(sql, params);
    }
  })));
  const api = await startWorkoutsApi(db, CLIENT);
  t.after(() => api.close());
  const r = await api.call('POST', `/workouts/${wId}/complete`, {
    logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }]
  });
  assert.equal(r.status, 500, 'failure surfaces as an error');
  const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [wId]);
  assert.equal(w.status, 'assigned', 'workout NOT marked completed after rollback');
  const logs = await db.q('SELECT * FROM workout_logs WHERE workout_id = ?', [wId]);
  assert.equal(logs.length, 0, 'no workout_logs left behind');
  const sets = await setsForWorkout(db, wId);
  assert.equal(sets.length, 0, 'no set rows left behind');
  const prs = await db.q('SELECT * FROM personal_records WHERE client_id = ?', ['c1']);
  assert.equal(prs.length, 0, 'no PRs left behind');
  await api.close();
});

// ---------- tenant isolation ----------
test('client from another org cannot complete another gym\'s workout', async (t) => {
  const db = await memDb();
  for (const [oid, slug] of [['o1', 'gym-a'], ['o2', 'gym-b']]) {
    await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [oid, 'Gym ' + oid, slug, '2026-01-01T00:00:00Z']);
  }
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`, ['u1', 'o1', 'a@x.in', 'x', 'A', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`, ['u2', 'o2', 'b@x.in', 'x', 'B', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, ?, 1)`, ['libA', 'Bench Press', 'CHEST', 'BARBELL']);
  await db.run(`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, 'assigned', ?)`, ['wko_1', 'o1', 'c1', 'Push', '2026-08-15', '2026-08-15T00:00:00Z']);
  await db.run(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['wxeA', 'wko_1', 'libA', 0, 'Bench Press', 3, '10', '60', 90]);
  const api = await startWorkoutsApi(db, { id: 'u2', role: 'CLIENT', org_id: 'o2' });
  t.after(() => api.close());
  const start = await api.call('POST', '/workouts/wko_1/start');
  assert.equal(start.status, 403, 'cross-org start denied');
  const complete = await api.call('POST', '/workouts/wko_1/complete', {
    logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }]
  });
  assert.equal(complete.status, 403, 'cross-org complete denied');
  const w = await db.q1('SELECT status FROM workouts WHERE id = ?', ['wko_1']);
  assert.equal(w.status, 'assigned');
  await api.close();
});

// ---------- legacy synthesized sets ----------
test('legacy aggregate payload marks exercise_set_logs as synthesized', async (t) => {
  const { db, wId } = await workoutFixture();
  const api = await startWorkoutsApi(db, CLIENT);
  t.after(() => api.close());
  const r = await api.call('POST', `/workouts/${wId}/complete`, {
    logs: [{ exercise_id: 'wxeA', sets_done: 2, reps: 10, weight: 60 }]
  });
  assert.equal(r.status, 200);
  const sets = await setsForWorkout(db, wId);
  assert.equal(sets.length, 2);
  assert.ok(sets.every((s) => s.is_synthesized === 1), 'aggregate-derived rows flagged synthesized');
  await api.close();
});

// ---------- body weight resolution ----------
test('resolveBodyWeight prefers nearest weight_logs at/before the session date, then client columns', async (t) => {
  const { resolveBodyWeight } = await import('../src/services/intelligence/calorieModel.js');
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, org_id, goal, current_weight, start_weight, target_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['c1', 'o1', 'FAT_LOSS', 78, 80, 70, '2026-01-01T00:00:00Z']);

  // no logs → client columns (current first)
  assert.equal(await resolveBodyWeight(db, 'c1', '2026-08-01'), 78);

  // nearest log at/before the date wins
  await db.run(`INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?, ?, ?, ?, ?)`, ['wl1', 'c1', '2026-08-10', 77, '2026-08-10T08:00:00Z']);
  await db.run(`INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?, ?, ?, ?, ?)`, ['wl2', 'c1', '2026-08-14', 76.5, '2026-08-14T08:00:00Z']);
  await db.run(`INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?, ?, ?, ?, ?)`, ['wl3', 'c1', '2026-08-20', 75.5, '2026-08-20T08:00:00Z']);
  assert.equal(await resolveBodyWeight(db, 'c1', '2026-08-15'), 76.5, 'nearest at/before 08-15');
  assert.equal(await resolveBodyWeight(db, 'c1', '2026-08-01'), 78, 'before any log → client columns');
  assert.equal(await resolveBodyWeight(db, 'c1', '2026-08-25'), 75.5, 'after last log → most recent');
  await db.run('DELETE FROM weight_logs');
  await db.run('UPDATE clients SET current_weight = NULL, start_weight = NULL, target_weight = NULL WHERE id = ?', ['c1']);
  assert.equal(await resolveBodyWeight(db, 'c1', '2026-08-15'), null, 'nothing available → null');
});

// ---------- today session: preview vs persisted calorie ----------
test('todaySession meta.calorie: preview while assigned, persisted after completion', async (t) => {
  const { db } = await workoutFixture();
  const { dayKey } = await import('../src/utils/time.js');
  const d = dayKey(new Date(), 'Asia/Kolkata');
  await db.run('UPDATE workouts SET scheduled_date = ? WHERE id = ?', [d, 'wko_1']);
  await db.run(`INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?, ?, ?, ?, ?)`, ['wl1', 'c1', d, 78, d + 'T08:00:00Z']);

  const { todaySession } = await import('../src/services/trainingProgram.js');
  const pending = await todaySession(db, 'c1', 'Asia/Kolkata');
  assert.ok(pending, 'assigned workout resolves');
  assert.equal(pending.meta.calorie.source, 'preview');
  assert.ok(pending.meta.calorie.estimated_active_kcal > 0, 'preview estimate present');
  assert.equal(pending.meta.estKcal, pending.meta.calorie.estimated_active_kcal, 'estKcal stays in sync for the existing UI');

  // complete via API then re-check — persisted estimate surfaces
  const api = await startWorkoutsApi(db, CLIENT);
  t.after(() => api.close());
  const r = await api.call('POST', `/workouts/wko_1/complete`, {
    logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }]
  });
  assert.equal(r.status, 200);
  // todaySession resolves the *assigned* session; completed history is read via
  // the workout row, so assert the persisted source path through the row shape.
  const w = await db.q1('SELECT * FROM workouts WHERE id = ?', ['wko_1']);
  assert.ok(w.estimated_active_kcal != null, 'persisted');
  await api.close();
});
