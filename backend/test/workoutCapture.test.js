// ============================================================
// Workout data capture through the real completion route
// (docs/CALORIE_DATA_CAPTURE.md): measured set timing, actual vs planned
// rest, optional per-set RIR, timer anomalies, profile gaps and the
// hidden-mode engine log -- and proof that none of it changes the calorie
// estimate the member sees.
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

const T0 = Date.parse('2026-08-15T18:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const plainLogs = () => ([
  { exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }, { actual_reps: 8, actual_weight: 60 }] },
  { exercise_id: 'wxeB', sets: [{ actual_reps: 12, actual_weight: 50 }] },
]);
// Same work, with tick/start times every 2 minutes and RIR 0 on every set
// (which, if it reached the estimator, would make the session "hard").
const timedLogs = () => ([
  { exercise_id: 'wxeA', sets: [
    { actual_reps: 10, actual_weight: 60, started_at: at(60), completed_at: at(100), reported_rir: 0 },
    { actual_reps: 8, actual_weight: 60, started_at: at(190), completed_at: at(225), reported_rir: 0 },
  ] },
  { exercise_id: 'wxeB', sets: [{ actual_reps: 12, actual_weight: 50, started_at: at(330), completed_at: at(370), reported_rir: 0 }] },
]);
const timedBody = (extra = {}) => ({
  logs: timedLogs(), duration_seconds: 1500, client_started_at: at(0), client_finished_at: at(1500),
  pauses: [{ started_at: at(110), ended_at: at(140) }], ...extra,
});

async function complete(body) {
  const { db, wId } = await workoutFixture();
  const api = await startWorkoutsApi(db, CLIENT);
  try {
    const r = await api.call('POST', `/workouts/${wId}/complete`, body);
    return { db, wId, r };
  } finally { await api.close(); }
}

test('measured timing is stored per set; actual rest excludes pauses; planned rest is kept apart', async () => {
  const { db, wId, r } = await complete(timedBody());
  assert.equal(r.status, 200);
  const sets = (await setsForWorkout(db, wId)).sort((a, b) => a.set_completed_at.localeCompare(b.set_completed_at));
  assert.equal(sets.length, 3);
  assert.equal(sets[0].set_started_at, at(60));
  assert.equal(sets[0].set_completed_at, at(100));
  assert.equal(sets[0].actual_rest_seconds, null, 'first set: no rest before it');
  assert.equal(sets[1].actual_rest_seconds, 60, '190 - 100 = 90 s, minus the 30 s pause');
  assert.equal(sets[1].tick_interval_seconds, 95);
  assert.match(sets[1].timing_flags, /interval_excludes_pause/);
  assert.equal(sets[2].actual_rest_seconds, 105);
  for (const s of sets) {
    assert.equal(s.rest_seconds, null, 'legacy column no longer written');
    assert.equal(s.prescribed_rest_seconds, 90, 'the plan\'s rest, labelled as planned');
    assert.equal(s.reported_rir, 0);
  }
  const w = await db.q1('SELECT session_timing_json FROM workouts WHERE id = ?', [wId]);
  const timing = JSON.parse(w.session_timing_json);
  assert.equal(timing.sets_with_actual_rest, 2);
  assert.equal(timing.paused_seconds, 30);
  assert.equal(timing.clock, 'client_window');
});

test('the displayed estimate is identical with or without timing and per-set RIR', async () => {
  const plain = await complete({ logs: plainLogs(), duration_seconds: 1500 });
  const timed = await complete(timedBody());
  for (const k of ['estimated_active_kcal', 'lower_kcal', 'upper_kcal', 'model_version', 'provider']) {
    assert.equal(timed.r.json.calorie[k], plain.r.json.calorie[k], `${k} unchanged`);
  }
  const row = await timed.db.q1('SELECT estimated_active_kcal FROM workouts WHERE id = ?', [timed.wId]);
  assert.equal(row.estimated_active_kcal, plain.r.json.calorie.estimated_active_kcal);
  assert.ok(!timed.r.json.calorie.reliability_reasons.some((x) => x.code === 'hard_may_overestimate'),
    'RIR 0 on every set did not turn the session "hard"');
});

test('missing timestamps (older app version): completes normally, flagged, nothing invented', async () => {
  const { db, wId, r } = await complete({ logs: plainLogs(), duration_seconds: 1500 });
  assert.equal(r.status, 200);
  for (const s of await setsForWorkout(db, wId)) {
    assert.equal(s.set_completed_at, null);
    assert.equal(s.actual_rest_seconds, null);
    assert.equal(s.prescribed_rest_seconds, 90);
  }
  const timing = JSON.parse((await db.q1('SELECT session_timing_json FROM workouts WHERE id = ?', [wId])).session_timing_json);
  assert.ok(timing.flags.includes('no_set_timestamps'));
  assert.ok(timing.flags.includes('client_window_missing'));
});

