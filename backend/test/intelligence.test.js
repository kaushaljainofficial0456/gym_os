// ============================================================
// SK INTELLIGENCE ENGINE tests — deterministic parsing, unit
// conversion, nutrient scaling, workout parsing, alias search,
// program generation constraints, provenance.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await this.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    raw: db
  };
}

// ---------- food parsing ----------
test('parses single foods with quantity + unit', async () => {
  const { parseFoodInput } = await import('../src/services/intelligence/parseFoods.js');
  const a = parseFoodInput('220g paneer');
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].qty, 220);
  assert.equal(a.items[0].unit, 'g');
  assert.equal(a.items[0].unitType, 'gram');
  assert.equal(a.items[0].name, 'paneer');

  const kg = parseFoodInput('0.22kg paneer');
  assert.equal(kg.items[0].qty, 220, 'kg converted to grams');

  const phrased = parseFoodInput('I ate 220 grams of paneer.');
  assert.equal(phrased.items[0].qty, 220);
  assert.equal(phrased.items[0].name, 'paneer');
});

test('parses mixed meals with multiple foods', async () => {
  const { parseFoodInput } = await import('../src/services/intelligence/parseFoods.js');
  const mixed = parseFoodInput('2 rotis + 150g rice');
  assert.equal(mixed.items.length, 2);
  assert.deepEqual([mixed.items[0].qty, mixed.items[0].unit], [2, 'rotis']);
  assert.deepEqual([mixed.items[1].qty, mixed.items[1].unit], [150, 'g']);

  const oats = parseFoodInput('100g oats + 250ml milk');
  assert.equal(oats.items.length, 2);
  assert.equal(oats.items[1].qty, 250);
  assert.equal(oats.items[1].unit, 'ml');

  const andForm = parseFoodInput('3 eggs and 1 banana');
  assert.equal(andForm.items.length, 2);
  assert.equal(andForm.items[0].qty, 3);
  assert.equal(andForm.items[0].unitType, 'piece', 'eggs parsed as pieces');
  assert.equal(andForm.items[1].qty, 1);
  assert.equal(andForm.items[1].unit, 'banana');
});

test('unit-as-food-name: "2 rotis" carries the food name for resolution', async () => {
  const { parseFoodInput } = await import('../src/services/intelligence/parseFoods.js');
  const roti = parseFoodInput('2 rotis');
  assert.equal(roti.items[0].name, 'roti', 'food-word unit becomes the search name');
  assert.equal(roti.items[0].qty, 2);
  const eggs = parseFoodInput('3 eggs');
  assert.equal(eggs.items[0].name, 'egg');
  // generic piece words are NOT food names — stay unresolved for the caller
  const pieces = parseFoodInput('2 pieces of chicken');
  assert.equal(pieces.items[0].name, 'chicken');
});

test('unit conversions are consistent', async () => {
  const { parseQuantity } = await import('../src/services/intelligence/units.js');
  assert.equal(parseQuantity('0.22 kg').qty, 220);
  assert.equal(parseQuantity('1 litre').qty, 1000);
  assert.equal(parseQuantity('250 ml').qty, 250);
  assert.equal(parseQuantity('2 rotis').unitType, 'piece');
  assert.equal(parseQuantity('1 bowl').provenance, 'ESTIMATED');
});

// ---------- nutrient scaling ----------
test('scales per-100g foods linearly with rounding', async () => {
  const { computeNutrition } = await import('../src/services/intelligence/nutrition.js');
  const paneer = { id: 'f1', name: 'Paneer', serving: '100 g', calories: 265, protein: 18, carbs: 4, fat: 21, source: 'VERIFIED_DATABASE', is_global: 1 };
  const n = computeNutrition(paneer, { qty: 220, unit: 'g', unitType: 'gram', provenance: 'USER_ENTERED' });
  assert.equal(n.macros.calories, Math.round(265 * 2.2));  // 583
  assert.equal(n.macros.protein, Math.round(18 * 2.2 * 10) / 10); // 39.6
  assert.equal(n.macros.fat, Math.round(21 * 2.2 * 10) / 10); // 46.2
  assert.equal(n.provenance, 'VERIFIED_DATABASE');
  assert.equal(n.confidence, 'HIGH');
  assert.ok(n.calculation.includes('220 / 100'), 'calculation traceable');
});

test('scales against the food\'s own serving base', async () => {
  const { computeNutrition } = await import('../src/services/intelligence/nutrition.js');
  // oats: macros per 50 g serving
  const oats = { id: 'f2', name: 'Oats', serving: '50 g', calories: 190, protein: 7, carbs: 33, fat: 3.4, source: 'VERIFIED_DATABASE', is_global: 1 };
  const n = computeNutrition(oats, { qty: 100, unit: 'g', unitType: 'gram', provenance: 'USER_ENTERED' });
  assert.equal(n.macros.calories, 380, '100g of a 50g-base food = 2×');
  // pieces: roti macros are per 1 pc
  const roti = { id: 'f3', name: 'Roti', serving: '1 pc', calories: 104, protein: 3.5, carbs: 18, fat: 1, source: 'VERIFIED_DATABASE', is_global: 1 };
  const two = computeNutrition(roti, { qty: 2, unit: 'rotis', unitType: 'rotis', provenance: 'USER_ENTERED' });
  assert.equal(two.macros.calories, 208, '2 rotis = 2× one roti');
});

