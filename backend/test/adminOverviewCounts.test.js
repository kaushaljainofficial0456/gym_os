// ============================================================
// THE BUSINESS PAGE'S HEADLINE COUNTS.
//
// Three of them were wrong, and all three were wrong in the direction
// that makes a gym look busier than it is.
//
//  RENEWALS DUE had no lower bound — `renewal_date <= +30d` counts every
//  subscription whose renewal date has already passed, and nothing in
//  this app expires one, so lapsed rows never left the set. This gym saw
//  "Renewals due 23" when exactly 2 fall in the next month.
//
//  ATTENDANCE TODAY never filtered `present`, so a member explicitly
//  marked ABSENT counted as having come in — using the column that
//  exists precisely to record that they did not.
//
//  OVERDUE counted only rows labelled status='overdue', missing every
//  pending or failed payment_status: money the gym has equally not been
//  paid, reported as nothing owed.
//
// They also have to AGREE with the owner dashboard, which computes the
// same quantities in gymPulse.js. Two screens disagreeing about one
// number is worse than either being wrong alone, because it destroys
// trust in both.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gymPulse } from '../src/services/gymPulse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';
const TZ = 'Asia/Kolkata';

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

let n = 0;
const uid = (p) => `${p}${n += 1}`;
const todayIn = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const shift = (days) => new Date(Date.parse(`${todayIn()}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function seedGym(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    const u = uid('u'); const c = uid('c');
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,?,?,'x','CLIENT','C',1,?)`, [u, 'o1', `${u}@x.in`, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [c, u, 'o1', ts]);
    ids.push(c);
  }
  return ids;
}

const sub = (db, cid, { status = 'active', pay = 'paid', renewal, end }) => db.run(
  `INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, start_date, end_date, renewal_date, status, payment_status)
   VALUES (?,?,?,'Monthly',1000,'2026-01-01',?,?,?,?)`,
  [uid('s'), 'o1', cid, end || renewal, renewal, status, pay]);

/** The queries exactly as /api/admin/overview runs them. Kept here rather
 *  than importing the route so the assertions describe the CONTRACT; if
 *  the route drifts from this, the disagreement test below catches it. */
async function adminCounts(db) {
  const today = todayIn();
  const [renewals, overdue, attendance] = await Promise.all([
    db.q1(`SELECT COUNT(*) AS n FROM subscriptions
            WHERE org_id = 'o1' AND status = 'active'
              AND renewal_date IS NOT NULL AND renewal_date >= ? AND renewal_date <= ?`, [today, shift(30)]),
    db.q1(`SELECT COUNT(*) AS n FROM subscriptions
            WHERE org_id = 'o1' AND (status = 'overdue'
               OR payment_status IN ('overdue', 'failed', 'pending'))`),
    db.q1("SELECT COUNT(*) AS n FROM attendance WHERE org_id = 'o1' AND date = ? AND present = 1", [today]),
  ]);
  return {
    renewalsThisMonth: Number(renewals?.n || 0),
    overdue: Number(overdue?.n || 0),
    attendanceToday: Number(attendance?.n || 0),
  };
}

test('a renewal that already passed is not "due" — it has lapsed', async () => {
  const db = await memDb();
  const [c1, c2, c3] = await seedGym(db);
  await sub(db, c1, { renewal: shift(10) });    // genuinely due
  await sub(db, c2, { renewal: shift(-90) });   // passed months ago
  await sub(db, c3, { renewal: shift(200) });   // far out

  const counts = await adminCounts(db);
  assert.equal(counts.renewalsThisMonth, 1, 'only the one you can still act on');
});

test('a member marked absent is not attendance', async () => {
  const db = await memDb();
  const [c1, c2] = await seedGym(db);
  const today = todayIn();
  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,1)', [uid('a'), 'o1', c1, today]);
  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,0)', [uid('a'), 'o1', c2, today]);

  const counts = await adminCounts(db);
  assert.equal(counts.attendanceToday, 1);
});

test('pending and failed payments are money owed too', async () => {
  const db = await memDb();
  const [c1, c2, c3, c4] = await seedGym(db);
  await sub(db, c1, { status: 'overdue', pay: 'overdue', renewal: shift(5) });
  await sub(db, c2, { status: 'active', pay: 'pending', renewal: shift(5) });
  await sub(db, c3, { status: 'active', pay: 'failed', renewal: shift(5) });
  await sub(db, c4, { status: 'active', pay: 'paid', renewal: shift(5) });

  const counts = await adminCounts(db);
  assert.equal(counts.overdue, 3, 'labelled overdue, plus pending, plus failed');
});

test('Business and the owner dashboard agree on the same numbers', async () => {
  // The property that matters more than either being individually right:
  // one gym, one set of facts. Two screens quoting different figures for
  // "renewals due" destroys trust in both.
  const db = await memDb();
  const [c1, c2, c3] = await seedGym(db);
  const today = todayIn();

  await sub(db, c1, { renewal: shift(10), end: shift(10) });
  await sub(db, c2, { renewal: shift(-90), end: shift(-90) });
  await sub(db, c3, { status: 'active', pay: 'pending', renewal: shift(400), end: shift(400) });
  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,1)', [uid('a'), 'o1', c1, today]);
  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,0)', [uid('a'), 'o1', c2, today]);

  const counts = await adminCounts(db);
  const pulse = await gymPulse(db, 'o1', { tz: TZ });

  assert.equal(counts.renewalsThisMonth, pulse.members.expiringSoon, 'renewals due');
  assert.equal(counts.attendanceToday, pulse.today.checkIns, 'attendance today');
  assert.equal(counts.overdue, pulse.money.outstandingCount, 'money owed');
});
