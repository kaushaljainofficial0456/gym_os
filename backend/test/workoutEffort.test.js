// ============================================================
// Session effort + the evidence-based baseline burn estimate.
//
// Covers: the baseline's Compendium 2024 session METs, net-of-resting
// output with the person's own (Mifflin-St Jeor) resting rate, the
// standard-rate fallback, agreement with the measured whole-session
// envelope; POST /workouts/:id/effort recomputing and persisting the
// estimate from the session's real sets; effort surviving into every
// later re-estimate; and the set lookup by library exercise id.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import {
  baselineEstimate, buildWorkoutCalorieInput, restingKcalPerMinute, sessionEffort, INTENSITY_MET,
} from '../src/services/intelligence/calorieModel.js';

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
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  });
  return mk();
}

const tokenFor = (u) => jwt.sign({ sub: u.id, role: u.role, org: u.org_id, name: u.name }, config.jwtSecret, { expiresIn: '1h' });

async function api(db) {
  const routes = (await import('../src/routes/workouts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/workouts', routes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, u = CLIENT) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(u)}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { call, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const CLIENT = { id: 'u1', role: 'CLIENT', org_id: 'o1' };
const OTHER = { id: 'u2', role: 'CLIENT', org_id: 'o1' };

// One client (30y male, 175 cm, 78 kg), one assigned two-exercise workout.
async function fixture() {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  for (const [uid, email, name] of [['u1', 'c@a.in', 'Client One'], ['u2', 'd@a.in', 'Client Two']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
      [uid, 'o1', email, 'x', name, '2026-01-01T00:00:00Z']);
  }
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'FAT_LOSS', 30, 'M', 175, 80, 78, '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c2', 'u2', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
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
  return db;
}

const LOGS = [
  { exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }, { actual_reps: 10, actual_weight: 60 }, { actual_reps: 8, actual_weight: 60 }] },
  { exercise_id: 'wxeB', sets: [{ actual_reps: 12, actual_weight: 50 }, { actual_reps: 12, actual_weight: 50 }] },
];

const MALE_75 = { body_weight_kg: 75, height_cm: 178, age_years: 30, sex: 'male' };
const est = (user, intensity, minutes) => baselineEstimate({ user, session: { duration_minutes: minutes, intensity_rating: intensity } });

// ---------------- the baseline itself ----------------

test('session METs are the 2024 Compendium values', () => {
  assert.deepEqual(INTENSITY_MET, { light: 3.0, moderate: 3.5, hard: 6.0 });
});

test('an ordinary session lands inside the measured whole-session envelope, then resting is removed', () => {
  // Four labs measured real gym sessions at 0.0593-0.0665 kcal/min/kg GROSS.
  const grossPerMin = (3.5 * 3.5 * 75) / 200;
  assert.ok(grossPerMin / 75 >= 0.0593 && grossPerMin / 75 <= 0.0665, 'moderate gross rate inside the four-lab envelope');
  const out = est(MALE_75, 'moderate', 60);
  // Mifflin: 10*75 + 6.25*178 - 5*30 + 5 = 1717.5 kcal/day -> 71.6 kcal/h at rest.
  assert.equal(out.estimated_active_kcal, Math.round((grossPerMin - 1717.5 / 1440) * 60));
  assert.equal(out.estimated_active_kcal, 204);
  assert.ok(out.estimated_active_kcal < grossPerMin * 60, 'active is net of resting, never the gross figure');
  assert.equal(out.model_version, 'skos-cal-baseline-v2');
});

test('the person\'s own resting rate is used when the profile allows it, the standard 1 MET otherwise', () => {
  assert.equal(restingKcalPerMinute(MALE_75).source, 'mifflin_st_jeor');
  const fallback = restingKcalPerMinute({ body_weight_kg: 75 });
  assert.equal(fallback.source, 'standard_met');
  assert.equal(fallback.perMin, (3.5 * 75) / 200);
  assert.equal(restingKcalPerMinute({}), null);
  // A woman of the same session differs from a man through resting rate and mass, not a fudge factor.
  const female = est({ body_weight_kg: 60, height_cm: 165, age_years: 30, sex: 'female' }, 'moderate', 60);
  assert.ok(female.estimated_active_kcal > 0 && female.estimated_active_kcal < est(MALE_75, 'moderate', 60).estimated_active_kcal);
});

