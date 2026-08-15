// ============================================================
// Phase 3B — training-data extraction tests (docs/training-data-contract.md).
//   * contract-0.2 features produced by the SAME choke point the
//     routes use (session/per-exercise aggregates match the
//     calorieContract test fixtures)
//   * actual completed sets only; is_synthesized sets excluded
//     BEFORE aggregation and counted; all-synthesized workouts
//     produce no record
//   * skipped exercises contribute 0 workload but stay visible
//   * incomplete sets are never features
//   * measured vs missing duration (never estimated)
//   * name-only exercise attribution; ambiguous name-only workouts
//     are skipped, never guessed
//   * duplicate library exercises collapse (totals not doubled)
//   * body weight resolution prefers weight_logs at/before the
//     session day
//   * label slot is null (no fabricated ground truth); persisted
//     baseline estimate surfaced separately, never as a label
//   * no PII / names / emails in the output; read-only extraction
//   * Phase 3B Step 2 — optional org scoping: --org narrows the export
//     to one organization (parameterized filter); omitted preserves the
//     existing, documented cross-org default; an unknown org_id fails
//     clearly via assertOrgExists rather than silently exporting nothing
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTrainingDataset, assertOrgExists, TRAINING_SCHEMA_VERSION } from '../src/services/intelligence/trainingData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

// ---------------- in-memory DB + fixtures ----------------
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
    raw: db
  });
  return mk();
}

const ORG = 'o1', USER = 'u1', CLIENT = 'c1';
const LIBS = {
  bench: { id: 'libA', name: 'Bench Press', primary_muscle: 'CHEST', equipment: 'BARBELL', movement: 'horizontal_push', ex_type: 'compound' },
  pulldown: { id: 'libB', name: 'Lat Pulldown', primary_muscle: 'LATS', equipment: 'CABLE', movement: 'vertical_pull', ex_type: 'compound' },
  curl: { id: 'libC', name: 'Dumbbell Curl', primary_muscle: 'BICEPS', equipment: 'DUMBBELL', movement: 'elbow_flexion', ex_type: 'isolation' }
};

async function seedBase(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [ORG, 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [USER, ORG, 'c@a.in', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES (?, ?, ?, 'FAT_LOSS', ?, ?, ?, ?, ?, ?)`,
    [CLIENT, USER, ORG, 30, 'M', 175, 80, 78, '2026-01-01T00:00:00Z']);
  for (const l of Object.values(LIBS)) {
    await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [l.id, l.name, l.primary_muscle, l.equipment, l.movement, l.ex_type]);
  }
}

// ---- Phase 3B Step 2: a second organization, for org-scoping tests ----
// exercise_library rows are global (is_global=1, org_id NULL) so both
// orgs share the same library — mirrors seedBase's own setup.
const ORG2 = 'o2', USER2 = 'u2', CLIENT2 = 'c2';
async function seedSecondOrg(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [ORG2, 'Gym B', 'gym-b', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [USER2, ORG2, 'c@b.in', 'x', 'Client Two', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES (?, ?, ?, 'FAT_LOSS', ?, ?, ?, ?, ?, ?)`,
    [CLIENT2, USER2, ORG2, 28, 'F', 165, 65, 63, '2026-01-01T00:00:00Z']);
}

// Insert a completed workout with planned exercises + per-set rows.
// orgId/clientId default to the single-org fixture (ORG/CLIENT) so every
// existing call site is unaffected; org-scoping tests pass them explicitly.
// setLogs: [{ exercise_id (library id | null), actual_reps, actual_weight, completed?, is_synthesized? }]
async function seedWorkout(db, { id = 'wko_1', orgId = ORG, clientId = CLIENT, startedAt = '2026-08-15T09:00:00Z', completedAt = '2026-08-15T09:30:00Z', persisted = null, exercises = [], setLogs = [] } = {}) {
  await db.run(
    `INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
    [id, orgId, clientId, 'Push Day', '2026-08-15', startedAt, completedAt, '2026-08-15T00:00:00Z']);
  if (persisted) {
    await db.run(
      `UPDATE workouts SET estimated_active_kcal = ?, lower_kcal = ?, upper_kcal = ?, model_version = ?, schema_version = ?, calorie_provider = ?, calorie_estimated_at = ?
       WHERE id = ?`,
      [persisted.estimated_active_kcal, persisted.lower_kcal, persisted.upper_kcal, persisted.model_version,
       persisted.schema_version, persisted.calorie_provider, '2026-08-15T09:30:00Z', id]);
  }
  for (const [i, e] of exercises.entries()) {
    await db.run(
      `INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, id, e.exercise_id, i, e.name, e.sets ?? 3, e.reps ?? '10', e.weight ?? '0', e.rest_sec ?? 90]);
  }
  for (const s of setLogs) {
    const logId = 'wlg_' + Math.random().toString(36).slice(2, 10);
    await db.run(
      `INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [logId, clientId, id, s.exercise_id, '2026-08-15', 1, s.actual_reps, s.actual_weight]);
    await db.run(
      `INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, actual_reps, actual_weight, rest_seconds, rir, completed, is_synthesized)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [id + '_s_' + Math.random().toString(36).slice(2, 10), logId, clientId, s.exercise_id,
       s.actual_reps, s.actual_weight, s.rest_seconds ?? null, s.rir ?? null, s.completed ?? 1, s.is_synthesized ?? 0]);
  }
  return id;
}

