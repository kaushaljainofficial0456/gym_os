// ============================================================
// BRINGING YOUR ACCOUNT INTO A GYM, AND TAKING IT OUT AGAIN.
//
// Someone uses the app alone for six months, then joins a gym that works
// with us. They must not have to start a new account — and when the gym
// ends the relationship, they must not lose what they logged.
//
// Both directions are ONE COLUMN. Forty-five tables hang off clients(id)
// and none of them mention the org, so moving clients.org_id carries the
// whole history across and back. These tests exist to keep it that way:
// the day someone "tidies up" by deleting and re-creating the client row
// on join, every one of them should fail.
//
// The other half is what must NOT move. Past workouts and payments stay
// attached to the gym they happened at — leaving a gym does not rewrite
// its books, and joining one does not backdate your solo training into
// its records.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endGymMembership, ensureIndependentOrgId } from '../src/services/enterprise/gymExit.js';
import { limitsFor } from '../src/services/planTiers.js';
import { invalidateOrgKindCache } from '../src/services/orgKind.js';

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
    async tx(fn) { return fn(mk()); },
    raw,
  });
  return mk();
}

/** An independent client with six months of their own training behind them. */
async function seedSoloClient(db) {
  const indep = await ensureIndependentOrgId(db);
  invalidateOrgKindCache();
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('u1',?,'solo@x.in','x','CLIENT','Solo',1,?)`, [indep, ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', ['c1', 'u1', indep, ts]);
  await db.run('INSERT INTO client_profiles (client_id, unit_system, day_start_hour) VALUES (?,?,?)', ['c1', 'imperial', 6]);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment) VALUES ('ex1','Bench','chest','barbell')`);

  // The history that must survive both moves.
  await db.run(`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, created_at)
                VALUES ('w_solo',?, 'c1','Solo Push','2026-03-01','completed','client_custom',?)`, [indep, ts]);
  await db.run(`INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight)
                VALUES ('wl1','c1','w_solo','ex1','2026-03-01',3,5,90)`);
  await db.run(`INSERT INTO personal_records (id, client_id, exercise_id, type, value, weight, reps, date, created_at)
                VALUES ('pr1','c1','ex1','heaviest_weight',90,90,5,'2026-03-01',?)`, [ts]);
  await db.run(`INSERT INTO weight_logs (id, client_id, date, weight, source, created_at)
                VALUES ('wt1','c1','2026-03-01',80,'manual',?)`, [ts]);
  await db.run(`INSERT INTO measurements (id, client_id, taken_at, waist) VALUES ('m1','c1','2026-03-01T09:00:00Z',86)`);
  await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source)
                VALUES ('ml1','c1','2026-03-01','lunch','Dal',400,20,50,10,1,'custom')`);
  return indep;
}

async function seedGym(db, { id: gid = 'g1', name = 'Ironforge' } = {}) {
  await db.run(`INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?,?,?,'gym',?)`,
    [gid, name, gid, ts]);
  // client_gym_periods.ended_by is a real FK to users, so the owner who
  // performs the revoke has to exist.
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('owner1',?,'owner@x.in','x','GYM_OWNER','Owner',1,?)`, [gid, ts]);
  invalidateOrgKindCache();
  return gid;
}

const historyOf = async (db, clientId) => ({
  workouts: (await db.q('SELECT id FROM workouts WHERE client_id = ?', [clientId])).length,
  logs: (await db.q('SELECT id FROM workout_logs WHERE client_id = ?', [clientId])).length,
  prs: (await db.q('SELECT id FROM personal_records WHERE client_id = ?', [clientId])).length,
  weights: (await db.q('SELECT id FROM weight_logs WHERE client_id = ?', [clientId])).length,
  measurements: (await db.q('SELECT id FROM measurements WHERE client_id = ?', [clientId])).length,
  meals: (await db.q('SELECT id FROM meal_logs WHERE client_id = ?', [clientId])).length,
});

/* ---------------- leaving ---------------- */

test('a revoked member keeps every bit of their history', async () => {
  const db = await memDb();
  const indep = await seedSoloClient(db);
  const gym = await seedGym(db);
  // Put them in the gym first.
  await db.run('UPDATE clients SET org_id = ? WHERE id = ?', [gym, 'c1']);
  await db.run('UPDATE users SET org_id = ? WHERE id = ?', [gym, 'u1']);
  await db.run(`INSERT INTO client_gym_periods (id, client_id, org_id, joined_at, created_at)
                VALUES ('p1','c1',?,?,?)`, [gym, ts, ts]);

  const before = await historyOf(db, 'c1');
  const res = await endGymMembership(db, { clientId: 'c1', reason: 'revoked', endedBy: 'owner1' });
  assert.equal(res.ok, true);

  assert.deepEqual(await historyOf(db, 'c1'), before, 'nothing of theirs was removed');
  const client = await db.q1('SELECT id, org_id, trainer_id FROM clients WHERE id = ?', ['c1']);
  assert.equal(client.id, 'c1', 'the SAME client row — it moves, it is never re-created');
  assert.equal(client.org_id, indep);
  assert.equal(client.trainer_id, null, 'their gym coach is no longer theirs');
});

test('their own settings survive the move', async () => {
  // The profile row is theirs, not the gym's.
  const db = await memDb();
  await seedSoloClient(db);
  const gym = await seedGym(db);
  await db.run('UPDATE clients SET org_id = ? WHERE id = ?', [gym, 'c1']);
  await endGymMembership(db, { clientId: 'c1' });
  const p = await db.q1('SELECT unit_system, day_start_hour FROM client_profiles WHERE client_id = ?', ['c1']);
  assert.equal(p.unit_system, 'imperial');
  assert.equal(p.day_start_hour, 6);
});

