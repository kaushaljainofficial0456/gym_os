// ============================================================
// ADHERENCE SCORE — the composite must survive an unmeasurable input.
//
// Found live: a client's profile ring rendered a bare "%" with no number.
// The cause was not in the UI. computeAdherence() divided by
// `meals.length * days` with no guard, so a nutrition plan carrying ZERO
// meals produced 0/0 = NaN for the nutrition component.
//
// NaN then escaped its own component. The weighted loop tested
// `components[key] !== null`, which NaN passes, so NaN * weight poisoned
// the running total and the FINAL score became NaN. JSON.stringify writes
// NaN as `null`, so every consumer received a null score and no error:
// the client's ring, the trainer dashboard, the clients list, weekly
// reports and the risk evaluation all silently lost the number while the
// individual components still looked fine in the same payload -- which is
// exactly why it survived so long.
//
// Two things are therefore tested: the divisor that caused it, and the
// guard that makes the whole class impossible.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAdherence } from '../src/services/adherence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = raw.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    raw,
  });
  return mk();
}

async function seedClient(db, { withPlan = false, planMeals = 0, withWorkouts = false } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('u1','o1','c@a.in','x','CLIENT','Client',1,?)`, [ts]);
  await db.run(`INSERT INTO clients (id, user_id, org_id, created_at) VALUES ('c1','u1','o1',?)`, [ts]);
  // nutrition_plans.trainer_id is NOT NULL with a real FK, so a plan
  // needs an actual trainer to hang off.
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('t1','o1','t@a.in','x','TRAINER','Coach',1,?)`, [ts]);

  if (withPlan) {
    await db.run(`INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, created_at)
                  VALUES ('np1','o1','t1','c1','Plan',2000,150,200,60,?)`, [ts]);
    for (let i = 0; i < planMeals; i++) {
      await db.run(`INSERT INTO meals (id, plan_id, slot, name, time, calories, protein, carbs, fat, position)
                    VALUES (?,'np1',?,?,?,500,40,50,15,?)`,
        [`m${i}`, ['breakfast', 'lunch', 'dinner'][i % 3], `Meal ${i}`, '09:00', i]);
    }
  }
  if (withWorkouts) {
    const today = new Date().toISOString().slice(0, 10);
    await db.run(`INSERT INTO workouts (id, org_id, client_id, name, status, scheduled_date, created_at)
                  VALUES ('w1','o1','c1','Push','completed',?,?)`, [today, ts]);
    await db.run(`INSERT INTO workouts (id, org_id, client_id, name, status, scheduled_date, created_at)
                  VALUES ('w2','o1','c1','Pull','assigned',?,?)`, [today, ts]);
  }
}

test('a nutrition plan with no meals does not turn the whole score into NaN', async (t) => {
  const db = await memDb();
  await seedClient(db, { withPlan: true, planMeals: 0, withWorkouts: true });

  const a = await computeAdherence(db, 'c1');

  // The bug: 0/0 nutrition -> NaN -> NaN*weight -> the entire score NaN,
  // which serialises to null and shows as a bare "%" in the UI.
  assert.ok(Number.isFinite(a.score),
    `score must be a real number, got ${a.score} (NaN serialises to null and reads as "no data")`);
  assert.equal(a.components.nutrition, null,
    'an empty plan makes nutrition UNMEASURABLE, which is null -- not 0, and not NaN');
  assert.ok(a.score > 0, 'and the components that ARE measurable still contribute');
});

test('an unmeasurable component is skipped, not multiplied into the total', async (t) => {
  const db = await memDb();
  await seedClient(db, { withPlan: true, planMeals: 0, withWorkouts: true });

  const a = await computeAdherence(db, 'c1');

  // The guard was `!== null`, which lets NaN, undefined and Infinity
  // through. Nothing non-finite may appear in the weighted breakdown.
  for (const [key, entry] of Object.entries(a.applicableWeights)) {
    assert.ok(Number.isFinite(entry.value),
      `${key} is in the weighted total with a non-finite value (${entry.value})`);
  }
  assert.ok(!('nutrition' in a.applicableWeights),
    'an unmeasurable component carries no weight at all');
});

test('a plan WITH meals still scores nutrition normally', async (t) => {
  const db = await memDb();
  await seedClient(db, { withPlan: true, planMeals: 3, withWorkouts: true });

  const a = await computeAdherence(db, 'c1');
  assert.ok(Number.isFinite(a.score));
  assert.ok(Number.isFinite(a.components.nutrition),
    'with meals to measure against, nutrition is a real percentage');
  assert.ok(a.components.nutrition >= 0 && a.components.nutrition <= 100);
});

test('a client with no data still scores from what IS measurable, and never NaN', async (t) => {
  const db = await memDb();
  await seedClient(db, { withPlan: false, withWorkouts: false });

  const a = await computeAdherence(db, 'c1');

  /* Note what is actually true here rather than what is tidy to assert:
     water carries a DEFAULT target (3L), so it is always measurable and
     a client who logged none scores 0 on it -- which is a real finding
     about them, not missing data. So the score is a genuine number, not
     null. The null branch exists for the case where no component at all
     applies; it is close to unreachable precisely because of that water
     default, and pretending otherwise in a test would be asserting a
     fiction. What matters is that it is finite. */
  assert.ok(Number.isFinite(a.score), `expected a real score, got ${a.score}`);
  assert.equal(a.components.nutrition, null, 'no plan means nutrition is unmeasurable');
  assert.ok(Number.isFinite(a.components.water), 'water has a default target, so it is measurable');
});

test('every component is either a real percentage or null -- never NaN', async (t) => {
  const db = await memDb();
  await seedClient(db, { withPlan: true, planMeals: 0, withWorkouts: true });

  const a = await computeAdherence(db, 'c1');
  for (const [key, value] of Object.entries(a.components)) {
    assert.ok(value === null || Number.isFinite(value),
      `component ${key} is ${value}; components must be a number or null so consumers can branch on absence`);
  }
});
