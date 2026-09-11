// ============================================================
// The whole-day energy picture: resting (BMR) + active, and the
// itemized breakdown behind it.
//
// The interesting risk in this feature is DOUBLE COUNTING -- a daily
// total is easy to inflate by adding a wearable's whole-day figure to
// our own workout sum, by adding step energy on top of a figure that
// already contains it, or by using a TDEE (which has an activity
// multiplier baked in) as the resting base. Each of those has its own
// test below.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mifflinStJeorBmr, restingEnergyForSeconds, stepsToActiveKcal, stepsDuringWorkouts, composeDailyEnergy,
} from '../src/services/intelligence/restingEnergy.js';
import { reconcileUserDay, getBurnBreakdown } from '../src/services/health/dailyIntelligence.js';
import { upsertHealthRecord } from '../src/services/health/dedup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    async q(sql, params = []) { const st = db.prepare(sql); return params.length ? st.all(...params) : st.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const st = db.prepare(sql); const r = params.length ? st.run(...params) : st.run(); return { changes: Number(r.changes) }; },
  });
  return mk();
}

async function seedWorkoutDay(db, { date, startedAt, completedAt }) {
  const ts = '2026-01-01T00:00:00Z';
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', ts]);
  await db.run('INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,?,?,1,?)',
    ['u1', 'o1', 'c@test.com', 'x', 'CLIENT', 'Client', ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, current_weight, age, sex, height_cm, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ['c1', 'u1', 'o1', 'GENERAL', 78, 30, 'MALE', 178, ts]);
  await db.run('INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?,NULL,?,?,?,?,?,1)',
    ['ex_bench', 'Bench Press', 'chest', 'barbell', 'horizontal_push', 'compound']);
  await db.run('INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, started_at, completed_at, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['w1', 'o1', 'c1', 'Push Day', date, 'completed', startedAt, completedAt, 'program', ts]);
  await db.run('INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)',
    ['we1', 'w1', 'ex_bench', 0, 'Bench Press', 4, '8', '60', 90]);
  await db.run('INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, created_at) VALUES (?,?,?,?,?,?,?)',
    ['wl1', 'c1', 'w1', 'ex_bench', date, 4, startedAt]);
  for (let i = 1; i <= 4; i++) {
    await db.run('INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, actual_reps, actual_weight, completed) VALUES (?,?,?,?,?,?,?,1)',
      [`sl${i}`, 'wl1', 'c1', 'ex_bench', i, 8, 60]);
  }
  return { userId: 'u1', orgId: 'o1', clientId: 'c1' };
}

// ---------- the pure composition rules ----------

test('BMR uses Mifflin-St Jeor and returns null (never a guess) on an incomplete profile', () => {
  // 78kg, 178cm, 30y male -> 10*78 + 6.25*178 - 5*30 + 5 = 1747.5
  assert.equal(mifflinStJeorBmr({ weightKg: 78, heightCm: 178, age: 30, sex: 'MALE' }), 1747.5);
  assert.equal(mifflinStJeorBmr({ weightKg: 78, heightCm: 178, age: 30, sex: 'FEMALE' }), 1581.5);
  assert.equal(mifflinStJeorBmr({ weightKg: 78, heightCm: 178, age: null, sex: 'MALE' }), null);
  assert.equal(mifflinStJeorBmr({ weightKg: 0, heightCm: 178, age: 30, sex: 'MALE' }), null);
});

test('resting energy is prorated for a day in progress, never a full 24h at 9am', () => {
  const bmr = 2400; // a tidy 100 kcal/h
  assert.equal(Math.round(restingEnergyForSeconds(bmr, 9 * 3600)), 900);
  assert.equal(Math.round(restingEnergyForSeconds(bmr, 86400)), 2400);
  assert.equal(Math.round(restingEnergyForSeconds(bmr, 999999)), 2400, 'capped at one day');
  assert.equal(restingEnergyForSeconds(null, 3600), null);
});

test('step energy is NET of resting, so adding it to BMR cannot double-count', () => {
  // ~0.025 kcal/step at 78kg -> 10k steps is ~250 kcal ABOVE resting, not
  // the ~400-500 kcal figure consumer apps quote (which includes resting).
  const kcal = stepsToActiveKcal(10000, 78);
  assert.ok(kcal > 200 && kcal < 300, `10k steps at 78kg should be ~250 net kcal, got ${kcal}`);
  assert.equal(stepsToActiveKcal(0, 78), null, 'no steps is unknown, not a fabricated zero');
  assert.equal(stepsToActiveKcal(5000, null), null, 'no body weight -> no number');
});

test('steps taken DURING a run are excluded from everyday-movement energy', () => {
  const run = [{ activityType: 'running', durationSeconds: 1800 }];
  assert.ok(stepsDuringWorkouts(run) > 0, 'a 30-minute run contains steps');
  // A lifting session contributes negligible steps -- never guessed at.
  assert.equal(stepsDuringWorkouts([{ activityType: 'strength_training', durationSeconds: 3600 }]), 0);
});

test('a wearable whole-day active figure is authoritative: steps and workouts are NOT added on top', () => {
  const composed = composeDailyEnergy({
    bmrPerDay: 1747.5, elapsedSeconds: 86400,
    workoutKcal: 400, steps: 12000, weightKg: 78, workouts: [],
    wearableDailyActive: 700,
  });
  assert.equal(composed.activeKcal, 700, 'the wearable measured the whole day -- trust it wholesale');
  assert.equal(composed.movementKcal, null, 'step energy must not be added to a figure that already contains it');
  assert.equal(composed.activeSource, 'wearable_daily_total');
  assert.equal(Math.round(composed.totalKcal), Math.round(1747.5 + 700));
});

test('with no wearable daily figure, active = workouts + everyday movement, and total = resting + active', () => {
  const composed = composeDailyEnergy({
    bmrPerDay: 2400, elapsedSeconds: 86400,
    workoutKcal: 400, steps: 10000, weightKg: 78, workouts: [{ activityType: 'strength_training', durationSeconds: 3600 }],
  });
  assert.equal(composed.workoutKcal, 400);
  assert.ok(composed.movementKcal > 200, 'everyday steps still count when nothing else measured the day');
  assert.equal(Math.round(composed.activeKcal), Math.round(400 + composed.movementKcal));
  assert.equal(Math.round(composed.totalKcal), Math.round(2400 + composed.activeKcal));
});

test('an incomplete profile yields a null total rather than passing active-only off as the whole day', () => {
  const composed = composeDailyEnergy({
    bmrPerDay: null, elapsedSeconds: 86400, workoutKcal: 400, steps: 8000, weightKg: 78, workouts: [],
  });
  assert.equal(composed.restingKcal, null);
  assert.equal(composed.totalKcal, null, 'no BMR -> no honest daily total');
  assert.ok(composed.activeKcal > 0, 'active energy is still known and still reported');
});

// ---------- the itemized breakdown, end to end ----------

test('getBurnBreakdown itemizes resting, each workout with timestamps, and everyday movement', async () => {
  const db = await memDb();
  const date = '2026-01-05';
  const { userId, orgId, clientId } = await seedWorkoutDay(db, { date, startedAt: `${date}T18:00:00Z`, completedAt: `${date}T19:00:00Z` });
  await upsertHealthRecord(db, { userId, orgId }, {
    provider: 'whoop', provider_record_id: 'steps-1', data_type: 'steps',
    start_time: `${date}T00:00:00Z`, end_time: `${date}T23:59:00Z`, steps: 9000,
  });

  await reconcileUserDay(db, { userId, orgId, clientId, date, tz: 'UTC' });
  const b = await getBurnBreakdown(db, { userId, date });

  assert.ok(b, 'a reconciled day must produce a breakdown');
  assert.ok(b.totals.resting > 0, 'resting energy is populated (the column existed but was never written before)');
  assert.ok(b.totals.total > b.totals.active, 'the total includes resting on top of active');

  const types = b.entries.map((e) => e.type);
  assert.ok(types.includes('resting'), 'resting is its own line');
  assert.ok(types.includes('workout'), 'the workout is its own line');
  assert.ok(types.includes('movement'), 'everyday movement is its own line');

  const workout = b.entries.find((e) => e.type === 'workout');
  assert.ok(workout.startTime && workout.endTime, 'a workout line carries its real timestamps');
  assert.ok(workout.kcal > 0);

  // The resting line sorts last: it spans the day rather than happening at a moment.
  assert.equal(b.entries[b.entries.length - 1].type, 'resting');
});

test('when a wearable measured the session, the breakdown keeps the SK OS estimate alongside it for comparison', async () => {
  const db = await memDb();
  const date = '2026-01-06';
  const { userId, orgId, clientId } = await seedWorkoutDay(db, { date, startedAt: `${date}T18:00:00Z`, completedAt: `${date}T19:00:00Z` });
  // WHOOP measured the same session and reported a lower figure than SK OS
  // would estimate -- the live 420-vs-327 case.
  await upsertHealthRecord(db, { userId, orgId }, {
    provider: 'whoop', provider_record_id: 'whoop-w1', data_type: 'workout', activity_type: 'strength_training',
    start_time: `${date}T18:00:00Z`, end_time: `${date}T19:00:00Z`, active_kcal: 327, auto_detected: true,
  });

  await reconcileUserDay(db, { userId, orgId, clientId, date, tz: 'UTC' });
  const b = await getBurnBreakdown(db, { userId, date });
  const workout = b.entries.find((e) => e.type === 'workout');

  assert.equal(workout.source, 'whoop', 'the strap wins for a session it measured');
  assert.equal(Math.round(workout.kcal), 327);
  assert.equal(workout.isEstimate, false, 'a measured figure is not labelled an estimate');
  assert.ok(workout.comparison, 'SK OS’s own estimate is retained for comparison, not discarded');
  assert.ok(workout.comparison.skosEstimateKcal > 0);
  assert.equal(Math.round(workout.comparison.measuredKcal), 327);

  // And it must never leak into the totals.
  assert.equal(Math.round(b.totals.workouts), 327, 'only the winning figure counts toward the day');
});
