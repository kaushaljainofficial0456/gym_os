// ============================================================
// TRAINER ATTENDANCE API
//
// PERMISSION SHAPE, which is the whole security model here:
//
//   A trainer may check IN and OUT as themselves, and may REQUEST a
//   correction. They may read their own history. That is all.
//
//   An owner may read the whole gym's attendance, write or fix any
//   record, approve/reject corrections, and configure shifts and policy.
//
//   Nobody may touch another gym. org comes from the authenticated
//   session via orgScope -- never from the request body -- and every
//   trainer id is verified to belong to THIS gym before it is written.
//
// The QR is a short-lived SIGNED token, not a row: the gym displays a
// code on a screen and many trainers scan the same one, so a single-use
// table row (the shape enrollment_tokens uses) would be wrong. Replay is
// prevented by attendance state instead -- a second scan finds today's
// check-in already there and changes nothing.
// ============================================================
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAuth, orgScope } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { config } from '../config.js';
import { todayKey, dayKey } from '../utils/time.js';
import {
  getPolicy, setPolicy, isGymTrainer, listShifts, setShift, removeShift,
  checkIn, checkOut, getDay, shiftFor, dayRoster, summarise, trainerHistory,
  requestCorrection, resolveCorrection, ownerSet, pendingCorrections,
  flagMissingCheckouts, auditFor,
} from '../services/trainerAttendance.js';

const QR_TTL_SECONDS = 90;   // the code on the wall rotates; a photo of it dies fast

/* TWO CODES, NOT ONE.
   Arriving and leaving are displayed as separate codes, and each only
   works for its own action. With a single code the same scan could serve
   either end of the day, so a trainer who scanned once on the way out had
   their arrival recorded, and worked-minutes came from whatever the app
   guessed rather than from two observed events. Scanning the IN code
   cannot check you out, and scanning the OUT code cannot check you in --
   so a recorded duration is always bounded by two scans that actually
   happened at the gym.

   'TRAINER_ATTENDANCE' is still accepted by verifyQr so codes already on
   a gym display keep working through the rollout, but it is no longer
   issued and it satisfies neither purpose check below. */
const QR_PURPOSES = { IN: 'TRAINER_IN', OUT: 'TRAINER_OUT' };
const QR_LEGACY = 'TRAINER_ATTENDANCE';

