// ============================================================
// A CORRECTION REQUEST USED TO ACCEPT ANY STRING AT ALL.
//
// The schema said z.string().max(40). So "7:30 PM" — exactly what a
// localized clock helper produces, and exactly what the trainer screen
// was pre-filling into an <input type="time"> — was stored verbatim.
//
// The damage ran in two directions. On the owner's screen the value was
// interpolated into a template literal, so an unparseable time rendered
// as the literal word "null". And on APPROVE it was copied straight into
// check_in, which is the attendance record itself: a pay-relevant field,
// corrupted from a form, with nothing in between saying no.
//
// Found by driving the real flow end to end rather than by reading the
// schema — the screen showed an empty time field while React state
// quietly held the bad string and submitted it.
//
// Two layers are tested here, on purpose. The route rejects bad input at
// the boundary; resolveCorrection refuses to promote a bad stored value
// even if one gets there another way. Either alone would leave the other
// path open.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timeOnDateToIso, resolveCorrection } from '../src/services/trainerAttendance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';
const TZ = 'Asia/Kolkata';

test('a 24-hour time becomes a real instant in the gym\'s timezone', () => {
  // 06:00 in Kolkata is 00:30 UTC — the offset is measured, not assumed.
  const got = timeOnDateToIso('2026-09-11', '06:00', TZ);
  assert.equal(got, '2026-09-11T00:30:00.000Z');
});

test('anything that is not a 24-hour time is refused', () => {
  // The first of these is the exact string that caused the bug.
  for (const bad of ['7:30 PM', '7:30pm', '25:00', '6:00', '0600', 'null', '', null, undefined, 'tomorrow']) {
    assert.equal(timeOnDateToIso('2026-09-11', bad, TZ), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('a malformed date is refused too', () => {
  assert.equal(timeOnDateToIso('11-09-2026', '06:00', TZ), null);
  assert.equal(timeOnDateToIso('', '06:00', TZ), null);
});

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

async function seedPending(db, { correctionCheckIn, correctionCheckOut = null }) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('t1','o1','t@x.in','x','TRAINER','T',1,?)`, [ts]);
  await db.run('INSERT INTO trainers (user_id, org_id) VALUES (?,?)', ['t1', 'o1']);
  // The audit trail references the actor, so the approver has to exist.
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('own1','o1','o@x.in','x','GYM_OWNER','O',1,?)`, [ts]);
  await db.run(
    `INSERT INTO trainer_attendance
       (id, org_id, trainer_id, date, status, correction_status, correction_check_in, correction_check_out,
        correction_reason, source, created_at, updated_at)
     VALUES ('ta1','o1','t1','2026-09-11','ABSENT','PENDING',?,?,'was here','CORRECTION',?,?)`,
    [correctionCheckIn, correctionCheckOut, ts, ts]);
  return 'ta1';
}

test('approving a correction stores the requested instant', async () => {
  const db = await memDb();
  await seedPending(db, {
    correctionCheckIn: '2026-09-11T00:30:00.000Z',
    correctionCheckOut: '2026-09-11T09:00:00.000Z',
  });

  await resolveCorrection(db, { orgId: 'o1', attendanceId: 'ta1', actorId: 'own1', approve: true, tz: TZ });

  const row = await db.q1('SELECT * FROM trainer_attendance WHERE id = ?', ['ta1']);
  assert.equal(row.check_in, '2026-09-11T00:30:00.000Z');
  assert.equal(row.worked_minutes, 510, '8h30m, actually computed');
  assert.equal(row.correction_status, 'APPROVED');
});

test('approving never promotes a stored value that is not a real instant', async () => {
  // The defensive half. Even if a bad value reaches the column by some
  // other route, it must not become the attendance record.
  const db = await memDb();
  await seedPending(db, { correctionCheckIn: '7:30 PM' });

  await resolveCorrection(db, { orgId: 'o1', attendanceId: 'ta1', actorId: 'own1', approve: true, tz: TZ });

  const row = await db.q1('SELECT * FROM trainer_attendance WHERE id = ?', ['ta1']);
  assert.notEqual(row.check_in, '7:30 PM', 'the garbage string must not land in check_in');
  assert.ok(row.check_in == null || !Number.isNaN(Date.parse(row.check_in)),
    'check_in is either absent or a parseable instant — never junk');
  assert.ok(row.worked_minutes == null || Number.isFinite(row.worked_minutes),
    'and worked minutes is never NaN');
});

test('rejecting a correction leaves the record untouched', async () => {
  const db = await memDb();
  await seedPending(db, { correctionCheckIn: '2026-09-11T00:30:00.000Z' });

  await resolveCorrection(db, { orgId: 'o1', attendanceId: 'ta1', actorId: 'own1', approve: false, tz: TZ });

  const row = await db.q1('SELECT * FROM trainer_attendance WHERE id = ?', ['ta1']);
  assert.equal(row.correction_status, 'REJECTED');
  assert.equal(row.check_in, null, 'a declined request changes nothing about the day');
});
