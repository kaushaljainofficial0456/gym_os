// ============================================================
// EXERCISE LIBRARY EXPANSION — safety + search coverage.
//
// Verifies the non-destructive migration (expandExerciseLibrary) and
// the alias-aware / region-filtered GET /api/workouts/exercises route:
//   • existing rows keep their id and gain only NULL metadata
//   • 80 new canonical rows, zero duplicate canonical names
//   • every exercise_relations edge resolves to a real row
//   • "db curl" / "dumbbell biceps curl" -> the one Dumbbell Curl row
//   • ?region=legs excludes chest; ?equipment=dumbbell filters
//   • no params -> the full library (contract unchanged)
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { now } from '../src/ids.js';
import { seedMuscles } from '../src/services/muscles.js';
import { expandExerciseLibrary } from '../scripts/expand-exercise-library.js';
import {
  NEW_EXERCISES, ALIAS_TO_EXISTING, EXISTING_ALIAS_ADDITIONS, EXERCISE_RELATIONS,
} from '../src/data/exerciseExpansion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const JWT_SECRET = 'test-secret-exercise-expansion';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const s = db.prepare(sql); return params.length ? s.all(...params) : s.all(); },
    async q1(sql, params = []) { const r = await this.q(sql, params); return r[0] || null; },
    async run(sql, params = []) { const s = db.prepare(sql); const r = params.length ? s.run(...params) : s.run(); return { changes: Number(r.changes) }; },
    exec(sql) { db.exec(sql); },
    raw: db,
  };
}

// A minimal but realistic "existing library": every animation_key that the
// expansion's aliases / relations point at, plus a couple of search anchors.
const EXISTING = {
  bicep_curl: ['Bicep Curl', 'BICEPS', 'DUMBBELL', 'isolation'],
  bench_press: ['Bench Press', 'CHEST', 'BARBELL', 'horizontal_push'],
  lat_pulldown: ['Lat Pulldown', 'LATS', 'CABLE', 'vertical_pull'],
  dumbbell_row: ['Dumbbell Row', 'LATS', 'DUMBBELL', 'horizontal_pull'],
  farmers_carry: ["Farmer's Carry", 'CORE', 'DUMBBELL', 'carry'],
  hammer_curl: ['Hammer Curl', 'BICEPS', 'DUMBBELL', 'isolation'],
  suitcase_carry: ['Suitcase Carry', 'CORE', 'DUMBBELL', 'carry'],
  sled_pull: ['Sled Pull', 'FULL BODY', 'BODYWEIGHT', 'carry'],
  single_arm_pushdown: ['Single-Arm Pushdown', 'TRICEPS', 'CABLE', 'isolation'],
  single_arm_pulldown: ['Single-Arm Pulldown', 'LATS', 'CABLE', 'vertical_pull'],
  standing_calf_raise: ['Standing Calf Raise', 'CALVES', 'MACHINE', 'isolation'],
  machine_chest_press: ['Machine Chest Press', 'CHEST', 'MACHINE', 'horizontal_push'],
  leg_press: ['Leg Press', 'QUADS', 'MACHINE', 'squat'],
  hip_abduction_machine: ['Hip Abduction Machine', 'GLUTES', 'MACHINE', 'isolation'],
  goblet_squat: ['Goblet Squat', 'QUADS', 'DUMBBELL', 'squat'],
};