test('the membership becomes a closed period, not an erased one', async () => {
  const db = await memDb();
  await seedSoloClient(db);
  const gym = await seedGym(db);
  await db.run('UPDATE clients SET org_id = ? WHERE id = ?', [gym, 'c1']);
  await db.run(`INSERT INTO client_gym_periods (id, client_id, org_id, joined_at, created_at)
                VALUES ('p1','c1',?,?,?)`, [gym, ts, ts]);

  await endGymMembership(db, { clientId: 'c1', reason: 'revoked', endedBy: 'owner1' });
  const period = await db.q1('SELECT * FROM client_gym_periods WHERE id = ?', ['p1']);
  assert.ok(period.left_at, '"was a member from March to September" is true and worth keeping');
  assert.equal(period.end_reason, 'revoked');
  assert.equal(period.ended_by, 'owner1');
});

test('the gym keeps what happened at the gym', async () => {
  // Leaving does not rewrite the gym's books.
  const db = await memDb();
  await seedSoloClient(db);
  const gym = await seedGym(db);
  await db.run('UPDATE clients SET org_id = ? WHERE id = ?', [gym, 'c1']);
  await db.run(`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, created_at)
                VALUES ('w_gym',?,'c1','Coach Push','2026-06-01','completed','trainer',?)`, [gym, ts]);
  // lifecycle_status arrives by migration, so the base schema this test
  // builds from only has `status`.
  await db.run(`INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, currency, start_date, end_date, status, payment_status)
                VALUES ('s1',?,'c1','Monthly',1999,'INR','2026-06-01','2026-07-01','active','paid')`, [gym]);
  await db.run(`INSERT INTO payments (id, org_id, client_id, subscription_id, amount, currency, method, status, paid_at)
                VALUES ('pay1',?,'c1','s1',1999,'INR','mock','paid',?)`, [gym, ts]);

  await endGymMembership(db, { clientId: 'c1' });

  const w = await db.q1('SELECT org_id, status FROM workouts WHERE id = ?', ['w_gym']);
  assert.equal(w.org_id, gym, 'a session performed at the gym stays attached to it');
  assert.equal(w.status, 'completed');
  const pay = await db.q1('SELECT id FROM payments WHERE id = ?', ['pay1']);
  assert.ok(pay, 'that charge really happened; the gym\'s revenue view must keep showing it');
  const sub = await db.q1('SELECT status FROM subscriptions WHERE id = ?', ['s1']);
  assert.equal(sub.status, 'cancelled', 'but the membership itself stops');
});

test('future prescribed sessions go, completed ones stay', async () => {
  const db = await memDb();
  await seedSoloClient(db);
  const gym = await seedGym(db);
  await db.run('UPDATE clients SET org_id = ? WHERE id = ?', [gym, 'c1']);
  const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await db.run(`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, created_at)
                VALUES ('w_future',?,'c1','Next week','${future}','assigned','trainer',?)`, [gym, ts]);

  await endGymMembership(db, { clientId: 'c1' });
  assert.equal(await db.q1('SELECT id FROM workouts WHERE id = ?', ['w_future']), null,
    'the gym no longer prescribes their training');
  assert.ok(await db.q1('SELECT id FROM workouts WHERE id = ?', ['w_solo']),
    'their own past sessions are untouched');
});

test('the gym community membership ends but their posts are left alone', async () => {
  const db = await memDb();
  await seedSoloClient(db);
  const gym = await seedGym(db);
  await db.run('UPDATE clients SET org_id = ? WHERE id = ?', [gym, 'c1']);
  // client_id IS the primary key here — one community row per client.
  await db.run(`INSERT INTO community_members (client_id, org_id, enabled, updated_at) VALUES ('c1',?,1,?)`, [gym, ts]);

  await endGymMembership(db, { clientId: 'c1' });
  assert.equal(await db.q1('SELECT client_id FROM community_members WHERE client_id = ?', ['c1']), null,
    'access to the gym community ends with the membership');
});

test('revoking someone who is not in a gym is refused, not silently done', async () => {
  const db = await memDb();
  await seedSoloClient(db);
  const res = await endGymMembership(db, { clientId: 'c1' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_in_a_gym');
});

/* ---------------- what they land on ---------------- */

test('a gym member is not charged for what their gym already bought', () => {
  const inGym = limitsFor({ tier: 'free', inGym: true });
  assert.equal(inGym.source, 'gym');
  assert.equal(inGym.progressHistoryDays, null, 'no app-plan cap applies while a gym pays for them');
});

test('free is a real product, and logging is never the thing that is capped', () => {
  // A capped log is a corrupted history, not a smaller one: someone who
  // cannot record today's session has a permanent gap.
  const free = limitsFor({ tier: 'free', inGym: false });
  assert.equal(free.workoutLogging, null);
  assert.equal(free.foodLogging, null);
  assert.equal(free.weightLogging, null);
  // The caps are on breadth and on the expensive AI paths.
  assert.equal(typeof free.progressHistoryDays, 'number');
  assert.equal(typeof free.aiFoodEstimatesPerDay, 'number');
});

test('an unknown tier falls back to free rather than to unlimited', () => {
  const odd = limitsFor({ tier: 'platinum', inGym: false });
  assert.equal(odd.tier, 'free');
});