function signQr(orgId, purpose = 'IN', expSeconds = QR_TTL_SECONDS) {
  const payload = {
    o: orgId,
    p: QR_PURPOSES[purpose] || QR_PURPOSES.IN,
    e: Math.floor(Date.now() / 1000) + expSeconds,
    n: crypto.randomBytes(6).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyQr(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', config.jwtSecret).update(body).digest('base64url');
  // timingSafeEqual throws on length mismatch, which is itself a signal.
  const a = Buffer.from(sig); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  const known = [QR_PURPOSES.IN, QR_PURPOSES.OUT, QR_LEGACY];
  if (!known.includes(payload.p)) return null;
  if (!payload.e || payload.e < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Shared gate for both ends of the day. Returns null when the scan is
 *  acceptable, or a {status, body} to send back. */
function qrGate({ token, orgId, policy, want }) {
  if (!token) {
    if (!policy.requireQr) return null;
    return { status: 422, body: {
      error: want === 'OUT'
        ? 'Scan the gym check-out code to record when you left.'
        : 'Scan the gym check-in code to record your attendance.',
      code: 'QR_REQUIRED',
    } };
  }
  const payload = verifyQr(token);
  // One message for expired and tampered alike -- the difference only
  // helps someone probing the signature, and "get a fresh one" is the
  // right action either way.
  if (!payload) return { status: 422, body: { error: "That code isn't valid any more. Ask for a fresh one." } };
  if (payload.o !== orgId) return { status: 403, body: { error: 'That code belongs to a different gym' } };
  // Scanning the wrong one is an ordinary mistake at a busy door, so it
  // says which code to look for instead of just refusing.
  if (payload.p === QR_PURPOSES.IN && want === 'OUT') {
    return { status: 422, body: { error: "That's the check-in code — scan the check-out code to leave." } };
  }
  if (payload.p === QR_PURPOSES.OUT && want === 'IN') {
    return { status: 422, body: { error: "That's the check-out code — scan the check-in code to start." } };
  }
  return null;
}

export default function attendanceRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);

  const writeLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });

  const isOwner = (req) => ['GYM_OWNER', 'SUPER_ADMIN'].includes(req.user.role);
  const ownerOnly = (req, res, next) => {
    if (!isOwner(req)) return res.status(403).json({ error: 'Gym owner access only' });
    return next();
  };

  /* ---------------- trainer: my attendance ---------------- */

  // Today's state plus the shift, which is what the trainer's home card
  // needs to decide between "Check in" and "Check out".
  r.get('/me/today', async (req, res) => {
    if (req.user.role !== 'TRAINER' && !isOwner(req)) {
      return res.status(403).json({ error: 'Trainer access only' });
    }
    const date = todayKey(req.tz);
    const [row, shift, policy] = await Promise.all([
      getDay(db, { orgId: req.orgId, trainerId: req.user.sub, date }),
      shiftFor(db, { orgId: req.orgId, trainerId: req.user.sub, date }),
      getPolicy(db, req.orgId),
    ]);
    res.json({
      date,
      policy,
      scheduled: shift,
      attendance: row ? {
        id: row.id,
        status: row.status,
        checkIn: row.check_in,
        checkOut: row.check_out,
        lateMinutes: row.late_minutes,
        workedMinutes: row.worked_minutes,
        source: row.source,
        correctionStatus: row.correction_status || null,
      } : null,
    });
  });

  r.post('/me/check-in', writeLimit, validate(z.object({
    qr: z.string().max(400).optional(),
  })), async (req, res) => {
    if (req.user.role !== 'TRAINER') {
      return res.status(403).json({ error: 'Only trainers record attendance' });
    }
    // Membership is re-checked on every write: a removed trainer keeps a
    // valid JWT until it expires, and the token alone is not evidence
    // they still work here.
    if (!(await isGymTrainer(db, req.orgId, req.user.sub))) {
      return res.status(403).json({ error: 'You are not a trainer at this gym' });
    }

    /* THE CODE IS THE POINT.
       This used to accept a check-in with no code at all -- `qr` was
       optional, so tapping the button recorded attendance from anywhere
       and the rotating code on the wall guarded nothing. Enforced HERE
       rather than by hiding a button: a client-side gate stops nobody
       who can open a network tab. */
    const policy = await getPolicy(db, req.orgId);
    const denied = qrGate({ token: req.body.qr, orgId: req.orgId, policy, want: 'IN' });
    if (denied) return res.status(denied.status).json(denied.body);

    const source = req.body.qr ? 'GYM_QR' : 'TRAINER_SELF';
    const out = await checkIn(db, { orgId: req.orgId, trainerId: req.user.sub, tz: req.tz, source });
    res.json(out);
  });

  /* Check-out took no body and no code at all, so the DURATION -- the
     only number this feature exists to produce -- was anchored by one
     observed event and one unobserved one. A trainer could scan in at the
     gym and check out from home three hours later, and the timesheet
     would show three extra hours with nothing to contradict it. Leaving
     is now evidenced the same way arriving is. */
  r.post('/me/check-out', writeLimit, validate(z.object({
    qr: z.string().max(400).optional(),
  })), async (req, res) => {
    if (req.user.role !== 'TRAINER') {
      return res.status(403).json({ error: 'Only trainers record attendance' });
    }
    if (!(await isGymTrainer(db, req.orgId, req.user.sub))) {
      return res.status(403).json({ error: 'You are not a trainer at this gym' });
    }
    const policy = await getPolicy(db, req.orgId);
    const denied = qrGate({ token: req.body.qr, orgId: req.orgId, policy, want: 'OUT' });
    if (denied) return res.status(denied.status).json(denied.body);

    const out = await checkOut(db, { orgId: req.orgId, trainerId: req.user.sub, tz: req.tz });
    if (!out.ok) return res.status(422).json({ error: "You haven't checked in today" });
    res.json(out);
  });

  r.get('/me/history', async (req, res) => {
    if (req.user.role !== 'TRAINER' && !isOwner(req)) {
      return res.status(403).json({ error: 'Trainer access only' });
    }
    const end = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') ? req.query.end : todayKey(req.tz);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '')
      ? req.query.start
      : dayKey(new Date(Date.now() - 29 * 86400000), req.tz);
    const out = await trainerHistory(db, { orgId: req.orgId, trainerId: req.user.sub, start, end });
    res.json({ start, end, ...out });
  });

  // A trainer ASKS; it does not take effect until an owner approves. A
  // self-service edit of your own hours is not attendance, it is a form.
  r.post('/me/corrections', writeLimit, validate(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    check_in: z.string().max(40).optional(),
    check_out: z.string().max(40).optional(),
    reason: z.string().min(1).max(300),
  })), async (req, res) => {
    if (req.user.role !== 'TRAINER') {
      return res.status(403).json({ error: 'Only trainers request corrections' });
    }
    if (req.body.date > todayKey(req.tz)) {
      return res.status(422).json({ error: 'You cannot record attendance for a future date' });
    }
    const row = await requestCorrection(db, {
      orgId: req.orgId, trainerId: req.user.sub, date: req.body.date,
      checkIn: req.body.check_in, checkOut: req.body.check_out, reason: req.body.reason,
    });
    res.status(201).json({ ok: true, attendance: { id: row.id, correctionStatus: row.correction_status } });
  });

  /* ---------------- owner ---------------- */

  r.get('/roster', ownerOnly, async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayKey(req.tz);
    // Sweep stale open shifts before reading, so "missing checkout" is
    // current rather than whatever it was when someone last looked.
    await flagMissingCheckouts(db, { orgId: req.orgId, tz: req.tz });
    const roster = await dayRoster(db, { orgId: req.orgId, date, tz: req.tz });
    res.json({ date, roster, summary: summarise(roster), policy: await getPolicy(db, req.orgId) });
  });

  r.get('/corrections', ownerOnly, async (req, res) => {
    res.json({ corrections: await pendingCorrections(db, req.orgId) });
  });

  r.post('/corrections/:id/:decision', writeLimit, ownerOnly, async (req, res) => {
    const { decision } = req.params;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(422).json({ error: 'Unknown decision' });
    }
    const row = await resolveCorrection(db, {
      orgId: req.orgId, attendanceId: req.params.id, actorId: req.user.sub,
      approve: decision === 'approve', tz: req.tz,
    });
    if (!row) return res.status(404).json({ error: 'No pending correction for that record' });
    res.json({ ok: true, status: row.status, correctionStatus: row.correction_status });
  });

  r.put('/records', writeLimit, ownerOnly, validate(z.object({
    trainer_id: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.enum(['PRESENT', 'LATE', 'ABSENT', 'LEAVE', 'OFF_DAY', 'MISSING_CHECKOUT']).optional(),
    check_in: z.string().max(40).nullable().optional(),
    check_out: z.string().max(40).nullable().optional(),
    note: z.string().max(300).optional(),
    reason: z.string().max(300).optional(),
  })), async (req, res) => {
    // The trainer id arrives from the client, so it is verified against
    // THIS gym before anything is written to it.
    if (!(await isGymTrainer(db, req.orgId, req.body.trainer_id))) {
      return res.status(404).json({ error: 'Not a trainer at this gym' });
    }
    if (req.body.date > todayKey(req.tz)) {
      return res.status(422).json({ error: 'You cannot record attendance for a future date' });
    }
    const row = await ownerSet(db, {
      orgId: req.orgId, trainerId: req.body.trainer_id, date: req.body.date,
      actorId: req.user.sub, tz: req.tz,
      status: req.body.status, checkIn: req.body.check_in, checkOut: req.body.check_out,
      note: req.body.note, reason: req.body.reason,
    });
    res.json({ ok: true, attendance: { id: row.id, status: row.status } });
  });

  r.get('/trainers/:trainerId/history', ownerOnly, async (req, res) => {
    if (!(await isGymTrainer(db, req.orgId, req.params.trainerId))) {
      return res.status(404).json({ error: 'Not a trainer at this gym' });
    }
    const end = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') ? req.query.end : todayKey(req.tz);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '')
      ? req.query.start
      : dayKey(new Date(Date.now() - 29 * 86400000), req.tz);
    const [history, shifts] = await Promise.all([
      trainerHistory(db, { orgId: req.orgId, trainerId: req.params.trainerId, start, end }),
      listShifts(db, { orgId: req.orgId, trainerId: req.params.trainerId }),
    ]);
    res.json({ start, end, shifts, ...history });
  });

  r.get('/records/:id/audit', ownerOnly, async (req, res) => {
    res.json({ audit: await auditFor(db, { orgId: req.orgId, attendanceId: req.params.id }) });
  });

  /* ---------------- shifts + policy ---------------- */

  r.get('/shifts/:trainerId', ownerOnly, async (req, res) => {
    if (!(await isGymTrainer(db, req.orgId, req.params.trainerId))) {
      return res.status(404).json({ error: 'Not a trainer at this gym' });
    }
    res.json({ shifts: await listShifts(db, { orgId: req.orgId, trainerId: req.params.trainerId }) });
  });

  r.put('/shifts/:trainerId', writeLimit, ownerOnly, validate(z.object({
    day_of_week: z.number().int().min(0).max(6),
    start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    active: z.boolean().optional(),
  })), async (req, res) => {
    if (!(await isGymTrainer(db, req.orgId, req.params.trainerId))) {
      return res.status(404).json({ error: 'Not a trainer at this gym' });
    }
    if (req.body.end_time <= req.body.start_time) {
      return res.status(422).json({ error: 'The shift must end after it starts' });
    }
    const out = await setShift(db, {
      orgId: req.orgId, trainerId: req.params.trainerId,
      dayOfWeek: req.body.day_of_week, startTime: req.body.start_time,
      endTime: req.body.end_time, active: req.body.active === false ? 0 : 1,
    });
    res.json({ ok: true, ...out });
  });

  r.delete('/shifts/:trainerId/:dayOfWeek', writeLimit, ownerOnly, async (req, res) => {
    const dow = parseInt(req.params.dayOfWeek, 10);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      return res.status(422).json({ error: 'Invalid day' });
    }
    const removed = await removeShift(db, {
      orgId: req.orgId, trainerId: req.params.trainerId, dayOfWeek: dow,
    });
    if (!removed) return res.status(404).json({ error: 'No shift on that day' });
    res.json({ ok: true });
  });

  r.get('/policy', async (req, res) => {
    res.json(await getPolicy(db, req.orgId));
  });

  r.put('/policy', writeLimit, ownerOnly, validate(z.object({
    mode: z.enum(['simple', 'scheduled']).optional(),
    grace_minutes: z.number().int().min(0).max(120).optional(),
    // Turning the scan requirement off is a deliberate act by the owner,
    // for a gym with no display or a single self-employed trainer. It is
    // never a default, and the resulting rows are marked TRAINER_SELF so
    // a timesheet still says how each entry was captured.
    require_qr: z.boolean().optional(),
  })), async (req, res) => {
    res.json(await setPolicy(db, req.orgId, {
      mode: req.body.mode,
      graceMinutes: req.body.grace_minutes,
      requireQr: req.body.require_qr,
    }));
  });

  /* ---------------- QR ---------------- */

  // The owner displays this. It rotates, so the code is refetched on a
  // timer by the screen showing it.
  r.get('/qr', ownerOnly, (req, res) => {
    // Both codes in one response: the owner screen shows them side by
    // side, and issuing them together keeps their countdowns in step so
    // one cannot silently be stale while the other looks fine.
    res.json({
      in: signQr(req.orgId, 'IN'),
      out: signQr(req.orgId, 'OUT'),
      expiresIn: QR_TTL_SECONDS,
      // Kept so an older client that reads `token` still shows a usable
      // check-in code rather than a blank dialog.
      token: signQr(req.orgId, 'IN'),
    });
  });

  return r;
}

export { signQr, verifyQr, QR_TTL_SECONDS };
