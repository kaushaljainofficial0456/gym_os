// ============================================================
// Planning a member's own workouts: which session is "today's", the weekly
// repeat days, the builder's "today" choice, and supersets carried from a
// saved workout into a session.
//
// The bug these guard against was reported as "after building a workout
// today it always shows that workout only": today's session fell back to
// the most recent pending workout from ANY date, and the weekly schedule a
// member set was never turned into a session at all.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { resetRateLimits } from '../src/rateLimit.js';
import { dayKey, weekDay, plannerDay, shiftDayKey } from '../src/utils/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const TZ = 'Asia/Kolkata';
const today = () => dayKey(new Date(), TZ);

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
    raw: db
  });
  return mk();
}

async function fixture({ mode = 'hybrid' } = {}) {
  const db = await memDb();
  await db.run(`INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES ('o1', 'Gym', 'gym', ?, '2026-01-01T00:00:00Z')`, [TZ]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'a@x.in', 'x', 'CLIENT', 'Asha', 1, '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES ('c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO gym_settings (org_id, workout_mode_default) VALUES ('o1', ?)`, [mode]);
  for (const [eid, name, muscle] of [['ex1', 'Bench Press', 'CHEST'], ['ex2', 'Barbell Row', 'BACK'], ['ex3', 'Squat', 'QUADS']]) {
    await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, 'BARBELL', 1)`, [eid, name, muscle]);
  }
  return db;
}

const token = () => jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Asha' }, config.jwtSecret, { expiresIn: '1h' });

