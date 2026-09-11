// ============================================================
// TRAINER ATTENDANCE
//
// Attendance is a record people are paid and judged against, so the
// properties that matter are the ones where being WRONG still looks
// plausible:
//
//   SEPARATION   trainer attendance is not client attendance and is not a
//                logged workout. Inferring it from either would produce a
//                complete, believable, fabricated timesheet.
//
//   HONESTY      "no record" is not "absent". Absence is a claim, and it
//                needs an expectation to be false against.
//
//   IDEMPOTENCE  a double-tapped button or a re-scanned QR must not
//                create a second arrival or move the first one.
//
//   AUTHORITY    a trainer may ASK for a correction; only an owner may
//                grant one. A self-service edit of your own hours is not
//                attendance.
//
//   AUDITABILITY every change keeps what it said before.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getPolicy, setPolicy, isGymTrainer, setShift, shiftFor, listShifts,
  checkIn, checkOut, getDay, classifyCheckIn, resolveDayStatus,
  requestCorrection, resolveCorrection, ownerSet, dayRoster, summarise,
  trainerHistory, pendingCorrections, flagMissingCheckouts, auditFor,
} from '../src/services/trainerAttendance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const TZ = 'Asia/Kolkata';
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = db.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = db.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    raw: db,
  });
  return mk();
}

let seq = 0;
const uid = (p) => `${p}_${++seq}`;

async function makeGym(db, orgId) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)',
    [orgId, orgId, orgId, ts]);
  await db.run('INSERT INTO gym_settings (org_id, updated_at) VALUES (?,?)', [orgId, ts]);
}

async function makeTrainer(db, orgId, name) {
  const userId = uid('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?,?,?,?,'TRAINER',?,1,?)`, [userId, orgId, `${userId}@a.in`, 'x', name, ts]);
  await db.run('INSERT INTO trainers (user_id, org_id, max_clients) VALUES (?,?,50)', [userId, orgId]);
  return userId;
}

async function makeOwner(db, orgId, name = 'Owner') {
  const userId = uid('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?,?,?,?,'GYM_OWNER',?,1,?)`, [userId, orgId, `${userId}@a.in`, 'x', name, ts]);
  return userId;
}

const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

/** An instant that is HH:MM local in the gym's timezone, today. */
function localToday(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  // Asia/Kolkata is UTC+5:30 and has no DST, so this is exact.
  const utcMinutes = h * 60 + m - (5 * 60 + 30);
  const d = new Date(`${todayLocal()}T00:00:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + utcMinutes);
  return d.toISOString();
}

// ---------------- separation ----------------

test('a client visit and a logged workout never create trainer attendance', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  const trainer = await makeTrainer(db, 'o1', 'Coach');

  // A client attends, and the trainer logs their own workout the same day.
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('u_c','o1','c@a.in','x','CLIENT','Client',1,?)`, [ts]);
  await db.run(`INSERT INTO clients (id, user_id, org_id, goal, created_at)
                VALUES ('cli_1','u_c','o1','GENERAL',?)`, [ts]);
  await db.run(`INSERT INTO attendance (id, org_id, client_id, date, present)
                VALUES ('att_1','o1','cli_1',?,1)`, [todayLocal()]);

  // Neither says anything about whether the TRAINER was at work.
  const row = await getDay(db, { orgId: 'o1', trainerId: trainer, date: todayLocal() });
  assert.equal(row, null, 'trainer attendance is never inferred from a client visit');

  const roster = await dayRoster(db, { orgId: 'o1', date: todayLocal(), tz: TZ });
  assert.equal(roster.length, 1);
  assert.equal(roster[0].checkIn, null);
});

// ---------------- honesty about absence ----------------

test('no record is NOT absent without an expectation to be absent from', () => {
  const today = '2026-09-12';
  // A gym that runs no shifts cannot assert absence about anyone.
  assert.equal(resolveDayStatus({
    row: null, shift: null, mode: 'simple', date: today, today, nowMinutes: 900, graceMinutes: 10,
  }), 'NO_RECORD');

  // Scheduled gym, but this trainer has no shift that day -> a day off,
  // not an absence.
  assert.equal(resolveDayStatus({
    row: null, shift: null, mode: 'scheduled', date: '2026-09-10', today, nowMinutes: 900, graceMinutes: 10,
  }), 'NO_RECORD');

  // Shift at 07:00, it is 06:30 today: not here YET.
  assert.equal(resolveDayStatus({
    row: null, shift: { start: '07:00' }, mode: 'scheduled', date: today, today,
    nowMinutes: 6 * 60 + 30, graceMinutes: 10,
  }), 'NOT_CHECKED_IN');

  // Past the start with nothing recorded: needs a human, not a verdict.
  assert.equal(resolveDayStatus({
    row: null, shift: { start: '07:00' }, mode: 'scheduled', date: today, today,
    nowMinutes: 11 * 60, graceMinutes: 10,
  }), 'PENDING');

  // A PAST day, with a shift, and no record at all -- now absence is a
  // claim the data actually supports.
  assert.equal(resolveDayStatus({
    row: null, shift: { start: '07:00' }, mode: 'scheduled', date: '2026-09-10', today,
    nowMinutes: 900, graceMinutes: 10,
  }), 'ABSENT');
});

// ---------------- grace period ----------------

test('lateness respects the gym\'s configured grace, and needs a shift at all', () => {
  const shift = { start: '07:00' };
  const at = (hhmm) => classifyCheckIn({ checkInIso: localToday(hhmm), shift, graceMinutes: 10, tz: TZ });

  assert.equal(at('06:55').status, 'PRESENT', 'early is present');
  assert.equal(at('07:00').status, 'PRESENT');
  assert.equal(at('07:08').status, 'PRESENT', 'inside the grace window');
  assert.equal(at('07:10').status, 'PRESENT', 'the boundary is inclusive');
  const late = at('07:22');
  assert.equal(late.status, 'LATE');
  assert.equal(late.lateMinutes, 22, 'measured from the scheduled start, not from the grace edge');

  // A different gym policy produces a different answer for the same clock.
  assert.equal(
    classifyCheckIn({ checkInIso: localToday('07:22'), shift, graceMinutes: 30, tz: TZ }).status,
    'PRESENT', 'grace is a gym setting, not a constant');

  // With no shift there is nothing to be late against.
  assert.equal(
    classifyCheckIn({ checkInIso: localToday('11:00'), shift: null, graceMinutes: 10, tz: TZ }).status,
    'PRESENT');
});

// ---------------- check in / out ----------------

test('checking in twice does not create a second arrival or move the first', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  const trainer = await makeTrainer(db, 'o1', 'Coach');

  const first = await checkIn(db, { orgId: 'o1', trainerId: trainer, tz: TZ });
  assert.equal(first.ok, true);
  const firstAt = first.attendance.check_in;

  const second = await checkIn(db, { orgId: 'o1', trainerId: trainer, tz: TZ, source: 'GYM_QR' });
  assert.equal(second.already, true, 'a re-scan is a no-op, not a new record');
  assert.equal(second.attendance.check_in, firstAt, 'the original arrival time stands');

  const all = await db.q('SELECT * FROM trainer_attendance WHERE trainer_id = ?', [trainer]);
  assert.equal(all.length, 1, 'one row per trainer per day');
});

