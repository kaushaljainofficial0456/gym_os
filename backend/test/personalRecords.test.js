// ============================================================
// PERSONAL RECORDS — regression tests.
//
// Covers a real, live-reproduced bug: evaluatePRs() gated its
// history-baseline lookup on `existing.length === 0` (ANY personal_records
// row existing for the exercise, across ALL 4 types combined), rather than
// per-type. Once one type (e.g. best_reps) earned its first row, every
// OTHER type that still had none (e.g. heaviest_weight) silently stopped
// consulting real workout_logs history — so a session below the client's
// true historical best could be announced as a "New Personal Record".
//
// Reproduced live against the seeded dev DB: a client with a genuine
// historical deadlift best of 85kg got a false "Heaviest weight: 70kg"
// PR notification on their second-ever evaluation of that exercise, purely
// because their FIRST evaluation had already inserted best_reps/
// best_volume rows (which that first, lower-weight session legitimately
// beat) without inserting a heaviest_weight row (which it did not beat).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePRs, computePRCandidates } from '../src/services/personalRecords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
  });
  return mk();
}

const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

/** Minimal fixture: one org, one client, one exercise. */
async function seedClient(db) {
  const orgId = rid('org'), userId = rid('usr'), clientId = rid('cli'), exId = rid('exl');
  await db.run(`INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?,?,?,?,?)`,
    [orgId, 'Test Gym', rid('slug'), 'gym', new Date().toISOString()]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,?,?,1,?)`,
    [userId, orgId, `${rid('u')}@test.com`, 'x', 'CLIENT', 'Test Client', new Date().toISOString()]);
  await db.run(`INSERT INTO clients (id, user_id, org_id, status, created_at) VALUES (?,?,?, 'ON_TRACK', ?)`,
    [clientId, userId, orgId, new Date().toISOString()]);
  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement) VALUES (?,NULL,?,?,?,?)`,
    [exId, 'Deadlift', 'back', 'barbell', 'hinge']);
  return { orgId, clientId, exId };
}

/** Legacy aggregate log row — what historyBaseline() reads. */
async function seedLegacyHistory(db, clientId, exId, date, weight, reps) {
  // workout_id left NULL: historyBaseline() only filters on client_id/
  // exercise_id/date, and a random id here would fail the FK constraint
  // against a `workouts` row this fixture never creates.
  await db.run(
    `INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight)
     VALUES (?,?,NULL,?,?,?,?,?)`,
    [rid('wlg'), clientId, exId, date, 3, reps, weight]);
}

const sets = (weight, reps, n = 3) =>
  Array.from({ length: n }, () => ({ actual_weight: weight, actual_reps: reps, completed: true }));

test('computePRCandidates: ignores incomplete sets and sets with no weight/reps', () => {
  const c = computePRCandidates([
    { actual_weight: 100, actual_reps: 5, completed: false },  // skipped -- must not count
    { actual_weight: 0, actual_reps: 5, completed: true },     // no weight -- must not count
    { actual_weight: 80, actual_reps: 6, completed: true },
  ]);
  assert.equal(c.heaviest_weight.value, 80);
  assert.equal(c.heaviest_weight.reps, 6);
});

test('computePRCandidates: returns null when nothing qualifies', () => {
  assert.equal(computePRCandidates([{ actual_weight: 0, actual_reps: 0, completed: true }]), null);
  assert.equal(computePRCandidates([]), null);
});