async function collect(db, opts = {}) {
  const stats = {};
  const recs = [];
  for await (const r of extractTrainingDataset(db, { ...opts, stats })) recs.push(r);
  return { recs, stats };
}

// ---------------- tests ----------------

test('exports a completed workout with real sets as a contract-0.2 record', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [
      { id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' },
      { id: 'wxeC', exercise_id: 'libC', name: 'Dumbbell Curl', sets: 2, reps: '10', weight: '15' }
    ],
    setLogs: [
      { exercise_id: 'libA', actual_reps: 10, actual_weight: 60 },
      { exercise_id: 'libA', actual_reps: 8, actual_weight: 60 },
      { exercise_id: 'libC', actual_reps: 10, actual_weight: 15 },
      { exercise_id: 'libC', actual_reps: 10, actual_weight: 15 }
    ],
    persisted: { estimated_active_kcal: 285, lower_kcal: 242, upper_kcal: 328, model_version: 'skos-cal-baseline-v1', schema_version: '0.2', calorie_provider: 'baseline' }
  });
  const { recs, stats } = await collect(db);
  assert.equal(recs.length, 1);
  assert.equal(stats.scanned, 1);
  assert.equal(stats.written, 1);

  const r = recs[0];
  assert.equal(r.schema_version, TRAINING_SCHEMA_VERSION);
  assert.equal(r.workout_id, 'wko_1');
  assert.equal(r.client_id, CLIENT);
  assert.equal(r.duration_measured, true);

  const s = r.features.session;
  assert.equal(s.exercise_count, 2);
  assert.equal(s.total_sets, 4);
  assert.equal(s.total_reps, 38);            // 10+8+10+10
  assert.equal(s.total_volume_kg, 1380);      // (600+480)+(150+150)
  assert.equal(s.duration_seconds, 1800);
  assert.equal(s.duration_minutes, 30);
  assert.equal(s.volume_per_minute, 46);
  assert.equal(s.sets_per_minute, 0.13);
  assert.equal(s.reps_per_minute, 1.27);
  assert.equal(s.compound_set_ratio, 0.5);
  assert.equal(s.isolation_set_ratio, 0.5);
  assert.equal(s.relative_load, 0.47);        // (1380/38) / 78

  assert.equal(r.features.user.age_years, 30);
  // Pass-through of the stored value through the choke point (lowercased).
  // The contract enum (male|female|other) normalization is a pre-existing
  // choke-point concern — the export never re-derives features.
  assert.equal(r.features.user.sex, 'm');
  assert.equal(r.features.user.height_cm, 175);
  assert.equal(r.features.user.body_weight_kg, 78); // falls back to clients.current_weight

  const bench = r.features.exercises.find((e) => e.exercise_id === 'libA');
  assert.deepEqual(
    { sets: bench.sets, total_reps: bench.total_reps, total_volume_kg: bench.total_volume_kg, average_load_kg: bench.average_load_kg },
    { sets: 2, total_reps: 18, total_volume_kg: 1080, average_load_kg: 60 });

  // label slot is reserved, never fabricated; persisted estimate is NOT a label
  assert.deepEqual(r.label, { kcal: null, source: null, ground_truth: false });
  assert.deepEqual(r.baseline_estimate, { kcal: 285, model_version: 'skos-cal-baseline-v1', provider: 'baseline' });
});