test('harder sessions burn more, and the band always wraps the estimate', () => {
  const light = est(MALE_75, 'light', 45).estimated_active_kcal;
  const moderate = est(MALE_75, 'moderate', 45).estimated_active_kcal;
  const hard = est(MALE_75, 'hard', 45);
  assert.ok(light < moderate && moderate < hard.estimated_active_kcal);
  assert.ok(hard.lower_kcal < hard.estimated_active_kcal && hard.estimated_active_kcal < hard.upper_kcal);
});

// ---------------- effort is part of the session ----------------

test('sessionEffort reads only a real rating from the progress blob', () => {
  assert.equal(sessionEffort({ progress_json: JSON.stringify({ wxeA: [], __paused_ms: 0, __effort: 'hard' }) }), 'hard');
  assert.equal(sessionEffort({ progress_json: JSON.stringify({ __effort: 'extreme' }) }), null);
  assert.equal(sessionEffort({ progress_json: '{not json' }), null);
  assert.equal(sessionEffort({}), null);
});

test('the calorie input uses the explicit effort, then the stored one, then RIR inference', () => {
  const base = { client: {}, exercises: [], setsByExercise: {} };
  assert.equal(buildWorkoutCalorieInput({ ...base, workout: {}, intensity: 'light' }).session.intensity_rating, 'light');
  assert.equal(buildWorkoutCalorieInput({ ...base, workout: { progress_json: '{"__effort":"hard"}' } }).session.intensity_rating, 'hard');
  assert.equal(buildWorkoutCalorieInput({ ...base, workout: {} }).session.intensity_rating, 'moderate');
});

test('completed sets keyed by library exercise id are still found', () => {
  const input = buildWorkoutCalorieInput({
    client: {}, workout: {},
    exercises: [{ id: 'wxeA', exercise_id: 'libA', name: 'Bench Press' }],
    setsByExercise: { libA: [{ actual_reps: 10, actual_weight: 60, completed: 1 }] },
  });
  assert.equal(input.session.total_sets, 1);
  assert.equal(input.session.total_volume_kg, 600);
});

// ---------------- POST /workouts/:id/effort ----------------

test('rating the effort recomputes the stored estimate from the real session and keeps the rating', async (t) => {
  const db = await fixture();
  const a = await api(db);
  t.after(() => a.close());

  const done = await a.call('POST', '/workouts/wko_1/complete', { logs: LOGS, duration_seconds: 3000 });
  assert.equal(done.status, 200);
  const moderate = (await db.q1('SELECT estimated_active_kcal FROM workouts WHERE id = ?', ['wko_1'])).estimated_active_kcal;

  const hard = await a.call('POST', '/workouts/wko_1/effort', { effort: 'hard' });
  assert.equal(hard.status, 200);
  assert.equal(hard.json.effort, 'hard');
  const row = await db.q1('SELECT estimated_active_kcal, lower_kcal, upper_kcal, model_version, progress_json FROM workouts WHERE id = ?', ['wko_1']);
  assert.equal(row.estimated_active_kcal, hard.json.calorie.estimated_active_kcal, 'what the member is shown is what is stored');
  assert.ok(row.estimated_active_kcal > moderate, 'a hard session is worth more than the default moderate');
  assert.equal(JSON.parse(row.progress_json).__effort, 'hard');
  // Same pipeline, same inputs: 78 kg, 30y male, 175 cm, 50 measured minutes.
  const expected = est({ body_weight_kg: 78, height_cm: 175, age_years: 30, sex: 'm' }, 'hard', 50);
  assert.equal(row.estimated_active_kcal, expected.estimated_active_kcal);

  const light = await a.call('POST', '/workouts/wko_1/effort', { effort: 'light' });
  assert.ok(light.json.calorie.estimated_active_kcal < moderate, 'changing the answer changes the figure again');
});

test('effort is refused before the session is finished, for bad values, and for someone else\'s session', async (t) => {
  const db = await fixture();
  const a = await api(db);
  t.after(() => a.close());
  assert.equal((await a.call('POST', '/workouts/wko_1/effort', { effort: 'hard' })).status, 409);
  await a.call('POST', '/workouts/wko_1/complete', { logs: LOGS, duration_seconds: 3000 });
  assert.equal((await a.call('POST', '/workouts/wko_1/effort', { effort: 'maximal' })).status, 422, 'the validator rejects an unknown rating');
  const other = await a.call('POST', '/workouts/wko_1/effort', { effort: 'hard' }, OTHER);
  assert.ok(other.status === 403 || other.status === 404, `another client cannot rate it (got ${other.status})`);
  assert.equal((await a.call('POST', '/workouts/missing/effort', { effort: 'hard' })).status, 404);
});
