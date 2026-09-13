// ============================================================
// NET ENERGY BALANCE — the number a cut or a bulk is actually run on.
//
// Two properties matter more than the arithmetic here.
//
// One: an incomplete profile must produce NOTHING, not "intake minus the
// parts we happen to have". A user with no height would otherwise be
// shown an enormous surplus every single day by a feature that looks
// like it is working perfectly.
//
// Two: the components must not overlap. Resting energy is counted for
// the whole day, and a MET-derived cardio figure is GROSS — it contains
// the resting energy of that same hour inside it. Add them naively and
// every cardio session quietly inflates the burn.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeBalance, missingForBmr, balanceRange } from '../src/services/energyBalance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

// A 70 kg / 175 cm / 30 y male: Mifflin-St Jeor = 10*70 + 6.25*175 - 5*30 + 5 = 1653.75
const BMR = 1653.75;
const FULL_DAY = 86400;

test('a surplus is positive and a deficit is negative', async () => {
  // The direction has to be unambiguous, because every label downstream
  // ("net surplus" / "net deficit") is derived from the sign alone.
  const over = composeBalance({
    dateKey: '2026-03-01', bmrPerDay: BMR, elapsedSeconds: FULL_DAY,
    intakeKcal: 2800, workoutKcal: 0, cardio: [],
  });
  assert.equal(over.burn.totalKcal, 1654);
  assert.equal(over.netKcal, 2800 - 1654, 'ate more than burned -> surplus');
  assert.ok(over.netKcal > 0);

  const under = composeBalance({
    dateKey: '2026-03-01', bmrPerDay: BMR, elapsedSeconds: FULL_DAY,
    intakeKcal: 1200, workoutKcal: 0, cardio: [],
  });
  assert.ok(under.netKcal < 0, 'ate less than burned -> deficit');
});

test('an incomplete profile yields null, never a half-computed figure', async () => {
  // THE failure mode of this feature. Reporting intake minus only the
  // components we have would show a ~2,800 kcal surplus to anyone who
  // never entered their height, and look entirely functional doing it.
  const r = composeBalance({
    dateKey: '2026-03-01', bmrPerDay: null, elapsedSeconds: FULL_DAY,
    intakeKcal: 2800, workoutKcal: 500, cardio: [{ kcal: 300, duration_sec: 1800 }],
  });
  assert.equal(r.burn.restingKcal, null);
  assert.equal(r.burn.totalKcal, null);
  assert.equal(r.netKcal, null, 'no BMR means no answer at all');
  assert.equal(r.intakeKcal, 2800, 'what we DO know is still reported');
});

test('cardio is added net of the resting energy a MET figure already counts', async () => {
  // A 45 min bout logged at 386 kcal gross. Resting for those 45 min at
  // this BMR is 1653.75/86400*2700 = 51.7 kcal, already inside the 386.
  const mins = 45;
  const bout = { kcal: 386, duration_sec: mins * 60 };
  const restingShare = (BMR / 86400) * bout.duration_sec;

  const r = composeBalance({
    dateKey: '2026-03-01', bmrPerDay: BMR, elapsedSeconds: FULL_DAY,
    intakeKcal: 0, workoutKcal: 0, cardio: [bout],
  });

  assert.equal(r.burn.cardioKcal, Math.round(386 - restingShare));
  assert.ok(r.burn.cardioKcal < 386, 'the gross figure is not used as-is');
  // And the total is resting + that remainder, with no hour counted twice.
  assert.equal(r.burn.totalKcal, Math.round(BMR + (386 - restingShare)));
});

test('a workout figure is already active energy and is added whole', async () => {
  // workouts.estimated_active_kcal is defined by the schema as energy
  // ABOVE resting, so correcting it the way cardio is corrected would
  // under-count every logged session.
  const r = composeBalance({
    dateKey: '2026-03-01', bmrPerDay: BMR, elapsedSeconds: FULL_DAY,
    intakeKcal: 0, workoutKcal: 400, cardio: [],
  });
  assert.equal(r.burn.workoutKcal, 400);
  assert.equal(r.burn.totalKcal, Math.round(BMR + 400));
});

test("today's resting burn is prorated, not a full 24 hours at 9am", async () => {
  // Otherwise the app reports a deficit nobody has earned yet, and reads
  // as a lie every morning.
  const fiveHours = 5 * 3600;
  const r = composeBalance({
    dateKey: '2026-03-01', bmrPerDay: BMR, elapsedSeconds: fiveHours,
    intakeKcal: 0, workoutKcal: 0, cardio: [],
  });
  assert.equal(r.burn.restingKcal, Math.round(BMR * (fiveHours / 86400)));
  assert.equal(r.partialDay, true);
  assert.ok(r.burn.restingKcal < BMR / 4 + 1);
});

