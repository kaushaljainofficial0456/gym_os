// ============================================================
// GYM PULSE — "how is my gym doing today?"
//
// The owner dashboard could answer that for CLIENTS (adherence, at-risk)
// and for nothing else: not who came in, not what was owed, not whether
// the trainers turned up. These tests hold the parts that are easy to
// get subtly wrong and impossible to notice from a screenshot.
//
// The one that matters most: OUTSTANDING MONEY IS A SUBSCRIPTION STATE,
// NOT A PAYMENT STATE. An unpaid membership has no payments row at all,
// so counting unpaid payments reports zero owed however many members are
// behind — a dashboard confidently showing "₹0 outstanding" to a gym
// that is owed a lakh.
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

async function gym(db, orgId = 'o1') {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', [orgId, 'Gym', orgId, ts]);
  return orgId;
}

async function client(db, orgId, { createdAt = ts } = {}) {
  const u = uid('u'); const c = uid('c');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES (?,?,?,'x','CLIENT','C',1,?)`, [u, orgId, `${u}@x.in`, createdAt]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [c, u, orgId, createdAt]);
  return c;
}

async function trainer(db, orgId) {
  const u = uid('t');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES (?,?,?,'x','TRAINER','T',1,?)`, [u, orgId, `${u}@x.in`, ts]);
  await db.run('INSERT INTO trainers (user_id, org_id) VALUES (?,?)', [u, orgId]);
  return u;
}

const todayIn = (tz = TZ) => new Date().toLocaleDateString('en-CA', { timeZone: tz });
const dayBefore = (k, back) => new Date(Date.parse(`${k}T00:00:00Z`) - back * 86400000).toISOString().slice(0, 10);

test("today's check-ins count only today, and only people who came", async () => {
  const db = await memDb();
  const o = await gym(db);
  const c1 = await client(db, o); const c2 = await client(db, o); const c3 = await client(db, o);
  const today = todayIn();

  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,1)', [uid('a'), o, c1, today]);
  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,1)', [uid('a'), o, c2, today]);
  // marked absent — a record of NOT coming is not a check-in
  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,0)', [uid('a'), o, c3, today]);
  // yesterday
  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,1)', [uid('a'), o, c3, dayBefore(today, 1)]);

  const p = await gymPulse(db, o, { tz: TZ });
  assert.equal(p.today.checkIns, 2);
});

test('outstanding money comes from subscriptions, not from payments', async () => {
  // THE bug this guards. An unpaid membership writes no payments row, so
  // a payments-based query would report nothing owed while two members
  // are overdue — and the dashboard would look fine saying it.
  const db = await memDb();
  const o = await gym(db);
  const c1 = await client(db, o); const c2 = await client(db, o); const c3 = await client(db, o);

  const sub = (cid, status, pay, amount) => db.run(
    `INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, start_date, end_date, status, payment_status)
     VALUES (?,?,?,'Monthly',?, '2026-01-01','2026-12-31',?,?)`,
    [uid('s'), o, cid, amount, status, pay]);

  await sub(c1, 'active', 'paid', 5000);
  await sub(c2, 'overdue', 'overdue', 4999);
  await sub(c3, 'active', 'pending', 4999);

  const p = await gymPulse(db, o, { tz: TZ });
  assert.equal(p.money.outstandingCount, 2, 'the pending one and the overdue one');
  assert.equal(p.money.outstandingAmount, 9998);
  assert.equal(p.money.overdueCount, 1, 'only the genuinely overdue one is urgent');
  assert.equal(p.money.collectedThisMonth, 0, 'no payments were recorded');
});

test('only paid payments count as collected', async () => {
  const db = await memDb();
  const o = await gym(db);
  const c1 = await client(db, o);
  const today = todayIn();
  const monthStart = `${today.slice(0, 7)}-01`;

  const pay = (amount, status, at) => db.run(
    'INSERT INTO payments (id, org_id, client_id, amount, status, paid_at) VALUES (?,?,?,?,?,?)',
    [uid('p'), o, c1, amount, status, at]);

  await pay(3000, 'paid', monthStart);
  await pay(2000, 'paid', today);
  await pay(9999, 'failed', today);          // never collected
  await pay(7777, 'paid', '2020-01-01');     // a different month

  const p = await gymPulse(db, o, { tz: TZ });
  assert.equal(p.money.collectedThisMonth, 5000);
  assert.equal(p.money.paymentsThisMonth, 2);
});

test('a month with no takings is absent from revenue, not drawn as zero', async () => {
  // "No money was recorded" and "we recorded that no money came in" are
  // different claims. The chart must be able to tell them apart.
  const db = await memDb();
  const o = await gym(db);
  const c1 = await client(db, o);
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, status, paid_at) VALUES (?,?,?,?,?,?)',
    [uid('p'), o, c1, 1000, 'paid', '2026-03-15']);
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, status, paid_at) VALUES (?,?,?,?,?,?)',
    [uid('p'), o, c1, 2500, 'paid', '2026-05-02']);

  const p = await gymPulse(db, o, { tz: TZ });
  assert.deepEqual(p.series.revenue, [
    { month: '2026-03', value: 1000 },
    { month: '2026-05', value: 2500 },
  ], 'April is missing, not zero — and the order is oldest first');
});