test('check-out records real hours, and is refused without a check-in', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  const trainer = await makeTrainer(db, 'o1', 'Coach');

  const early = await checkOut(db, { orgId: 'o1', trainerId: trainer, tz: TZ });
  assert.equal(early.ok, false, 'leaving without arriving is not a work record');

  await checkIn(db, { orgId: 'o1', trainerId: trainer, tz: TZ, at: localToday('07:00') });
  const out = await checkOut(db, { orgId: 'o1', trainerId: trainer, tz: TZ, at: localToday('15:10') });
  assert.equal(out.ok, true);
  assert.equal(out.attendance.worked_minutes, 490, '8h10m, computed from the two instants');

  const again = await checkOut(db, { orgId: 'o1', trainerId: trainer, tz: TZ });
  assert.equal(again.already, true, 'a second check-out does not extend the day');
});

test('a forgotten check-out is flagged, not invented', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  const trainer = await makeTrainer(db, 'o1', 'Coach');

  // Yesterday: arrived, never left.
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
  await db.run(
    `INSERT INTO trainer_attendance (id, org_id, trainer_id, date, check_in, status, source, created_at, updated_at)
     VALUES ('tat_x','o1',?,?,?,'PRESENT','TRAINER_SELF',?,?)`,
    [trainer, yesterday, `${yesterday}T01:30:00Z`, ts, ts]);

  const n = await flagMissingCheckouts(db, { orgId: 'o1', tz: TZ });
  assert.equal(n, 1);
  const row = await db.q1('SELECT * FROM trainer_attendance WHERE id = ?', ['tat_x']);
  assert.equal(row.status, 'MISSING_CHECKOUT');
  // The crucial half: no checkout was fabricated, so no hours were either.
  assert.equal(row.check_out, null, 'a guessed midnight checkout would invent an 8-hour day');
  assert.equal(row.worked_minutes, null);
});