test('REGRESSION: a type with no row of its own still consults history, even after a DIFFERENT type already has a row', async () => {
  const db = await memDb();
  const { clientId, exId } = await seedClient(db);
  // True historical best: 85kg. Never entered personal_records (legacy data).
  await seedLegacyHistory(db, clientId, exId, '2026-08-03', 85, 5);
  await seedLegacyHistory(db, clientId, exId, '2026-08-04', 85, 5);

  // Session 1: 60kg x8. Beats best_reps/best_volume (which have no prior
  // measured personal_records row, so 5 reps / 425 volume from the legacy
  // baseline is what it's compared against) but NOT heaviest_weight (85).
  const r1 = await evaluatePRs(db, clientId, exId, sets(60, 8), '2026-09-01');
  const types1 = r1.map((p) => p.type).sort();
  assert.deepEqual(types1, ['best_reps', 'best_volume']);
  assert.equal(r1.find((p) => p.type === 'best_reps').previous, 5);

  // Session 2: 70kg x5 -- STILL BELOW the true 85kg best. Before the fix,
  // this falsely reported a new heaviest_weight PR (previous: null) because
  // best_reps/best_volume already had rows from session 1, so
  // `existing.length === 0` was false and the history lookup was skipped
  // entirely -- for heaviest_weight/est_1rm too, even though THEY still had
  // no row and no real baseline to compare against.
  const r2 = await evaluatePRs(db, clientId, exId, sets(70, 5), '2026-09-05');
  assert.deepEqual(r2, [], `session 2 (70kg) must not beat the true 85kg history: ${JSON.stringify(r2)}`);

  // Sanity: a genuine new high (90kg) still correctly registers, and reports
  // the TRUE previous best (85), not a stale/null value.
  const r3 = await evaluatePRs(db, clientId, exId, sets(90, 3), '2026-09-10');
  const hw = r3.find((p) => p.type === 'heaviest_weight');
  assert.ok(hw, 'a genuine new high must still register');
  assert.equal(hw.value, 90);
  assert.equal(hw.previous, 85);
});

test('a lower weight in a LATER session never overwrites an already-recorded PR', async () => {
  const db = await memDb();
  const { clientId, exId } = await seedClient(db);
  const r1 = await evaluatePRs(db, clientId, exId, sets(70, 5), '2026-09-01');
  assert.ok(r1.some((p) => p.type === 'heaviest_weight' && p.value === 70));

  const r2 = await evaluatePRs(db, clientId, exId, sets(65, 10), '2026-09-05');
  assert.ok(!r2.some((p) => p.type === 'heaviest_weight'), 'a lower weight must not overwrite the recorded PR');

  const rows = await db.q('SELECT value FROM personal_records WHERE client_id=? AND exercise_id=? AND type=?', [clientId, exId, 'heaviest_weight']);
  assert.equal(rows[0].value, 70, 'the stored PR must still be the higher value');
});

test('exercise isolation: a PR on one exercise does not affect a different exercise for the same client', async () => {
  const db = await memDb();
  const { clientId, exId: deadliftId } = await seedClient(db);
  const benchId = rid('exl');
  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement) VALUES (?,NULL,?,?,?,?)`,
    [benchId, 'Bench Press', 'chest', 'barbell', 'horizontal_push']);

  await evaluatePRs(db, clientId, deadliftId, sets(140, 3), '2026-09-01');
  // A much lighter bench session must still register as ITS OWN first PR --
  // unaffected by deadlift's 140kg.
  const benchPrs = await evaluatePRs(db, clientId, benchId, sets(60, 5), '2026-09-01');
  assert.ok(benchPrs.some((p) => p.type === 'heaviest_weight' && p.value === 60));

  const deadliftRows = await db.q('SELECT type FROM personal_records WHERE client_id=? AND exercise_id=?', [clientId, deadliftId]);
  const benchRows = await db.q('SELECT type FROM personal_records WHERE client_id=? AND exercise_id=?', [clientId, benchId]);
  assert.ok(deadliftRows.length > 0 && benchRows.length > 0);
});

test('client isolation: two clients evaluating the same exercise never share PR state', async () => {
  const db = await memDb();
  const { clientId: clientA, exId } = await seedClient(db);
  const { clientId: clientB } = await seedClient(db);

  await evaluatePRs(db, clientA, exId, sets(150, 2), '2026-09-01');
  const bResult = await evaluatePRs(db, clientB, exId, sets(40, 8), '2026-09-01');
  assert.ok(bResult.some((p) => p.type === 'heaviest_weight' && p.value === 40),
    "client B's 40kg must register as a first PR, unaffected by client A's 150kg");

  // client B's heaviest single lift was 40kg -- if isolation were broken and
  // client A's 150kg session leaked in, this would read 150.
  const bHeaviest = await db.q1('SELECT value FROM personal_records WHERE client_id=? AND exercise_id=? AND type=?', [clientB, exId, 'heaviest_weight']);
  assert.equal(bHeaviest.value, 40, "client B's heaviest_weight must be their own 40kg, not client A's 150kg");
});
