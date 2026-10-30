// ============================================================
// End-to-end integration test for reconcileUserDay
// (backend/src/services/health/dailyIntelligence.js) against a real
// (in-memory) SQLite DB -- exercises the FULL pipeline: real SK OS
// workout/exercise/set rows, real health_records, the real
// calorieModel.js baseline estimator (config.calorieModelProvider
// defaults to 'baseline', no network/ML needed), and real
// health_canonical_workouts / health_energy_intervals /
// health_daily_summaries / health_reconciliation_log writes.
//
// Covers spec TEST 7 (late-arriving wearable data reconciles an
// existing estimate) end-to-end, which the pure-function tests in
// healthReconciliation.test.js cannot exercise on their own since it
// requires re-running against persisted state.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileUserDay, getDailyIntelligence } from '../src/services/health/dailyIntelligence.js';
import { upsertHealthRecord } from '../src/services/health/dedup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    async q(sql, params = []) { return db.prepare(sql).all(...params); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const res = db.prepare(sql).run(...params); return { changes: Number(res.changes) }; },
  });
  return mk();
}

async function seedWorkoutDay(db, { date, startedAt, completedAt }) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@test.com', 'x', 'Client', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO clients (id, user_id, org_id, goal, current_weight, age, sex, height_cm, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['c1', 'u1', 'o1', 'GENERAL', 78, 30, 'male', 178, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?,NULL,?,?,?,?,?,1)`,
    ['ex_bench', 'Bench Press', 'chest', 'barbell', 'horizontal_push', 'compound']);
  await db.run(`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, started_at, completed_at, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['w1', 'o1', 'c1', 'Push Day', date, 'completed', startedAt, completedAt, 'program', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['we1', 'w1', 'ex_bench', 0, 'Bench Press', 4, '8', '60', 90]);
  await db.run(`INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, created_at) VALUES (?,?,?,?,?,?,?)`,
    ['wl1', 'c1', 'w1', 'ex_bench', date, 4, startedAt]);
  for (let i = 1; i <= 4; i++) {
    await db.run(`INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, actual_reps, actual_weight, completed) VALUES (?,?,?,?,?,?,?,1)`,
      [`sl${i}`, 'wl1', 'c1', 'ex_bench', i, 8, 60]);
  }
  return { userId: 'u1', orgId: 'o1', clientId: 'c1', workoutId: 'w1' };
}

test('reconcileUserDay: no wearable data at all -> SK OS baseline estimate, real canonical workout written', async () => {
  const db = await memDb();
  const date = '2026-01-05';
  const { userId, orgId, clientId } = await seedWorkoutDay(db, { date, startedAt: `${date}T18:00:00Z`, completedAt: `${date}T19:00:00Z` });

  const summary = await reconcileUserDay(db, { userId, orgId, clientId, date, tz: 'UTC' });
  assert.ok(summary.active_energy > 0, 'baseline estimator should produce a real positive kcal figure');
  assert.equal(summary.reconciliation_status, 'ok');

  const canon = await db.q1('SELECT * FROM health_canonical_workouts WHERE skos_workout_id = ?', ['w1']);
  assert.ok(canon, 'a canonical workout row must exist');
  assert.equal(canon.primary_energy_source, 'baseline'); // calorieModel.js's baseline provider name, since no ML/wearable evidence

  const interval = await db.q1('SELECT * FROM health_energy_intervals WHERE canonical_workout_id = ?', [canon.id]);
  assert.ok(interval, 'an energy interval must be persisted');
  assert.equal(interval.is_estimate, 1);
});

test('reconcileUserDay estimates with the weight logged nearest the workout day, as completion does -- not the profile weight', async () => {
  const date = '2026-01-07';
  const at = { date, startedAt: `${date}T18:00:00Z`, completedAt: `${date}T19:00:00Z` };

  const profileOnly = await memDb();
  const ids = await seedWorkoutDay(profileOnly, at); // clients.current_weight = 78
  await reconcileUserDay(profileOnly, { ...ids, date, tz: 'UTC' });

  const logged = await memDb();
  await seedWorkoutDay(logged, at);
  await logged.run('INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?,?,?,?,?)',
    ['wt1', 'c1', date, 95, `${date}T07:00:00Z`]);
  await reconcileUserDay(logged, { ...ids, date, tz: 'UTC' });

  const kcal = async (db) => (await db.q1('SELECT active_kcal FROM health_canonical_workouts WHERE skos_workout_id = ?', ['w1'])).active_kcal;
  assert.ok(await kcal(logged) > await kcal(profileOnly), 'a heavier logged weight on the day must raise the estimate');
});

test('TEST 7 -- late-arriving wearable data on a strength session is attached beside BARBELL’s estimate, not swapped in', async () => {
  const db = await memDb();
  const date = '2026-01-06';
  const { userId, orgId, clientId } = await seedWorkoutDay(db, { date, startedAt: `${date}T18:00:00Z`, completedAt: `${date}T19:00:00Z` });

  // Pass 1: no wearable data yet -- BARBELL estimate only.
  const first = await reconcileUserDay(db, { userId, orgId, clientId, date, tz: 'UTC' });
  const firstCanon = await db.q1('SELECT * FROM health_canonical_workouts WHERE skos_workout_id = ?', ['w1']);
  assert.equal(firstCanon.primary_energy_source, 'baseline');
  assert.equal(firstCanon.wearable_active_kcal, null);

  // Apple Health syncs in late, fully covering the session, from a named device.
  await upsertHealthRecord(db, { userId, orgId }, {
    provider: 'apple_health', provider_record_id: 'ah-late-1', data_type: 'workout', activity_type: 'strength_training',
    start_time: `${date}T18:00:00Z`, end_time: `${date}T19:00:00Z`, active_kcal: 305, auto_detected: true,
    source_device: 'Apple Watch Series 9', source_app: 'com.apple.health',
  });

  // Pass 2: re-run reconciliation (spec §22 -- must be safe/idempotent to call again).
  const second = await reconcileUserDay(db, { userId, orgId, clientId, date, tz: 'UTC' });
  const secondCanon = await db.q1('SELECT * FROM health_canonical_workouts WHERE skos_workout_id = ?', ['w1']);

  assert.equal(secondCanon.id, firstCanon.id, 'must UPDATE the same canonical workout, never create a second one');
  assert.equal(secondCanon.primary_energy_source, 'baseline', 'BARBELL’s estimate stays primary for a strength session');
  assert.equal(secondCanon.active_kcal, firstCanon.active_kcal);
  assert.equal(secondCanon.energy_basis, 'model_estimate');
  assert.equal(secondCanon.reconciliation_policy, 'barbell_primary_strength_v1');
  assert.equal(secondCanon.wearable_active_kcal, 305, 'the wearable figure is preserved separately');
  assert.equal(secondCanon.wearable_provider, 'apple_health');
  assert.equal(secondCanon.wearable_source_device, 'Apple Watch Series 9');
  assert.equal(secondCanon.wearable_source_app, 'com.apple.health');
  assert.equal(secondCanon.wearable_measurement_type, 'device_estimate');
  assert.equal(secondCanon.wearable_coverage_ratio, 1);
  const expectedRatio = Math.abs(305 - firstCanon.active_kcal) / Math.max(305, firstCanon.active_kcal);
  assert.ok(Math.abs(secondCanon.disagreement_ratio - expectedRatio) < 1e-9);
  assert.equal(secondCanon.disagreement_flag, expectedRatio > 0.4 ? 1 : 0);
  assert.equal(secondCanon.confidence_score, firstCanon.confidence_score, 'the wearable does not raise confidence');
  assert.equal(second.active_energy, first.active_energy, 'the day’s active energy still counts BARBELL’s figure once');

  const rec = await db.q1('SELECT canonical_workout_id, source_device FROM health_records WHERE provider_record_id = ?', ['ah-late-1']);
  assert.equal(rec.canonical_workout_id, firstCanon.id, 'the wearable record is linked to the session');
  assert.equal(rec.source_device, 'Apple Watch Series 9');

  const intervals = await db.q('SELECT * FROM health_energy_intervals WHERE canonical_workout_id = ? ORDER BY is_primary DESC', [firstCanon.id]);
  assert.equal(intervals.length, 2);
  assert.equal(intervals[0].is_primary, 1);
  assert.equal(intervals[0].is_estimate, 1);
  assert.equal(intervals[1].is_primary, 0, 'the wearable figure is stored but never counted');
  assert.equal(intervals[1].source, 'apple_health');
  assert.equal(intervals[1].active_kcal, 305);

  const allCanon = await db.q('SELECT id FROM health_canonical_workouts WHERE skos_workout_id = ?', ['w1']);
  assert.equal(allCanon.length, 1, 'still exactly ONE canonical workout after reconciling twice');
  const log = await db.q('SELECT * FROM health_reconciliation_log WHERE canonical_workout_id = ?', [firstCanon.id]);
  assert.equal(log.length, 0, 'the stored figure and its source did not change, so there is nothing to audit');
});

test('heart-rate samples alone never make a wearable the recorded source of a strength session', async () => {
  const db = await memDb();
  const date = '2026-01-08';
  const { userId, orgId, clientId } = await seedWorkoutDay(db, { date, startedAt: `${date}T18:00:00Z`, completedAt: `${date}T19:00:00Z` });
  await upsertHealthRecord(db, { userId, orgId }, {
    provider: 'apple_health', provider_record_id: 'hr-1', data_type: 'heart_rate',
    start_time: `${date}T18:05:00Z`, end_time: `${date}T18:55:00Z`, heart_rate_avg: 128,
  });
  await reconcileUserDay(db, { userId, orgId, clientId, date, tz: 'UTC' });
  const canon = await db.q1('SELECT * FROM health_canonical_workouts WHERE skos_workout_id = ?', ['w1']);
  assert.equal(canon.primary_energy_source, 'baseline');
  assert.equal(canon.wearable_measurement_type, 'heart_rate_only');
  assert.equal(canon.wearable_active_kcal, null);
  const iv = await db.q('SELECT * FROM health_energy_intervals WHERE canonical_workout_id = ?', [canon.id]);
  assert.equal(iv.length, 1, 'no wearable energy row: none was reported');
  assert.equal(iv[0].source, 'baseline');
  assert.equal(iv[0].is_estimate, 1);
});

test('an implausibly long workout (started_at/completed_at spanning many hours) is flagged, never fed to the calorie estimator', async () => {
  // Found live: a workout started on one day and completed much later
  // (e.g. left "in progress" across a session boundary) produced a
  // five-figure kcal estimate the first time this was tested against a
  // real UI flow. This is the regression test for that fix.
  const db = await memDb();
  const date = '2026-01-07';
  const { userId, orgId, clientId } = await seedWorkoutDay(db, {
    date, startedAt: '2026-01-06T19:29:33.165Z', completedAt: `${date}T11:50:00.000Z`, // ~16.3 hours apart
  });

  const summary = await reconcileUserDay(db, { userId, orgId, clientId, date, tz: 'UTC' });
  assert.equal(summary.active_energy, 0, 'no plausible-duration evidence exists for this day -- must not fabricate a huge estimate');

  const canon = await db.q1('SELECT * FROM health_canonical_workouts WHERE skos_workout_id = ?', ['w1']);
  assert.ok(canon, 'the workout must still be represented, not silently dropped');
  assert.equal(canon.data_quality, 'suspicious');
  assert.equal(canon.active_kcal, null, 'never fabricate an energy figure from an implausible duration');

  const interval = await db.q1('SELECT * FROM health_energy_intervals WHERE canonical_workout_id = ?', [canon.id]);
  assert.equal(interval, null, 'no energy interval should be written for a flagged, non-trustworthy duration');
});

test('getDailyIntelligence returns null for a day never reconciled, never a fabricated zero summary', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@test.com', 'x', 'Client', '2026-01-01T00:00:00Z']);
  const result = await getDailyIntelligence(db, { userId: 'u1', date: '2026-03-01' });
  assert.equal(result, null);
});