test('a cardio bout longer than its own gross figure cannot go negative', async () => {
  // A mis-entered kcal (or a very long, very easy bout) must not SUBTRACT
  // from the day's burn.
  const r = composeBalance({
    dateKey: '2026-03-01', bmrPerDay: BMR, elapsedSeconds: FULL_DAY,
    intakeKcal: 0, workoutKcal: 0, cardio: [{ kcal: 5, duration_sec: 4 * 3600 }],
  });
  assert.equal(r.burn.cardioKcal, 0);
  assert.equal(r.burn.totalKcal, Math.round(BMR));
});

test('missingForBmr names the field to ask for', async () => {
  assert.deepEqual(missingForBmr({ current_weight: 70, height_cm: 175, age: 30, sex: 'MALE' }), []);
  assert.deepEqual(missingForBmr({ current_weight: 70, age: 30, sex: 'MALE' }), ['height']);
  assert.deepEqual(missingForBmr({ current_weight: 70, height_cm: 175, age: 30 }), ['sex']);
  assert.deepEqual(missingForBmr({}), ['weight', 'height', 'age', 'sex']);
  // A zero is not a measurement.
  assert.ok(missingForBmr({ current_weight: 0, height_cm: 175, age: 30, sex: 'MALE' }).includes('weight'));
});

// ---------------------------------------------------------------
// Against a real database, so the queries are exercised too.
// ---------------------------------------------------------------
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

async function seed(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run("INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1','o1','a@x.in','x','CLIENT','C',1,?)", [ts]);
  await db.run(
    'INSERT INTO clients (id, user_id, org_id, current_weight, height_cm, age, sex, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ['c1', 'u1', 'o1', 70, 175, 30, 'MALE', ts]);
  return db.q1('SELECT * FROM clients WHERE id = ?', ['c1']);
}

test('every day in the range comes back, including the empty ones', async () => {
  // A gap in a cut IS information. A chart that closes up over untracked
  // days draws a continuous line through a week that never happened.
  const db = await memDb();
  const client = await seed(db);
  const { days } = await balanceRange(db, client, { fromKey: '2026-03-01', toKey: '2026-03-05', now: new Date('2026-04-01T00:00:00Z') });
  assert.equal(days.length, 5);
  assert.deepEqual(days.map((d) => d.date), ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
  assert.equal(days[0].intakeKcal, 0);
});

test('only food marked eaten counts toward intake', async () => {
  // A planned meal you did not eat is not a surplus.
  const db = await memDb();
  const client = await seed(db);
  await db.run("INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten) VALUES ('m1','c1','2026-03-02','Eaten',600,10,10,10,1)");
  await db.run("INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten) VALUES ('m2','c1','2026-03-02','Planned',900,10,10,10,0)");

  const { days } = await balanceRange(db, client, { fromKey: '2026-03-02', toKey: '2026-03-02', now: new Date('2026-04-01T00:00:00Z') });
  assert.equal(days[0].intakeKcal, 600);
});

test('an unfinished workout burns nothing', async () => {
  const db = await memDb();
  const client = await seed(db);
  await db.run(
    "INSERT INTO workouts (id, client_id, org_id, name, status, completed_at, estimated_active_kcal, created_at) VALUES ('w1','c1','o1','Push','completed','2026-03-02T10:00:00Z',400,?)", [ts]);
  await db.run(
    "INSERT INTO workouts (id, client_id, org_id, name, status, completed_at, estimated_active_kcal, created_at) VALUES ('w2','c1','o1','Pull','assigned',NULL,999,?)", [ts]);

  const { days } = await balanceRange(db, client, { fromKey: '2026-03-02', toKey: '2026-03-02', now: new Date('2026-04-01T00:00:00Z') });
  assert.equal(days[0].burn.workoutKcal, 400, 'the open session is not counted');
});

test('a client with no profile figures gets nulls, not numbers', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o2', 'G2', 'g2', ts]);
  await db.run("INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u2','o2','b@x.in','x','CLIENT','C',1,?)", [ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', ['c2', 'u2', 'o2', ts]);
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', ['c2']);
  await db.run("INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten) VALUES ('m9','c2','2026-03-02','Lunch',2800,10,10,10,1)");

  const { days, missing } = await balanceRange(db, client, { fromKey: '2026-03-02', toKey: '2026-03-02', now: new Date('2026-04-01T00:00:00Z') });
  assert.equal(days[0].netKcal, null, 'a 2,800 kcal "surplus" must not be invented here');
  assert.equal(days[0].intakeKcal, 2800);
  assert.deepEqual(missing.sort(), ['age', 'height', 'sex', 'weight']);
});