test('synthesized sets are excluded from features and counted', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [{ id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' }],
    setLogs: [
      { exercise_id: 'libA', actual_reps: 10, actual_weight: 60 },
      { exercise_id: 'libA', actual_reps: 8, actual_weight: 60, is_synthesized: 1 },
      { exercise_id: 'libA', actual_reps: 5, actual_weight: 100, is_synthesized: 1 }
    ]
  });
  const { recs } = await collect(db);
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.synthesized_sets_excluded, 2, 'synthesized rows counted for provenance');
  assert.equal(r.features.session.total_sets, 1);
  assert.equal(r.features.session.total_reps, 10);
  assert.equal(r.features.session.total_volume_kg, 600);
  assert.equal(r.features.exercises[0].completed_sets.length, 1);
});

test('workout with only synthesized sets produces NO record', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [{ id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' }],
    setLogs: [
      { exercise_id: 'libA', actual_reps: 10, actual_weight: 60, is_synthesized: 1 },
      { exercise_id: 'libA', actual_reps: 8, actual_weight: 60, is_synthesized: 1 }
    ]
  });
  const { recs, stats } = await collect(db);
  assert.equal(recs.length, 0);
  assert.equal(stats.noRealSets, 1, 'no real completed sets -> skipped, not exported');
});

test('skipped exercises contribute 0 workload but stay visible', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [
      { id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' },
      { id: 'wxeB', exercise_id: 'libB', name: 'Lat Pulldown', sets: 3, reps: '12', weight: '50' }
    ],
    setLogs: [
      { exercise_id: 'libA', actual_reps: 10, actual_weight: 60 },
      { exercise_id: 'libA', actual_reps: 8, actual_weight: 60 }
    ]
  });
  const { recs } = await collect(db);
  const r = recs[0];
  assert.equal(r.features.session.exercise_count, 1, 'only performed exercises count');
  assert.equal(r.features.session.total_sets, 2);
  const skipped = r.features.exercises.find((e) => e.exercise_id === 'libB');
  assert.ok(skipped, 'skipped exercise still visible in the session');
  assert.equal(skipped.sets, 0);
  assert.equal(skipped.total_reps, 0);
  assert.equal(skipped.total_volume_kg, 0);
  assert.equal(skipped.completed_sets.length, 0);
});

test('incomplete sets are never features', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [{ id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' }],
    setLogs: [
      { exercise_id: 'libA', actual_reps: 10, actual_weight: 60, completed: 1 },
      { exercise_id: 'libA', actual_reps: 5, actual_weight: 60, completed: 0 }
    ]
  });
  const { recs } = await collect(db);
  const r = recs[0];
  assert.equal(r.features.session.total_sets, 1);
  assert.equal(r.features.session.total_reps, 10);
});

test('no measured duration -> duration null, never estimated', async () => {
  const db = await memDb();
  await seedBase(db);
  // started_at missing (e.g. workout completed without /start, like NL sessions):
  // completed_at exists so the workout is exported, but duration is null.
  await seedWorkout(db, {
    startedAt: null,
    completedAt: '2026-08-15T09:30:00Z',
    exercises: [{ id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' }],
    setLogs: [{ exercise_id: 'libA', actual_reps: 10, actual_weight: 60 }]
  });
  const { recs } = await collect(db);
  const r = recs[0];
  assert.equal(r.duration_measured, false);
  assert.equal(r.features.session.duration_seconds, null);
  assert.equal(r.features.session.duration_minutes, null);
  assert.equal(r.features.session.volume_per_minute, null);
  assert.equal(r.features.session.sets_per_minute, null);
  assert.equal(r.baseline_estimate, null, 'no persisted estimate -> no baseline reference');
  assert.deepEqual(r.label, { kcal: null, source: null, ground_truth: false });
});

test('name-only exercise (exercise_id null) is attributed by name', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [{ id: 'wxeN', exercise_id: null, name: 'Mystery Move', sets: 3, reps: '10', weight: 'BW' }],
    setLogs: [{ exercise_id: null, actual_reps: 10, actual_weight: 0 }]
  });
  const { recs } = await collect(db);
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.features.session.total_sets, 1);
  assert.equal(r.features.session.total_reps, 10);
  assert.equal(r.features.exercises.length, 1);
  assert.equal(r.features.exercises[0].exercise_id, 'Mystery Move', 'name used as the exercise id fallback');
});