test('a gym with nothing recorded reports zeroes and empty series, never nulls', async () => {
  // The UI renders no-data states off these; a null would crash a map().
  const db = await memDb();
  const o = await gym(db);
  const p = await gymPulse(db, o, { tz: TZ, days: 7 });

  assert.equal(p.today.checkIns, 0);
  assert.equal(p.money.outstandingAmount, 0);
  assert.deepEqual(p.series.revenue, []);
  assert.deepEqual(p.members.byStatus, []);
  assert.equal(p.series.attendance.length, 7, 'the days still exist, all at zero');
  assert.ok(p.series.attendance.every((d) => d.value === 0));
});

test('the daily series is dense — a day nobody came is a real zero', async () => {
  // Unlike a personal food log, a gap here means the gym was open and
  // empty. Closing the gap would hide exactly the week worth seeing.
  const db = await memDb();
  const o = await gym(db);
  const c1 = await client(db, o);
  const today = todayIn();
  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,1)',
    [uid('a'), o, c1, dayBefore(today, 3)]);

  const p = await gymPulse(db, o, { tz: TZ, days: 7 });
  assert.equal(p.series.attendance.length, 7);
  assert.equal(p.series.attendance[p.series.attendance.length - 1].date, today, 'ends today');
  assert.equal(p.series.attendance.filter((d) => d.value > 0).length, 1);
});

test('one gym never sees another gym\'s numbers', async () => {
  const db = await memDb();
  const a = await gym(db, 'orgA');
  const b = await gym(db, 'orgB');
  const ca = await client(db, a); const cb = await client(db, b);
  const today = todayIn();

  await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,1)', [uid('a'), a, ca, today]);
  for (let i = 0; i < 5; i += 1) {
    await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?,?,?,?,1)', [uid('a'), b, cb, today]);
  }
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, status, paid_at) VALUES (?,?,?,?,?,?)',
    [uid('p'), b, cb, 50000, 'paid', today]);

  const p = await gymPulse(db, a, { tz: TZ });
  assert.equal(p.today.checkIns, 1, "orgB's five check-ins are not orgA's");
  assert.equal(p.money.collectedThisMonth, 0, "orgB's takings are not orgA's");
});

test('the trainer roster counts who is in, out of who exists', async () => {
  const db = await memDb();
  const o = await gym(db);
  const t1 = await trainer(db, o); await trainer(db, o); await trainer(db, o);
  const today = todayIn();

  await db.run(
    `INSERT INTO trainer_attendance (id, org_id, trainer_id, date, status, check_in, source, created_at, updated_at)
     VALUES (?,?,?,?,'PRESENT',?, 'TRAINER_SELF', ?, ?)`,
    [uid('ta'), o, t1, today, new Date().toISOString(), ts, ts]);

  const p = await gymPulse(db, o, { tz: TZ });
  assert.equal(p.today.trainersTotal, 3);
  assert.equal(p.today.trainersIn, 1);
});

test('a membership past its end date is lapsed, whatever the column says', async () => {
  // Nothing expires subscriptions on a schedule here, so rows sit at
  // status 'active' long after they run out. Believing the column
  // reported "23 active" to a gym whose members had mostly lapsed --
  // the most expensive number on the dashboard to get wrong, because it
  // is the one that says the business is fine.
  const db = await memDb();
  const o = await gym(db);
  const c1 = await client(db, o); const c2 = await client(db, o); const c3 = await client(db, o);
  const today = todayIn();
  const plus = (d) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

  const sub = (cid, status, end) => db.run(
    `INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, start_date, end_date, status, payment_status)
     VALUES (?,?,?,'Monthly',1000,'2026-01-01',?,?, 'paid')`, [uid('s'), o, cid, end, status]);

  await sub(c1, 'active', plus(60));    // genuinely active
  await sub(c2, 'active', plus(-120));  // "active" but ended four months ago
  await sub(c3, 'cancelled', plus(-5));

  const p = await gymPulse(db, o, { tz: TZ });
  const by = Object.fromEntries(p.members.byStatus.map((x) => [x.status, x.value]));
  assert.equal(by.active, 1, 'only the one that has not run out');
  assert.equal(by.lapsed, 1, 'the stale row is reported as what it is');
  assert.equal(by.cancelled, 1, 'a cancelled one stays cancelled, not relabelled');
});

test('memberships expiring soon are active ones ending within 30 days', async () => {
  const db = await memDb();
  const o = await gym(db);
  const c1 = await client(db, o); const c2 = await client(db, o); const c3 = await client(db, o);
  const today = todayIn();
  const plus = (d) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

  const sub = (cid, status, end) => db.run(
    `INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, start_date, end_date, status, payment_status)
     VALUES (?,?,?,'Monthly',1000,'2026-01-01',?,?, 'paid')`, [uid('s'), o, cid, end, status]);

  await sub(c1, 'active', plus(10));    // counts
  await sub(c2, 'active', plus(200));   // too far out
  await sub(c3, 'cancelled', plus(5));  // already gone; renewing it is not the job

  const p = await gymPulse(db, o, { tz: TZ });
  assert.equal(p.members.expiringSoon, 1);
});
