// ============================================================
// TRAINER ATTENDANCE — expected work vs actual presence.
//
// ONE PLACE FOR THE RULES. Everything that decides what a record MEANS --
// present or late, how many minutes were worked, whether an absence can
// even be asserted -- lives in this file. Route handlers call it; React
// never recomputes it. Attendance rules scattered across a controller and
// three components is how two screens end up disagreeing about whether
// somebody was late.
//
// WHAT THIS DELIBERATELY WILL NOT DO
//
//   It will not infer attendance from a client session or a logged
//   workout. A trainer can be at work with nothing booked, and can log
//   their own training on a day off. Attendance is always an explicit act
//   -- a check-in, a QR scan, or an owner entry -- and `source` records
//   which one.
//
//   It will not call a missing record "absent". Absence is a CLAIM, and
//   it needs an expectation to be false against: no schedule means no
//   claim is possible, only "no record". See resolveDayStatus.
//
//   It will not silently rewrite history. Every mutation writes an audit
//   row with the before and after, because attendance is evidence.
// ============================================================
import { id, now } from '../ids.js';
import { dayKey, todayKey } from '../utils/time.js';

const int = (v) => {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export const STATUSES = ['PRESENT', 'LATE', 'ABSENT', 'LEAVE', 'OFF_DAY', 'MISSING_CHECKOUT'];
export const SOURCES = ['TRAINER_SELF', 'GYM_QR', 'OWNER_MANUAL', 'CORRECTION'];

/** Gym attendance policy, with defaults for a settings row that predates
 *  these columns. 'simple' is the default because a gym that has not
 *  configured shifts must not start generating lateness. */
export async function getPolicy(db, orgId) {
  const r = await db.q1(
    'SELECT attendance_mode, attendance_grace_min, attendance_require_qr FROM gym_settings WHERE org_id = ?',
    [orgId]);
  return {
    mode: r?.attendance_mode === 'scheduled' ? 'scheduled' : 'simple',
    graceMinutes: r?.attendance_grace_min == null ? 10 : int(r.attendance_grace_min),
    /* Defaults to REQUIRED, including for a settings row written before
       this column existed. An attendance record that anyone can create
       from anywhere is not attendance data, and defaulting the safer way
       means an existing gym does not silently keep the weaker rule. */
    requireQr: r?.attendance_require_qr == null ? true : int(r.attendance_require_qr) === 1,
  };
}

export async function setPolicy(db, orgId, { mode, graceMinutes, requireQr }) {
  const sets = []; const params = [];
  if (mode) { sets.push('attendance_mode = ?'); params.push(mode === 'scheduled' ? 'scheduled' : 'simple'); }
  if (graceMinutes != null) { sets.push('attendance_grace_min = ?'); params.push(Math.max(0, Math.min(120, int(graceMinutes)))); }
  if (requireQr != null) { sets.push('attendance_require_qr = ?'); params.push(requireQr ? 1 : 0); }
  if (!sets.length) return getPolicy(db, orgId);
  sets.push('updated_at = ?'); params.push(now());
  params.push(orgId);
  await db.run(`UPDATE gym_settings SET ${sets.join(', ')} WHERE org_id = ?`, params);
  return getPolicy(db, orgId);
}

/** Is this person a trainer at THIS gym? Every write goes through it --
 *  a trainer id from the client is never trusted. */
export async function isGymTrainer(db, orgId, trainerId) {
  const r = await db.q1('SELECT user_id FROM trainers WHERE user_id = ? AND org_id = ?', [trainerId, orgId]);
  return !!r;
}

/** The shift a trainer is expected to work on a given date, or null. */
export async function shiftFor(db, { orgId, trainerId, date }) {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const r = await db.q1(
    `SELECT start_time, end_time FROM trainer_shifts
      WHERE org_id = ? AND trainer_id = ? AND day_of_week = ? AND active = 1`,
    [orgId, trainerId, dow]);
  return r ? { start: r.start_time, end: r.end_time } : null;
}

export async function listShifts(db, { orgId, trainerId }) {
  return db.q(
    `SELECT day_of_week, start_time, end_time, active FROM trainer_shifts
      WHERE org_id = ? AND trainer_id = ? ORDER BY day_of_week`, [orgId, trainerId]);
}

export async function setShift(db, { orgId, trainerId, dayOfWeek, startTime, endTime, active = 1 }) {
  const existing = await db.q1(
    'SELECT id FROM trainer_shifts WHERE org_id = ? AND trainer_id = ? AND day_of_week = ?',
    [orgId, trainerId, dayOfWeek]);
  if (existing) {
    await db.run(
      'UPDATE trainer_shifts SET start_time = ?, end_time = ?, active = ? WHERE id = ?',
      [startTime, endTime, active ? 1 : 0, existing.id]);
    return { id: existing.id };
  }
  const sid = id('tsh');
  await db.run(
    `INSERT INTO trainer_shifts (id, org_id, trainer_id, day_of_week, start_time, end_time, active, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [sid, orgId, trainerId, dayOfWeek, startTime, endTime, active ? 1 : 0, now()]);
  return { id: sid };
}

export async function removeShift(db, { orgId, trainerId, dayOfWeek }) {
  const r = await db.run(
    'DELETE FROM trainer_shifts WHERE org_id = ? AND trainer_id = ? AND day_of_week = ?',
    [orgId, trainerId, dayOfWeek]);
  return r.changes > 0;
}

/* ---------- time helpers ---------- */

/** Minutes from midnight for "HH:MM". */
function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Local wall-clock minutes for an instant, in the GYM's timezone.
 *  Attendance is judged against a shift written in gym-local time, so
 *  comparing a UTC hour against "07:00" would be wrong by the offset --
 *  five and a half hours, in this product's default timezone. */
function localMinutes(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  return hhmmToMinutes(hhmm);
}

function minutesBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 60000));
}

/** PRESENT or LATE for a check-in, given the shift and the gym's grace.
 *  With no shift there is nothing to be late against, so a check-in is
 *  simply PRESENT -- inventing a lateness figure from an assumed start
 *  time would be fabricating the expectation. */
export function classifyCheckIn({ checkInIso, shift, graceMinutes, tz }) {
  if (!shift?.start) return { status: 'PRESENT', lateMinutes: 0 };
  const actual = localMinutes(checkInIso, tz);
  const expected = hhmmToMinutes(shift.start);
  if (actual == null || expected == null) return { status: 'PRESENT', lateMinutes: 0 };
  const late = actual - expected;
  if (late <= graceMinutes) return { status: 'PRESENT', lateMinutes: Math.max(0, late) };
  return { status: 'LATE', lateMinutes: late };
}

/* ---------- the day's record ---------- */

export async function getDay(db, { orgId, trainerId, date }) {
  return db.q1(
    'SELECT * FROM trainer_attendance WHERE org_id = ? AND trainer_id = ? AND date = ?',
    [orgId, trainerId, date]);
}

async function audit(db, { orgId, attendanceId, actorId, action, before, after, reason }) {
  await db.run(
    `INSERT INTO trainer_attendance_audit (id, org_id, attendance_id, actor_id, action, before_json, after_json, reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id('taa'), orgId, attendanceId, actorId || null, action,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
     reason || null, now()]);
}

export async function auditFor(db, { orgId, attendanceId }) {
  const rows = await db.q(
    `SELECT a.*, u.name AS actor_name FROM trainer_attendance_audit a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.org_id = ? AND a.attendance_id = ? ORDER BY a.created_at ASC`,
    [orgId, attendanceId]);
  return rows.map((r) => ({
    id: r.id, action: r.action, actorName: r.actor_name || 'System',
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
    reason: r.reason, createdAt: r.created_at,
  }));
}

/**
 * CHECK IN. Idempotent by construction: the row is UNIQUE per
 * (org, trainer, date), and an existing check-in is returned rather than
 * replaced. A double-tapped button, or a trainer scanning the gym QR
 * twice, cannot produce two arrivals or move the first one later.
 */
export async function checkIn(db, { orgId, trainerId, tz, source = 'TRAINER_SELF', at = null }) {
  const date = todayKey(tz);
  const existing = await getDay(db, { orgId, trainerId, date });
  if (existing?.check_in) {
    return { ok: true, already: true, attendance: existing };
  }

  const policy = await getPolicy(db, orgId);
  const shift = await shiftFor(db, { orgId, trainerId, date });
  const when = at || now();
  const { status, lateMinutes } = classifyCheckIn({
    checkInIso: when, shift, graceMinutes: policy.graceMinutes, tz,
  });

  if (existing) {
    // A row already exists for today (owner marked LEAVE, or a correction
    // is pending). Checking in is real presence, so it wins -- but the
    // audit keeps what it said before.
    await db.run(
      `UPDATE trainer_attendance
          SET check_in = ?, status = ?, late_minutes = ?, source = ?,
              scheduled_start = ?, scheduled_end = ?, updated_at = ?
        WHERE id = ?`,
      [when, status, lateMinutes, source, shift?.start || null, shift?.end || null, now(), existing.id]);
    const after = await getDay(db, { orgId, trainerId, date });
    await audit(db, { orgId, attendanceId: existing.id, actorId: trainerId, action: 'CHECK_IN', before: existing, after });
    return { ok: true, attendance: after };
  }

  const aid = id('tat');
  await db.run(
    `INSERT INTO trainer_attendance
       (id, org_id, trainer_id, date, scheduled_start, scheduled_end, check_in, status, source, late_minutes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [aid, orgId, trainerId, date, shift?.start || null, shift?.end || null,
     when, status, source, lateMinutes, now(), now()]);
  const after = await getDay(db, { orgId, trainerId, date });
  await audit(db, { orgId, attendanceId: aid, actorId: trainerId, action: 'CHECK_IN', after });
  return { ok: true, attendance: after };
}

/** CHECK OUT. Refuses without a check-in rather than inventing one --
 *  a checkout with no arrival is not a work record, it is a mistake. */
export async function checkOut(db, { orgId, trainerId, tz, at = null }) {
  const date = todayKey(tz);
  const row = await getDay(db, { orgId, trainerId, date });
  if (!row || !row.check_in) return { ok: false, reason: 'not_checked_in' };
  if (row.check_out) return { ok: true, already: true, attendance: row };

  const when = at || now();
  const worked = minutesBetween(row.check_in, when);
  // Leaving restores PRESENT/LATE from MISSING_CHECKOUT; lateness is a
  // fact about the arrival and is never recalculated here.
  const status = row.status === 'MISSING_CHECKOUT'
    ? (row.late_minutes > 0 ? 'LATE' : 'PRESENT')
    : row.status;

  await db.run(
    'UPDATE trainer_attendance SET check_out = ?, worked_minutes = ?, status = ?, updated_at = ? WHERE id = ?',
    [when, worked, status, now(), row.id]);
  const after = await getDay(db, { orgId, trainerId, date });
  await audit(db, { orgId, attendanceId: row.id, actorId: trainerId, action: 'CHECK_OUT', before: row, after });
  return { ok: true, attendance: after };
}

/**
 * What a day MEANS for a trainer who has no attendance row.
 *
 * This is the function that keeps the system honest. "No record" is not
 * "absent": it could be a day they were never expected, an approved
 * leave, or simply a shift that has not started yet. Absence is a claim,
 * and a claim needs an expectation to be false against.
 */
export function resolveDayStatus({ row, shift, mode, date, today, nowMinutes, graceMinutes }) {
  if (row) return row.status;
  // No shift configured, or a gym that does not run shifts at all: there
  // is no expectation, so there is nothing to assert.
  if (mode !== 'scheduled' || !shift) return date === today ? 'NO_RECORD' : 'NO_RECORD';
  if (!shift.start) return 'OFF_DAY';
  if (date > today) return 'SCHEDULED';
  if (date === today) {
    const expected = hhmmToMinutes(shift.start);
    // Before the shift starts (plus grace) the trainer is not late, let
    // alone absent -- they are simply not here yet.
    if (expected != null && nowMinutes != null && nowMinutes <= expected + graceMinutes) return 'NOT_CHECKED_IN';
    return 'PENDING';   // past start, still nothing: needs a human, not an automatic verdict
  }
  return 'ABSENT';      // a past day with a shift and no record at all
}

/** Mark MISSING_CHECKOUT for anyone who checked in on an earlier day and
 *  never checked out. Deliberately does NOT invent a checkout time: the
 *  hours are unknown, and guessing midnight would put a fabricated
 *  8-hour day into the record. */
export async function flagMissingCheckouts(db, { orgId, tz }) {
  const today = todayKey(tz);
  const rows = await db.q(
    `SELECT * FROM trainer_attendance
      WHERE org_id = ? AND date < ? AND check_in IS NOT NULL AND check_out IS NULL
        AND status <> 'MISSING_CHECKOUT'`,
    [orgId, today]);
  for (const r of rows) {
    /* eslint-disable no-await-in-loop */
    await db.run('UPDATE trainer_attendance SET status = ?, updated_at = ? WHERE id = ?',
      ['MISSING_CHECKOUT', now(), r.id]);
    await audit(db, { orgId, attendanceId: r.id, action: 'MISSING_CHECKOUT', before: r });
    /* eslint-enable no-await-in-loop */
  }
  return rows.length;
}

/* ---------- corrections ---------- */

/** A trainer asking for a day to be fixed. It does NOT change the record:
 *  it attaches a request the owner can approve or reject, so a trainer
 *  can never quietly rewrite their own hours. */
export async function requestCorrection(db, { orgId, trainerId, date, checkIn, checkOut, reason }) {
  let row = await getDay(db, { orgId, trainerId, date });
  if (!row) {
    const shift = await shiftFor(db, { orgId, trainerId, date });
    const aid = id('tat');
    await db.run(
      `INSERT INTO trainer_attendance
         (id, org_id, trainer_id, date, scheduled_start, scheduled_end, status, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'ABSENT','CORRECTION',?,?)`,
      [aid, orgId, trainerId, date, shift?.start || null, shift?.end || null, now(), now()]);
    row = await getDay(db, { orgId, trainerId, date });
  }
  const before = { ...row };
  await db.run(
    `UPDATE trainer_attendance
        SET correction_status = 'PENDING', correction_reason = ?,
            correction_check_in = ?, correction_check_out = ?, updated_at = ?
      WHERE id = ?`,
    [String(reason || '').slice(0, 300), checkIn || null, checkOut || null, now(), row.id]);
  const after = await getDay(db, { orgId, trainerId, date });
  await audit(db, {
    orgId, attendanceId: row.id, actorId: trainerId,
    action: 'CORRECTION_REQUESTED', before, after, reason,
  });
  return after;
}

export async function resolveCorrection(db, { orgId, attendanceId, actorId, approve, tz }) {
  const row = await db.q1('SELECT * FROM trainer_attendance WHERE id = ? AND org_id = ?', [attendanceId, orgId]);
  if (!row || row.correction_status !== 'PENDING') return null;

  if (!approve) {
    await db.run(
      "UPDATE trainer_attendance SET correction_status = 'REJECTED', updated_at = ? WHERE id = ?",
      [now(), row.id]);
    const after = await db.q1('SELECT * FROM trainer_attendance WHERE id = ?', [row.id]);
    await audit(db, { orgId, attendanceId: row.id, actorId, action: 'CORRECTION_REJECTED', before: row, after });
    return after;
  }

  const checkInIso = row.correction_check_in || row.check_in;
  const checkOutIso = row.correction_check_out || row.check_out;
  const policy = await getPolicy(db, orgId);
  const shift = { start: row.scheduled_start, end: row.scheduled_end };
  const { status, lateMinutes } = checkInIso
    ? classifyCheckIn({ checkInIso, shift, graceMinutes: policy.graceMinutes, tz })
    : { status: row.status, lateMinutes: row.late_minutes };
  const worked = checkInIso && checkOutIso ? minutesBetween(checkInIso, checkOutIso) : null;

  await db.run(
    `UPDATE trainer_attendance
        SET check_in = ?, check_out = ?, status = ?, late_minutes = ?, worked_minutes = ?,
            source = 'CORRECTION', correction_status = 'APPROVED', updated_at = ?
      WHERE id = ?`,
    [checkInIso, checkOutIso, status, lateMinutes, worked, now(), row.id]);
  const after = await db.q1('SELECT * FROM trainer_attendance WHERE id = ?', [row.id]);
  await audit(db, { orgId, attendanceId: row.id, actorId, action: 'CORRECTION_APPROVED', before: row, after });
  return after;
}

/** Owner writing or fixing a record directly. Always audited, always
 *  labelled OWNER_MANUAL, so a row nobody stood at the door for is never
 *  mistaken for one somebody did. */
export async function ownerSet(db, {
  orgId, trainerId, date, actorId, tz, status, checkIn, checkOut, note, reason,
}) {
  let row = await getDay(db, { orgId, trainerId, date });
  const shift = await shiftFor(db, { orgId, trainerId, date });
  if (!row) {
    const aid = id('tat');
    await db.run(
      `INSERT INTO trainer_attendance
         (id, org_id, trainer_id, date, scheduled_start, scheduled_end, status, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'OWNER_MANUAL',?,?)`,
      [aid, orgId, trainerId, date, shift?.start || null, shift?.end || null,
       status || 'PRESENT', now(), now()]);
    row = await getDay(db, { orgId, trainerId, date });
  }
  const before = { ...row };

  const nextIn = checkIn !== undefined ? checkIn : row.check_in;
  const nextOut = checkOut !== undefined ? checkOut : row.check_out;
  const policy = await getPolicy(db, orgId);
  let nextStatus = status || row.status;
  let late = row.late_minutes;
  // An explicit status (LEAVE, OFF_DAY) is the owner's decision and is
  // not second-guessed. Only a plain time edit re-derives punctuality.
  if (!status && nextIn) {
    const c = classifyCheckIn({ checkInIso: nextIn, shift, graceMinutes: policy.graceMinutes, tz });
    nextStatus = c.status; late = c.lateMinutes;
  }
  const worked = nextIn && nextOut ? minutesBetween(nextIn, nextOut) : null;

  await db.run(
    `UPDATE trainer_attendance
        SET check_in = ?, check_out = ?, status = ?, late_minutes = ?, worked_minutes = ?,
            note = ?, source = 'OWNER_MANUAL', updated_at = ?
      WHERE id = ?`,
    [nextIn || null, nextOut || null, nextStatus, late, worked,
     note !== undefined ? note : row.note, now(), row.id]);
  const after = await getDay(db, { orgId, trainerId, date });
  await audit(db, { orgId, attendanceId: row.id, actorId, action: 'OWNER_EDIT', before, after, reason });
  return after;
}

/* ---------- reads ---------- */

/** Every trainer at the gym with their state for one date. Drives the
 *  owner's operational table, so it includes trainers with NO record --
 *  the ones who have not arrived are exactly who an owner is looking for. */
export async function dayRoster(db, { orgId, date, tz }) {
  const policy = await getPolicy(db, orgId);
  const today = todayKey(tz);
  const nowMinutes = localMinutes(now(), tz);
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();

  const [trainers, rows, shifts] = await Promise.all([
    db.q(`SELECT t.user_id, u.name, u.avatar FROM trainers t
            JOIN users u ON u.id = t.user_id
           WHERE t.org_id = ? AND u.active = 1 ORDER BY u.name`, [orgId]),
    db.q('SELECT * FROM trainer_attendance WHERE org_id = ? AND date = ?', [orgId, date]),
    db.q(`SELECT trainer_id, start_time, end_time FROM trainer_shifts
           WHERE org_id = ? AND day_of_week = ? AND active = 1`, [orgId, dow]),
  ]);

  const byTrainer = new Map(rows.map((r) => [r.trainer_id, r]));
  const shiftBy = new Map(shifts.map((s) => [s.trainer_id, { start: s.start_time, end: s.end_time }]));

  return trainers.map((t) => {
    const row = byTrainer.get(t.user_id) || null;
    const shift = shiftBy.get(t.user_id) || null;
    const status = resolveDayStatus({
      row, shift, mode: policy.mode, date, today, nowMinutes, graceMinutes: policy.graceMinutes,
    });
    return {
      trainerId: t.user_id,
      name: t.name,
      avatar: t.avatar || null,
      scheduled: shift,
      status,
      checkIn: row?.check_in || null,
      checkOut: row?.check_out || null,
      lateMinutes: int(row?.late_minutes),
      workedMinutes: row?.worked_minutes == null ? null : int(row.worked_minutes),
      source: row?.source || null,
      correctionStatus: row?.correction_status || null,
      attendanceId: row?.id || null,
      note: row?.note || null,
    };
  });
}

/** Headline counts for the owner's attendance card. Every figure is a
 *  count of real rows or real shifts -- there is no estimated total. */
export function summarise(roster) {
  const count = (fn) => roster.filter(fn).length;
  return {
    trainers: roster.length,
    scheduled: count((r) => !!r.scheduled),
    present: count((r) => r.status === 'PRESENT'),
    late: count((r) => r.status === 'LATE'),
    absent: count((r) => r.status === 'ABSENT'),
    leave: count((r) => r.status === 'LEAVE'),
    offDay: count((r) => r.status === 'OFF_DAY'),
    missingCheckout: count((r) => r.status === 'MISSING_CHECKOUT'),
    pendingCorrections: count((r) => r.correctionStatus === 'PENDING'),
    notCheckedIn: count((r) => r.status === 'NOT_CHECKED_IN' || r.status === 'PENDING'),
  };
}

/** One trainer's records over a range, newest first, plus totals. */
export async function trainerHistory(db, { orgId, trainerId, start, end }) {
  const rows = await db.q(
    `SELECT * FROM trainer_attendance
      WHERE org_id = ? AND trainer_id = ? AND date >= ? AND date <= ?
      ORDER BY date DESC`,
    [orgId, trainerId, start, end]);

  const worked = rows.filter((r) => r.worked_minutes != null);
  const totalMinutes = worked.reduce((s, r) => s + int(r.worked_minutes), 0);
  const present = rows.filter((r) => r.status === 'PRESENT' || r.status === 'LATE').length;

  return {
    days: rows.map((r) => ({
      id: r.id,
      date: r.date,
      status: r.status,
      scheduled: r.scheduled_start ? { start: r.scheduled_start, end: r.scheduled_end } : null,
      checkIn: r.check_in,
      checkOut: r.check_out,
      lateMinutes: int(r.late_minutes),
      workedMinutes: r.worked_minutes == null ? null : int(r.worked_minutes),
      source: r.source,
      correctionStatus: r.correction_status || null,
      correctionReason: r.correction_reason || null,
      note: r.note || null,
    })),
    summary: {
      recorded: rows.length,
      present,
      late: rows.filter((r) => r.status === 'LATE').length,
      leave: rows.filter((r) => r.status === 'LEAVE').length,
      missingCheckout: rows.filter((r) => r.status === 'MISSING_CHECKOUT').length,
      // Averages need something to average. Reporting "0h 0m average" off
      // one record is worse than reporting nothing.
      totalMinutes,
      averageMinutes: worked.length >= 2 ? Math.round(totalMinutes / worked.length) : null,
    },
  };
}

/** Pending correction requests across the gym -- the owner's queue. */
export async function pendingCorrections(db, orgId) {
  const rows = await db.q(
    `SELECT a.*, u.name AS trainer_name FROM trainer_attendance a
       JOIN users u ON u.id = a.trainer_id
      WHERE a.org_id = ? AND a.correction_status = 'PENDING'
      ORDER BY a.date DESC`, [orgId]);
  return rows.map((r) => ({
    id: r.id,
    trainerId: r.trainer_id,
    trainerName: r.trainer_name,
    date: r.date,
    currentCheckIn: r.check_in,
    currentCheckOut: r.check_out,
    requestedCheckIn: r.correction_check_in,
    requestedCheckOut: r.correction_check_out,
    reason: r.correction_reason,
  }));
}

export { dayKey };