// ---------------- corrections ----------------

test('a trainer can request a correction but cannot grant it', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  const trainer = await makeTrainer(db, 'o1', 'Coach');
  const owner = await makeOwner(db, 'o1');

  const date = todayLocal();
  const row = await requestCorrection(db, {
    orgId: 'o1', trainerId: trainer, date,
    checkIn: localToday('07:00'), checkOut: localToday('15:00'),
    reason: 'Forgot to check in',
  });
  assert.equal(row.correction_status, 'PENDING');
  // The request alone changes nothing about the record itself.
  assert.equal(row.check_in, null, 'a request is not an edit');

  const queue = await pendingCorrections(db, 'o1');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].reason, 'Forgot to check in');

  const approved = await resolveCorrection(db, {
    orgId: 'o1', attendanceId: row.id, actorId: owner, approve: true, tz: TZ,
  });
  assert.equal(approved.correction_status, 'APPROVED');
  assert.equal(approved.check_in, localToday('07:00'), 'only now does it become the record');
  assert.equal(approved.worked_minutes, 480);
  assert.equal(approved.source, 'CORRECTION', 'and it is labelled as one, not as a door scan');
});

test('a rejected correction leaves the original record untouched', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  const trainer = await makeTrainer(db, 'o1', 'Coach');
  const date = todayLocal();

  await checkIn(db, { orgId: 'o1', trainerId: trainer, tz: TZ, at: localToday('09:30') });
  const before = await getDay(db, { orgId: 'o1', trainerId: trainer, date });

  const req = await requestCorrection(db, {
    orgId: 'o1', trainerId: trainer, date, checkIn: localToday('07:00'), reason: 'Was actually early',
  });
  const owner = await makeOwner(db, 'o1');
  const rejected = await resolveCorrection(db, {
    orgId: 'o1', attendanceId: req.id, actorId: owner, approve: false, tz: TZ,
  });
  assert.equal(rejected.correction_status, 'REJECTED');
  assert.equal(rejected.check_in, before.check_in, 'the real arrival is preserved');
});

// ---------------- owner edits + audit ----------------

test('an owner edit is labelled and keeps what the record said before', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  const trainer = await makeTrainer(db, 'o1', 'Coach');
  const owner = await makeOwner(db, 'o1');
  const date = todayLocal();

  await checkIn(db, { orgId: 'o1', trainerId: trainer, tz: TZ, at: localToday('07:10') });
  const original = await getDay(db, { orgId: 'o1', trainerId: trainer, date });

  const edited = await ownerSet(db, {
    orgId: 'o1', trainerId: trainer, date, actorId: owner, tz: TZ,
    checkIn: localToday('07:00'), checkOut: localToday('15:00'), reason: 'Door scanner was down',
  });
  assert.equal(edited.source, 'OWNER_MANUAL', 'never mistaken for a record somebody stood at the door for');
  assert.equal(edited.worked_minutes, 480);

  const trail = await auditFor(db, { orgId: 'o1', attendanceId: original.id });
  const edit = trail.find((e) => e.action === 'OWNER_EDIT');
  assert.ok(edit, 'the edit is recorded');
  assert.equal(edit.before.check_in, original.check_in, 'with the value it had before');
  assert.equal(edit.after.check_in, localToday('07:00'));
  assert.equal(edit.reason, 'Door scanner was down');
});

test('an explicit LEAVE is respected and not re-derived into lateness', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  await setPolicy(db, 'o1', { mode: 'scheduled', graceMinutes: 10 });
  const trainer = await makeTrainer(db, 'o1', 'Coach');
  const owner = await makeOwner(db, 'o1');
  const date = todayLocal();
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  await setShift(db, { orgId: 'o1', trainerId: trainer, dayOfWeek: dow, startTime: '07:00', endTime: '15:00' });

  const row = await ownerSet(db, {
    orgId: 'o1', trainerId: trainer, date, actorId: owner, tz: TZ,
    status: 'LEAVE', reason: 'Approved leave',
  });
  assert.equal(row.status, 'LEAVE');

  const roster = await dayRoster(db, { orgId: 'o1', date, tz: TZ });
  assert.equal(roster[0].status, 'LEAVE', 'an approved absence is not an absence');
  assert.equal(summarise(roster).absent, 0);
  assert.equal(summarise(roster).leave, 1);
});