async function makeDb() {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['org_1', 'Org', 'org-1', now()]);
  await seedMuscles(db);

  // relation / alias targets that aren't in EXISTING above -> generic stub rows
  const newKeys = new Set(NEW_EXERCISES.map((x) => x.key));
  const referenced = new Set([
    ...EXERCISE_RELATIONS.map((e) => e.to),
    ...ALIAS_TO_EXISTING.map((a) => a.canonical),
    ...Object.keys(EXISTING_ALIAS_ADDITIONS),
  ].filter((k) => !newKeys.has(k)));

  let n = 0;
  const insert = async (key, name, muscle, equip, movement) => {
    await db.run(
      `INSERT INTO exercise_library (id, org_id, name, primary_muscle, secondary_muscles, equipment, movement, ex_type, difficulty, animation_key, is_global)
       VALUES (?, NULL, ?, ?, '—', ?, ?, 'compound', 'BEGINNER', ?, 1)`,
      [`exl_seed_${n++}`, name, muscle, equip, movement, key]);
  };
  for (const [key, [name, muscle, equip, movement]] of Object.entries(EXISTING)) {
    await insert(key, name, muscle, equip, movement);
    referenced.delete(key);
  }
  for (const key of referenced) {
    await insert(key, key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), 'CHEST', 'BARBELL', 'compound');
  }
  return db;
}

test('migration is non-destructive + idempotent', async () => {
  const db = await makeDb();
  const before = await db.q('SELECT id, name, primary_muscle, equipment FROM exercise_library ORDER BY id');
  const baseCount = before.length;

  const s1 = await expandExerciseLibrary(db);
  assert.equal(s1.newInserted, NEW_EXERCISES.length, 'inserts exactly the NEW_EXERCISES');
  assert.equal(s1.skipped.length, 0, `no unresolved refs: ${s1.skipped.join(', ')}`);

  const after = await db.q('SELECT id, name, primary_muscle, equipment FROM exercise_library WHERE id IN (' + before.map(() => '?').join(',') + ') ORDER BY id', before.map((r) => r.id));
  assert.deepEqual(
    after.map((r) => [r.id, r.name, r.primary_muscle, r.equipment]),
    before.map((r) => [r.id, r.name, r.primary_muscle, r.equipment]),
    'every pre-existing row keeps its id / name / muscle / equipment',
  );
  assert.equal((await db.q1('SELECT COUNT(*) c FROM exercise_library')).c, baseCount + NEW_EXERCISES.length);

  // metadata now populated for ALL rows
  assert.equal((await db.q1(`SELECT COUNT(*) c FROM exercise_library WHERE compound_or_isolation IS NULL OR tracking_type IS NULL OR default_reps IS NULL`)).c, 0);

  // re-run: nothing changes
  const s2 = await expandExerciseLibrary(db);
  assert.equal(s2.newInserted, 0);
  assert.equal(s2.aliasesAdded, 0);
  assert.equal(s2.relationsAdded, 0);
  assert.equal((await db.q1('SELECT COUNT(*) c FROM exercise_library')).c, baseCount + NEW_EXERCISES.length);
});

test('no duplicate canonical exercise names; relations + aliases resolve', async () => {
  const db = await makeDb();
  await expandExerciseLibrary(db);

  const dups = await db.q(
    `SELECT LOWER(REPLACE(name,' ','')) k, COUNT(*) n FROM exercise_library GROUP BY k HAVING n > 1`);
  assert.deepEqual(dups, [], 'no case/space-insensitive duplicate names');

  const badRel = await db.q1(
    `SELECT COUNT(*) c FROM exercise_relations r
      WHERE NOT EXISTS (SELECT 1 FROM exercise_library e WHERE e.id = r.exercise_id)
         OR NOT EXISTS (SELECT 1 FROM exercise_library e WHERE e.id = r.related_id)`);
  assert.equal(badRel.c, 0, 'every relation endpoint resolves');
  assert.equal((await db.q1('SELECT COUNT(*) c FROM exercise_relations')).c, EXERCISE_RELATIONS.length);

  // no global alias maps to more than one exercise
  const ambiguous = await db.q(
    `SELECT LOWER(alias) a, COUNT(DISTINCT exercise_id) n FROM exercise_aliases WHERE org_id IS NULL GROUP BY a HAVING n > 1`);
  assert.deepEqual(ambiguous, [], 'each alias resolves to exactly one canonical exercise');
});