async function startApi(db) {
  resetRateLimits();
  const meRoutes = (await import('../src/routes/me.js')).default;
  const trackingRoutes = (await import('../src/routes/tracking.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/me', meRoutes(db));
  app.use('/tracking', trackingRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const { port } = server.address();
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

async function insertWorkout(db, { id, date, status = 'assigned', source = 'client_custom', name = 'Old Push', startedAt = null }) {
  await db.run(
    `INSERT INTO workouts (id, org_id, client_id, name, day_label, scheduled_date, status, source, started_at, completed_at, created_at)
     VALUES (?, 'o1', 'c1', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, name, date, status, source, startedAt, status === 'completed' ? new Date().toISOString() : null, new Date().toISOString()]);
  await db.run(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight) VALUES (?, ?, 'ex1', 0, 'Bench Press', 3, '10', '40')`, [`${id}_x`, id]);
}

const PLAN = [
  { exercise_id: 'ex1', name: 'Bench Press', sets: 3, reps: '10', weight: '40', superset_group: 'a' },
  { exercise_id: 'ex2', name: 'Barbell Row', sets: 3, reps: '10', weight: '40', superset_group: 'a' },
  { exercise_id: 'ex3', name: 'Squat', sets: 4, reps: '8', weight: '60' }
];

test('a gym day\'s weekday does not depend on a timezone', () => {
  assert.equal(weekDay('2026-11-14'), 6, 'a Saturday');
  assert.equal(weekDay('2026-11-16', 'America/Los_Angeles'), 1, 'a Monday, even for a gym west of UTC');
  assert.equal(weekDay('2026-11-15'), 0, 'a Sunday');
  assert.equal(plannerDay('2026-11-16'), 0, 'the member schedule counts Monday as 0');
  assert.equal(plannerDay('2026-11-15'), 6, 'and Sunday as 6');
});

test('a pending workout from another day is NOT today\'s session', async (t) => {
  const db = await fixture();
  await insertWorkout(db, { id: 'w_old', date: shiftDayKey(today(), -1) });
  await insertWorkout(db, { id: 'w_future', date: shiftDayKey(today(), 3), name: 'Future Legs' });
  const api = await startApi(db);
  t.after(() => api.close());
  const r = await api.call('GET', '/tracking/me/today');
  assert.equal(r.status, 200);
  assert.equal(r.json.workout, null, 'yesterday\'s unfinished build and a future one both stay off today');
});

test('a session finished today stays today\'s session instead of the program day being offered again', async (t) => {
  const db = await fixture();
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('t1', 'o1', 't@x.in', 'x', 'TRAINER', 'Coach', 1, '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO workout_templates (id, org_id, trainer_id, name, created_at) VALUES ('tp1', 'o1', 't1', 'Leg Day', '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO workout_exercises (id, template_id, exercise_id, position, name, sets, reps, weight) VALUES ('tx1', 'tp1', 'ex3', 0, 'Squat', 4, '8', '60')`);
  await db.run(`INSERT INTO training_programs (id, org_id, client_id, name, active, created_at) VALUES ('pr1', 'o1', 'c1', 'Split', 1, '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO training_days (id, program_id, day_of_week, name, template_id, position) VALUES ('td1', 'pr1', ?, 'Leg Day', 'tp1', 0)`, [weekDay(today())]);
  await insertWorkout(db, { id: 'w_done', date: today(), status: 'completed', source: 'program', name: 'Leg Day' });
  const api = await startApi(db);
  t.after(() => api.close());
  const r = await api.call('GET', '/tracking/me/today');
  assert.equal(r.json.workout.id, 'w_done');
  assert.equal(r.json.workout.status, 'completed');
  const rows = await db.q(`SELECT id FROM workouts WHERE client_id = 'c1' AND scheduled_date = ?`, [today()]);
  assert.equal(rows.length, 1, 'the program day was not materialized a second time');
});

test('repeat days: a saved workout on today\'s weekday becomes today\'s session, supersets included', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const created = await api.call('POST', '/me/planner/workouts', { name: 'Push Pull', exercises: PLAN, days: [plannerDay(today()), (plannerDay(today()) + 2) % 7] });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.ok(created.json.today_workout_id, 'today was among the days, so today has it now');

  const r = await api.call('GET', '/tracking/me/today');
  assert.equal(r.json.workout.id, created.json.today_workout_id);
  assert.equal(r.json.workout.name, 'Push Pull');
  assert.deepEqual(r.json.workout.exercises.map((e) => e.superset_group), ['a', 'a', null]);

  const plan = await api.call('GET', '/me/planner');
  assert.deepEqual(plan.json.schedule.map((s) => s.day_of_week).sort(), [plannerDay(today()), (plannerDay(today()) + 2) % 7].sort());
  assert.deepEqual(plan.json.workouts[0].exercises.map((e) => e.superset_group), ['a', 'a', null], 'the saved workout keeps its superset');

  // The week strip shows it on the right weekday (training_days numbering).
  const week = await api.call('GET', '/tracking/me/week');
  const day = week.json.week.find((d) => d.day_of_week === weekDay(today()));
  assert.equal(day.name, 'Push Pull');
  assert.equal(day.source, 'my_workout');
});

test('the weekly schedule is used on a later day with nothing else planned', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const created = await api.call('POST', '/me/planner/workouts', { name: 'Legs', exercises: [PLAN[2]] });
  assert.equal(created.json.today_workout_id, null, 'no days and not for today: nothing scheduled now');
  assert.equal((await api.call('GET', '/tracking/me/today')).json.workout, null);

  const set = await api.call('PUT', `/me/planner/workouts/${created.json.id}/days`, { days: [plannerDay(today())] });
  assert.equal(set.status, 200);
  const r = await api.call('GET', '/tracking/me/today');
  assert.equal(r.json.workout?.name, 'Legs', 'materialized from the schedule when today is asked for');
  const again = await api.call('GET', '/tracking/me/today');
  assert.equal(again.json.workout.id, r.json.workout.id, 'and only once');
});

test('a day holds one workout: picking a taken day moves it', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const a = await api.call('POST', '/me/planner/workouts', { name: 'A', exercises: [PLAN[0]], days: [1, 3] });
  const b = await api.call('POST', '/me/planner/workouts', { name: 'B', exercises: [PLAN[1]] });
  await api.call('PUT', `/me/planner/workouts/${b.json.id}/days`, { days: [3, 5] });
  const plan = await api.call('GET', '/me/planner');
  const by = Object.fromEntries(plan.json.schedule.map((s) => [s.day_of_week, s.workout_id]));
  assert.equal(by[1], a.json.id);
  assert.equal(by[3], b.json.id, 'Thursday moved from A to B');
  assert.equal(by[5], b.json.id);
  // Clearing B's days leaves A's untouched.
  await api.call('PUT', `/me/planner/workouts/${b.json.id}/days`, { days: [] });
  const after = await api.call('GET', '/me/planner');
  assert.deepEqual(after.json.schedule.map((s) => s.day_of_week), [1]);
});

test('"today" never replaces a session already under way', async (t) => {
  const db = await fixture();
  await insertWorkout(db, { id: 'w_live', date: today(), startedAt: new Date().toISOString(), name: 'In Progress' });
  const api = await startApi(db);
  t.after(() => api.close());
  const created = await api.call('POST', '/me/planner/workouts', { name: 'New', exercises: [PLAN[0]], today: true });
  assert.equal(created.status, 200);
  assert.equal(created.json.today_workout_id, null);
  assert.equal(created.json.today_skipped, 'in_progress');
  const r = await api.call('GET', '/tracking/me/today');
  assert.equal(r.json.workout.id, 'w_live');
});

test('"today" replaces an untouched build from earlier the same day', async (t) => {
  const db = await fixture();
  await insertWorkout(db, { id: 'w_earlier', date: today(), name: 'Earlier Build' });
  const api = await startApi(db);
  t.after(() => api.close());
  const created = await api.call('POST', '/me/planner/workouts', { name: 'Better Build', exercises: [PLAN[0]], today: true });
  assert.ok(created.json.today_workout_id);
  const r = await api.call('GET', '/tracking/me/today');
  assert.equal(r.json.workout.name, 'Better Build');
  assert.equal(await db.q1(`SELECT id FROM workouts WHERE id = 'w_earlier'`), null, 'the untouched earlier build is gone');
});

test('Just today: POST /me/workouts keeps superset groups', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const r = await api.call('POST', '/me/workouts', { name: 'Quick', exercises: PLAN.map(({ name, ...e }) => e) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const rows = await db.q('SELECT superset_group FROM workout_exercises WHERE workout_id = ? ORDER BY position', [r.json.id]);
  assert.deepEqual(rows.map((x) => x.superset_group), ['a', 'a', null]);
});

test('repeat days are refused in prescribed mode like the rest of the planner', async (t) => {
  const db = await fixture({ mode: 'prescribed' });
  const api = await startApi(db);
  t.after(() => api.close());
  const r = await api.call('PUT', '/me/planner/workouts/cw_x/days', { days: [1] });
  assert.equal(r.status, 403);
});