test('incomplete data: legacy aggregate payload and unticked sets carry no timing', async () => {
  const { db, wId, r } = await complete({
    logs: [{ exercise_id: 'wxeA', sets_done: 3, reps: 10, weight: 60 },
      { exercise_id: 'wxeB', sets: [{ actual_reps: 12, actual_weight: 50, completed: false, completed_at: at(100) }] }],
    duration_seconds: 900,
  });
  assert.equal(r.status, 200);
  for (const s of await setsForWorkout(db, wId)) {
    assert.equal(s.set_completed_at, null, 'synthesized and unticked sets are never timed');
  }
});

test('timer anomaly (left running 40 min after the last set): flagged, duration and estimate untouched', async () => {
  const body = timedBody({ duration_seconds: 370 + 40 * 60, client_finished_at: at(370 + 40 * 60), pauses: [] });
  const { db, wId, r } = await complete(body);
  assert.equal(r.status, 200);
  assert.equal(r.json.duration_min, Math.round(((370 + 40 * 60) / 60) * 10) / 10, 'duration is what the timer said');
  const w = await db.q1('SELECT session_timing_json, duration_min FROM workouts WHERE id = ?', [wId]);
  assert.ok(JSON.parse(w.session_timing_json).flags.includes('idle_tail'));
  const reference = await complete({ logs: plainLogs(), duration_seconds: 370 + 40 * 60 });
  assert.equal(r.json.calorie.estimated_active_kcal, reference.r.json.calorie.estimated_active_kcal);
});

test('timestamps outside the session are rejected per set, never fail completion', async () => {
  const logs = timedLogs();
  logs[0].sets[0].completed_at = '2020-01-01T00:00:00.000Z';
  const { db, wId, r } = await complete(timedBody({ logs }));
  assert.equal(r.status, 200);
  const bad = (await setsForWorkout(db, wId)).find((s) => /completed_outside_session/.test(s.timing_flags || ''));
  assert.ok(bad, 'flagged');
  assert.equal(bad.set_completed_at, null);
});

test('malformed capture fields are rejected by validation, not stored', async () => {
  const logs = timedLogs();
  logs[0].sets[0].reported_rir = 42;
  const { r } = await complete(timedBody({ logs }));
  assert.equal(r.status, 422);
});

test('hidden-mode engine: inputs logged, no estimate, never in the response', async () => {
  const { db, wId, r } = await complete(timedBody());
  const logged = JSON.parse((await db.q1('SELECT calorie_features_json FROM workouts WHERE id = ?', [wId])).calorie_features_json);
  assert.equal(logged.engine.status, 'not_fitted');
  assert.equal(logged.engine.estimate_kcal, null);
  assert.ok(logged.engine.components.every((c) => c.fitted === false));
  assert.equal(logged.features.completeness.sets_with_actual_rest, 2);
  assert.equal(logged.features.time.actual_rest_seconds.mean, 82.5);
  assert.equal(logged.features.load.external_volume_kg, 10 * 60 + 8 * 60 + 12 * 50);
  assert.equal(logged.features.composition.by_movement.horizontal_push, 0.667);
  assert.equal(r.json.calorie_features, undefined);
  assert.ok(!JSON.stringify(r.json).includes('not_fitted'));
});

test('profile gaps are reported so the existing inputs can be made accurate', async () => {
  const { r } = await complete({ logs: plainLogs(), duration_seconds: 900 });
  // fixture: height, age and sex ('M', which Mifflin-St Jeor accepts) present; profile weight but no weight log
  assert.deepEqual(r.json.profile_gaps, ['weight_not_logged']);
});

test('profile gap rules', async () => {
  const { calorieProfileGaps } = await import('../src/services/intelligence/calorieEngineShadow.js');
  assert.deepEqual(calorieProfileGaps({ client: {} }), ['height', 'age', 'sex', 'weight_missing']);
  assert.deepEqual(calorieProfileGaps({ client: { height_cm: 170, age: 40, sex: 'female' }, latestWeightLogDate: '2026-08-01', workoutDate: '2026-08-15' }), []);
  assert.deepEqual(calorieProfileGaps({ client: { height_cm: 170, age: 40, sex: 'F' }, latestWeightLogDate: '2026-06-01', workoutDate: '2026-08-15' }), ['weight_stale']);
  assert.deepEqual(calorieProfileGaps({ client: { height_cm: 170, age: 40, sex: 'other' }, latestWeightLogDate: '2026-08-14', workoutDate: '2026-08-15' }), ['sex']);
});