// ---- HTTP: GET /api/workouts/exercises ----
async function mountApp(db) {
  const cfg = (await import('../src/config.js')).config;
  cfg.jwtSecret = JWT_SECRET;
  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use('/api/workouts', workoutRoutes(db));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (qs) => {
    const token = jwt.sign({ sub: 'usr_1', role: 'CLIENT', org: 'org_1' }, JWT_SECRET, { expiresIn: '1h' });
    const res = await fetch(`http://127.0.0.1:${port}/api/workouts/exercises${qs}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, json: await res.json() };
  };
  return { call, close: () => server.close() };
}

test('GET /workouts/exercises: no params returns the full library (contract unchanged)', async () => {
  const db = await makeDb();
  await expandExerciseLibrary(db);
  const total = (await db.q1('SELECT COUNT(*) c FROM exercise_library')).c;
  const { call, close } = await mountApp(db);
  try {
    const r = await call('');
    assert.equal(r.status, 200);
    assert.equal(r.json.exercises.length, total, 'returns every row, unfiltered');
  } finally { close(); }
});

test('GET /workouts/exercises: alias-aware search collapses to one canonical', async () => {
  const db = await makeDb();
  await expandExerciseLibrary(db);
  const { call, close } = await mountApp(db);
  try {
    for (const q of ['db curl', 'dumbbell bicep curl', 'dumbbell biceps curl']) {
      const r = await call('?q=' + encodeURIComponent(q));
      assert.equal(r.status, 200);
      assert.ok(r.json.exercises.length >= 1, `"${q}" returns results`);
      assert.equal(r.json.exercises[0].name, 'Bicep Curl', `"${q}" -> Bicep Curl first`);
      const curlRows = r.json.exercises.filter((e) => e.name === 'Bicep Curl');
      assert.equal(curlRows.length, 1, `"${q}" -> exactly one Bicep Curl row (no alias dupes)`);
    }
    const bench = await call('?q=' + encodeURIComponent('bench press'));
    assert.equal(bench.json.exercises[0].name, 'Bench Press', 'bench press -> canonical Bench Press');
    const farmers = await call('?q=' + encodeURIComponent('farmers walk'));
    assert.equal(farmers.json.exercises[0].name, "Farmer's Carry", 'alias "farmers walk" -> Farmer\'s Carry');
  } finally { close(); }
});

test('GET /workouts/exercises: region + equipment filters', async () => {
  const db = await makeDb();
  await expandExerciseLibrary(db);
  const { call, close } = await mountApp(db);
  try {
    const legs = await call('?region=legs');
    assert.equal(legs.status, 200);
    assert.ok(legs.json.exercises.length > 0);
    assert.ok(legs.json.exercises.every((e) => e.primary_muscle !== 'CHEST'), 'region=legs never returns a CHEST exercise');

    const back = await call('?region=back');
    assert.ok(back.json.exercises.some((e) => ['LATS', 'UPPER BACK', 'TRAPS', 'LOWER BACK'].includes(e.primary_muscle)));
    assert.ok(back.json.exercises.every((e) => e.primary_muscle !== 'CHEST'));

    const db2 = await call('?equipment=dumbbell');
    assert.ok(db2.json.exercises.length > 0);
    assert.ok(db2.json.exercises.every((e) => String(e.equipment).toLowerCase().includes('dumbbell')));

    const chestDb = await call('?region=chest&equipment=dumbbell');
    assert.ok(chestDb.json.exercises.every(
      (e) => String(e.equipment).toLowerCase().includes('dumbbell')
        && ['CHEST', 'UPPER CHEST', 'LOWER CHEST'].includes(e.primary_muscle)));
  } finally { close(); }
});

test('GET /workouts/exercises: a new functional exercise is findable by name', async () => {
  const db = await makeDb();
  await expandExerciseLibrary(db);
  const { call, close } = await mountApp(db);
  try {
    const trx = await call('?q=trx');
    assert.ok(trx.json.exercises.length >= 3 && trx.json.exercises.every((e) => /trx/i.test(e.name)), 'trx -> only TRX exercises');
    const cope = await call('?q=copenhagen');
    assert.equal(cope.json.exercises[0].name, 'Copenhagen Plank');
  } finally { close(); }
});