test('ambiguous name-only workout is skipped, never guessed', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [
      { id: 'wxeN1', exercise_id: null, name: 'Mystery A', sets: 3, reps: '10', weight: 'BW' },
      { id: 'wxeN2', exercise_id: null, name: 'Mystery B', sets: 3, reps: '10', weight: 'BW' }
    ],
    setLogs: [{ exercise_id: null, actual_reps: 10, actual_weight: 0 }]
  });
  const { recs, stats } = await collect(db);
  assert.equal(recs.length, 0);
  assert.equal(stats.ambiguous, 1);
});

test('duplicate library exercise collapses (session totals not doubled)', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [
      { id: 'wxeA1', exercise_id: 'libA', name: 'Bench A', sets: 3, reps: '10', weight: '60' },
      { id: 'wxeA2', exercise_id: 'libA', name: 'Bench B', sets: 3, reps: '10', weight: '60' }
    ],
    setLogs: [
      { exercise_id: 'libA', actual_reps: 10, actual_weight: 60 },
      { exercise_id: 'libA', actual_reps: 8, actual_weight: 60 }
    ]
  });
  const { recs } = await collect(db);
  const r = recs[0];
  assert.equal(r.features.session.total_sets, 2, 'sets must not be double-counted');
  assert.equal(r.features.session.total_reps, 18);
  assert.equal(r.features.exercises.length, 1, 'one entry per library exercise');
  assert.equal(r.features.exercises[0].exercise_id, 'libA');
});

test('body weight prefers weight_logs at/before the session day', async () => {
  const db = await memDb();
  await seedBase(db);
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?, ?, ?, ?, ?)', ['wl_early', CLIENT, '2026-08-10', 80, '2026-08-10T00:00:00Z']);
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?, ?, ?, ?, ?)', ['wl_late', CLIENT, '2026-08-20', 85, '2026-08-20T00:00:00Z']);
  await seedWorkout(db, {
    exercises: [{ id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' }],
    setLogs: [
      { exercise_id: 'libA', actual_reps: 10, actual_weight: 60 },
      { exercise_id: 'libA', actual_reps: 8, actual_weight: 60 }
    ]
  });
  const { recs } = await collect(db);
  const r = recs[0];
  assert.equal(r.features.user.body_weight_kg, 80, 'weight_logs at/before session day wins over current_weight 78');
  assert.equal(r.features.session.relative_load, 0.75, 'relative load uses the resolved weight (60/80)');
});

test('empty database -> zero records, no crash', async () => {
  const db = await memDb();
  const { recs, stats } = await collect(db);
  assert.equal(recs.length, 0);
  assert.equal(stats.scanned, 0);
});

test('output contains no PII: names, emails, workout names never exported', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [
      { id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' },
      { id: 'wxeB', exercise_id: 'libB', name: 'Lat Pulldown', sets: 3, reps: '12', weight: '50' }
    ],
    setLogs: [
      { exercise_id: 'libA', actual_reps: 10, actual_weight: 60 },
      { exercise_id: 'libA', actual_reps: 8, actual_weight: 60 }
    ],
    persisted: { estimated_active_kcal: 285, lower_kcal: 242, upper_kcal: 328, model_version: 'skos-cal-baseline-v1', schema_version: '0.2', calorie_provider: 'baseline' }
  });
  const { recs } = await collect(db);
  const json = JSON.stringify(recs);
  for (const banned of ['Client One', 'c@a.in', 'Push Day', 'Bench Press', 'Lat Pulldown']) {
    assert.ok(!json.includes(banned), `export must not contain ${banned}`);
  }
  // opaque tokens + contract fields present
  assert.ok(json.includes('wko_1'));
  assert.ok(json.includes('"schema_version":"0.2"'));
});