test('500g vs 220g of the same food scale proportionally', async () => {
  const { computeNutrition } = await import('../src/services/intelligence/nutrition.js');
  const food = { id: 'f4', name: 'Chicken breast', serving: '150 g', calories: 247, protein: 46.5, carbs: 0, fat: 5.4, source: 'VERIFIED_DATABASE', is_global: 1 };
  const big = computeNutrition(food, { qty: 500, unit: 'g', unitType: 'gram', provenance: 'USER_ENTERED' });
  const small = computeNutrition(food, { qty: 220, unit: 'g', unitType: 'gram', provenance: 'USER_ENTERED' });
  assert.equal(big.macros.calories, Math.round(247 * (500 / 150)));
  assert.ok(small.macros.calories < big.macros.calories);
  assert.equal(Math.round(small.macros.calories * (500 / 220)), big.macros.calories, 'proportional');
});

test('sums totals for mixed meals', async () => {
  const { sumNutrition } = await import('../src/services/intelligence/nutrition.js');
  const t = sumNutrition([
    { macros: { calories: 208, protein: 7, carbs: 36, fat: 2, fiber: 0, sugar: 0, sodium: 0 } },
    { macros: { calories: 206, protein: 4.4, carbs: 45, fat: 0.4, fiber: 0, sugar: 0, sodium: 0 } }
  ]);
  assert.equal(t.calories, 414);
  assert.equal(t.protein, 11.4);
});

// ---------- workout parsing ----------
test('parses workout set logs from natural language', async () => {
  const { parseWorkoutInput } = await import('../src/services/intelligence/parseWorkout.js');
  const a = parseWorkoutInput('Bench press 60kg 8 reps');
  assert.equal(a.ok, true);
  assert.equal(a.exercise.toLowerCase(), 'bench press');
  assert.equal(a.sets.length, 1);
  assert.deepEqual([a.sets[0].weight, a.sets[0].reps], [60, 8]);

  const b = parseWorkoutInput('Squat 100kg for 5');
  assert.equal(b.sets[0].weight, 100);
  assert.equal(b.sets[0].reps, 5);

  const c = parseWorkoutInput('Bench press 60x8, 65x6, 65x5');
  assert.equal(c.sets.length, 3);
  assert.deepEqual(c.sets.map((s) => s.weight), [60, 65, 65]);
  assert.deepEqual(c.sets.map((s) => s.reps), [8, 6, 5]);

  const d = parseWorkoutInput('3 sets of lat pulldown at 50kg for 10');
  assert.equal(d.sets.length, 3);
  assert.ok(d.sets.every((s) => s.weight === 50 && s.reps === 10));

  const bad = parseWorkoutInput('hello world');
  assert.equal(bad.ok, false);
});

// ---------- alias + intent search ----------
test('alias search resolves synonyms to canonical foods/exercises', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'c@x.in', 'x', 'C1', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, source, is_global) VALUES ('p1', NULL, NULL, 'Paneer', 'serving', '100 g', 265, 18, 4, 21, 'VERIFIED_DATABASE', 1)`);
  await db.run(`INSERT INTO food_aliases (id, org_id, food_id, alias) VALUES ('a1', NULL, 'p1', 'cottage cheese')`);

  const { resolveFood } = await import('../src/services/intelligence/foodSearch.js');
  const direct = await resolveFood(db, 'o1', 'c1', 'Paneer');
  assert.equal(direct.match.id, 'p1');
  const aliased = await resolveFood(db, 'o1', 'c1', 'cottage cheese');
  assert.equal(aliased.match.id, 'p1', 'alias resolves to the same food');

  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, secondary_muscles, equipment, movement, difficulty, is_global) VALUES ('ex1', NULL, 'Bench Press', 'CHEST', 'TRICEPS, FRONT DELTS', 'BARBELL', 'horizontal_push', 'INTERMEDIATE', 1)`);
  await db.run(`INSERT INTO exercise_aliases (id, org_id, exercise_id, alias) VALUES ('ea1', NULL, 'ex1', 'flat bench')`);
  const { searchExercisesByName } = await import('../src/services/intelligence/exerciseSearch.js');
  const byAlias = await searchExercisesByName(db, 'o1', 'flat bench');
  assert.equal(byAlias[0].id, 'ex1');
});