// ---------------- shifts, roster, isolation ----------------

test('shifts drive the expectation, and a day without one is not an absence', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  await setPolicy(db, 'o1', { mode: 'scheduled', graceMinutes: 10 });
  const trainer = await makeTrainer(db, 'o1', 'Coach');

  const date = todayLocal();
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  await setShift(db, { orgId: 'o1', trainerId: trainer, dayOfWeek: dow, startTime: '07:00', endTime: '15:00' });

  const shift = await shiftFor(db, { orgId: 'o1', trainerId: trainer, date });
  assert.deepEqual(shift, { start: '07:00', end: '15:00' });
  assert.equal((await listShifts(db, { orgId: 'o1', trainerId: trainer })).length, 1);

  // The shift is SNAPSHOT onto the record, so editing it later cannot
  // retroactively make a past day late.
  await checkIn(db, { orgId: 'o1', trainerId: trainer, tz: TZ, at: localToday('07:05') });
  const row = await getDay(db, { orgId: 'o1', trainerId: trainer, date });
  assert.equal(row.scheduled_start, '07:00');
  await setShift(db, { orgId: 'o1', trainerId: trainer, dayOfWeek: dow, startTime: '05:00', endTime: '13:00' });
  const unchanged = await getDay(db, { orgId: 'o1', trainerId: trainer, date });
  assert.equal(unchanged.scheduled_start, '07:00', 'history keeps the expectation it was judged against');
  assert.equal(unchanged.status, 'PRESENT');
});

test('one gym never sees another gym\'s trainers or attendance', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  await makeGym(db, 'o2');
  const a = await makeTrainer(db, 'o1', 'Alpha');
  const b = await makeTrainer(db, 'o2', 'Beta');

  await checkIn(db, { orgId: 'o1', trainerId: a, tz: TZ });
  await checkIn(db, { orgId: 'o2', trainerId: b, tz: TZ });

  const roster1 = await dayRoster(db, { orgId: 'o1', date: todayLocal(), tz: TZ });
  assert.deepEqual(roster1.map((r) => r.name), ['Alpha']);

  assert.equal(await isGymTrainer(db, 'o1', b), false, "another gym's trainer is not writable here");
  assert.equal(await isGymTrainer(db, 'o2', b), true);

  // A trainer belongs to exactly ONE gym: trainers.user_id is the primary
  // key, so the schema itself refuses a second membership. Worth pinning,
  // because the attendance model is built to be gym-scoped (UNIQUE on
  // org+trainer+date) and would support a multi-gym trainer the day that
  // constraint changes -- but today, "which gym is this trainer's
  // attendance for" has exactly one answer, and any feature assuming
  // otherwise is assuming something the database will not allow.
  await assert.rejects(
    () => db.run('INSERT INTO trainers (user_id, org_id, max_clients) VALUES (?,?,50)', [a, 'o2']),
    'a trainer cannot be registered at a second gym');
});

test('history reports only averages it has the data for', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  const trainer = await makeTrainer(db, 'o1', 'Coach');

  const start = '2026-01-01'; const end = '2026-12-31';
  let h = await trainerHistory(db, { orgId: 'o1', trainerId: trainer, start, end });
  assert.equal(h.days.length, 0);
  assert.equal(h.summary.averageMinutes, null, 'no records, no average');

  await checkIn(db, { orgId: 'o1', trainerId: trainer, tz: TZ, at: localToday('07:00') });
  await checkOut(db, { orgId: 'o1', trainerId: trainer, tz: TZ, at: localToday('15:00') });
  h = await trainerHistory(db, { orgId: 'o1', trainerId: trainer, start, end });
  assert.equal(h.summary.totalMinutes, 480);
  assert.equal(h.summary.averageMinutes, null, 'one day is not an average');
  assert.equal(h.summary.present, 1);
});

test('the policy is a gym setting with a safe default', async () => {
  const db = await memDb();
  await makeGym(db, 'o1');
  const def = await getPolicy(db, 'o1');
  // 'simple' by default: a gym that has not configured shifts must never
  // start generating lateness or absence on its own.
  assert.equal(def.mode, 'simple');
  assert.equal(def.graceMinutes, 10);

  const updated = await setPolicy(db, 'o1', { mode: 'scheduled', graceMinutes: 25 });
  assert.equal(updated.mode, 'scheduled');
  assert.equal(updated.graceMinutes, 25);
});