test('extraction is read-only — database rows are unchanged', async () => {
  const db = await memDb();
  await seedBase(db);
  await seedWorkout(db, {
    exercises: [{ id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' }],
    setLogs: [{ exercise_id: 'libA', actual_reps: 10, actual_weight: 60 }]
  });
  const count = async (table) => {
    const row = await db.q1(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(row.n);
  };
  const before = {
    workouts: await count('workouts'),
    setLogs: await count('exercise_set_logs'),
    workoutLogs: await count('workout_logs')
  };
  await collect(db);
  assert.equal(await count('workouts'), before.workouts);
  assert.equal(await count('exercise_set_logs'), before.setLogs);
  assert.equal(await count('workout_logs'), before.workoutLogs);
});

// ============================================================
// Phase 3B Step 2 — organization scoping (docs/training-data-contract.md §1.1)
//   * optional orgId narrows extractTrainingDataset to one organization
//   * omitted orgId preserves the existing, documented cross-org default
//   * unknown org_id fails clearly via assertOrgExists (the CLI turns
//     this into a non-zero exit), never a silent empty dataset
//   * no PII crosses organizations either way
// ============================================================

// Two-org fixture shared by the scoping tests below.
async function seedTwoOrgWorkouts(db) {
  await seedBase(db);
  await seedSecondOrg(db);
  await seedWorkout(db, {
    id: 'wko_orgA',
    exercises: [{ id: 'wxeA', exercise_id: 'libA', name: 'Bench Press', sets: 3, reps: '10', weight: '60' }],
    setLogs: [{ exercise_id: 'libA', actual_reps: 10, actual_weight: 60 }]
  });
  await seedWorkout(db, {
    id: 'wko_orgB',
    orgId: ORG2,
    clientId: CLIENT2,
    exercises: [{ id: 'wxeB', exercise_id: 'libB', name: 'Lat Pulldown', sets: 3, reps: '12', weight: '50' }],
    setLogs: [{ exercise_id: 'libB', actual_reps: 12, actual_weight: 50 }]
  });
}

test('org A export (orgId scoped) contains only org A workouts', async () => {
  const db = await memDb();
  await seedTwoOrgWorkouts(db);
  const { recs } = await collect(db, { orgId: ORG });
  assert.equal(recs.length, 1, 'only org A workout returned');
  assert.equal(recs[0].workout_id, 'wko_orgA');
  assert.equal(recs[0].org_id, ORG);
  assert.ok(!recs.some((r) => r.org_id === ORG2), 'org B never appears in an org A scoped export');
});

test('org B export (orgId scoped) contains only org B workouts', async () => {
  const db = await memDb();
  await seedTwoOrgWorkouts(db);
  const { recs } = await collect(db, { orgId: ORG2 });
  assert.equal(recs.length, 1, 'only org B workout returned');
  assert.equal(recs[0].workout_id, 'wko_orgB');
  assert.equal(recs[0].org_id, ORG2);
  assert.ok(!recs.some((r) => r.org_id === ORG), 'org A never appears in an org B scoped export');
});

test('no org filter (orgId omitted) still exports both organizations — existing default preserved', async () => {
  const db = await memDb();
  await seedTwoOrgWorkouts(db);
  const { recs } = await collect(db); // no orgId -> unchanged cross-org default
  assert.equal(recs.length, 2, 'both workouts exported when no org filter is given');
  assert.deepEqual([...new Set(recs.map((r) => r.org_id))].sort(), [ORG, ORG2].sort(), 'default export spans both organizations');
});

test('assertOrgExists: known organization resolves without throwing', async () => {
  const db = await memDb();
  await seedBase(db);
  await assert.doesNotReject(() => assertOrgExists(db, ORG));
});

test('assertOrgExists: unknown organization throws — CLI turns this into a clear non-zero exit, never a silent empty dataset', async () => {
  const db = await memDb();
  await seedBase(db);
  await assert.rejects(() => assertOrgExists(db, 'org_does_not_exist'), /unknown organization/);
});

test('org-scoped export introduces no PII across organizations', async () => {
  const db = await memDb();
  await seedTwoOrgWorkouts(db);
  const { recs } = await collect(db, { orgId: ORG });
  const json = JSON.stringify(recs);
  for (const banned of ['Client One', 'Client Two', 'c@a.in', 'c@b.in', 'Gym A', 'Gym B', 'Push Day', 'Bench Press', 'Lat Pulldown']) {
    assert.ok(!json.includes(banned), `org-scoped export must not contain ${banned}`);
  }
});

test('org scoping does not change the JSONL record contract shape', async () => {
  const db = await memDb();
  await seedTwoOrgWorkouts(db);
  const { recs } = await collect(db, { orgId: ORG });
  const r = recs[0];
  // Same top-level keys the unscoped contract test asserts — scoping is
  // purely a WHERE-clause change, never a record-shape change.
  assert.deepEqual(
    Object.keys(r).sort(),
    ['baseline_estimate', 'client_id', 'completed_at', 'duration_measured', 'features', 'label', 'org_id', 'schema_version', 'scheduled_date', 'synthesized_sets_excluded', 'workout_id'].sort()
  );
  assert.equal(r.schema_version, TRAINING_SCHEMA_VERSION);
});