test('intent search handles plural equipment ("dumbbells") vs stored singular values', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, difficulty, is_global) VALUES ('ex1', NULL, 'Dumbbell Bench Press', 'CHEST', 'DUMBBELL', 'horizontal_push', 'BEGINNER', 1)`);
  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, difficulty, is_global) VALUES ('ex2', NULL, 'Cable Fly', 'CHEST', 'CABLE', 'horizontal_push', 'BEGINNER', 1)`);
  const { searchExercises } = await import('../src/services/intelligence/exerciseSearch.js');
  const hits = await searchExercises(db, 'o1', 'chest dumbbells');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'ex1', 'plural equipment query matches singular stored value');
});

test('tenant isolation: another gym\'s food/exercise never leaks into search', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'A', 'a', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o2', 'B', 'b', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'c@a.in', 'x', 'C1', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  // gym B's private food + exercise
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, calories, protein, carbs, fat, source, is_global) VALUES ('fB', 'o2', NULL, 'Gym B Secret Shake', 200, 10, 20, 5, 'USER_ENTERED', 0)`);
  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, difficulty, is_global) VALUES ('xB', 'o2', 'Gym B Secret Lift', 'CHEST', 'BARBELL', 'horizontal_push', 'BEGINNER', 0)`);

  const { resolveFood } = await import('../src/services/intelligence/foodSearch.js');
  const f = await resolveFood(db, 'o1', 'c1', 'gym b secret shake');
  assert.equal(f.match, null, 'other gym\'s food not resolvable');
  const { searchExercisesByName } = await import('../src/services/intelligence/exerciseSearch.js');
  const e = await searchExercisesByName(db, 'o1', 'gym b secret lift');
  assert.equal(e.length, 0, 'other gym\'s exercise not searchable');
});

// ---------- program generation ----------
test('program generation respects equipment and exclusion constraints from the real library', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym', '2026-01-01T00:00:00Z']);
  const exs = [
    ['e1', 'Dumbbell Bench Press', 'CHEST', 'DUMBBELL', 'horizontal_push'],
    ['e2', 'Barbell Bench Press', 'CHEST', 'BARBELL', 'horizontal_push'],
    ['e3', 'Barbell Back Squat', 'QUADS', 'BARBELL', 'squat'],
    ['e4', 'Dumbbell Lunge', 'QUADS', 'DUMBBELL', 'lunge'],
    ['e5', 'Lat Pulldown', 'LATS', 'CABLE', 'vertical_pull'],
    ['e6', 'Dumbbell Row', 'LATS', 'DUMBBELL', 'horizontal_pull'],
    ['e7', 'Push-up', 'CHEST', 'BODYWEIGHT', 'horizontal_push'],
    ['e8', 'Dumbbell Curl', 'BICEPS', 'DUMBBELL', 'isolation']
  ];
  for (const [id, name, muscle, eq, mv] of exs) {
    await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, difficulty, is_global) VALUES (?, NULL, ?, ?, ?, ?, 'BEGINNER', 1)`, [id, name, muscle, eq, mv]);
  }
  const { generateProgram } = await import('../src/services/intelligence/generateProgram.js');
  // dumbbells only + no barbell exercises
  const prog = await generateProgram(db, 'o1', { goal: 'hypertrophy', days: 3, equipment: ['dumbbells'], exclude: ['squat'] });
  assert.equal(prog.ok, true);
  assert.equal(prog.week.length, 3);
  assert.equal(prog.template, true, 'labeled as template');
  for (const day of prog.week) {
    assert.ok(day.exercises.length > 0, `day ${day.name} has exercises`);
    for (const ex of day.exercises) {
      assert.notEqual(ex.equipment.toUpperCase(), 'BARBELL', 'no barbell with dumbbell-only constraint');
      assert.notEqual(ex.name.toLowerCase(), 'cable', 'no cable-only exercises');
      assert.ok(!String(ex.name).toLowerCase().includes('squat'), 'no squat exercises when excluded');
      assert.ok(!String(ex.movement).includes('squat'), 'no squat movement when excluded');
    }
  }
});

// ---------- end-to-end parse → resolve → scale (integration-ish) ----------
test('full pipeline: "220g paneer" parses, resolves and scales correctly', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, source, is_global) VALUES ('p1', NULL, NULL, 'Paneer', 'serving', '100 g', 265, 18, 4, 21, 'VERIFIED_DATABASE', 1)`);
  const { parseFoodInput } = await import('../src/services/intelligence/parseFoods.js');
  const { resolveFood } = await import('../src/services/intelligence/foodSearch.js');
  const { computeNutrition, sumNutrition } = await import('../src/services/intelligence/nutrition.js');

  const parsed = parseFoodInput('220g paneer');
  const { match } = await resolveFood(db, 'o1', 'c1', parsed.items[0].name);
  assert.equal(match.name, 'Paneer');
  const n = computeNutrition(match, parsed.items[0]);
  assert.equal(n.macros.calories, 583);
  assert.equal(n.macros.protein, 39.6);
  assert.equal(n.provenance, 'VERIFIED_DATABASE');
  assert.equal(n.sourceScope, 'GLOBAL');
  const totals = sumNutrition([{ macros: n.macros }]);
  assert.equal(totals.calories, 583);
});
