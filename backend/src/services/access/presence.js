// ============================================================
// PRESENCE — turning door events into "who is inside".
//
// THE STATE MACHINE IS THE PRODUCT. Everything downstream -- the member's
// crowd card, the owner dashboard, attendance, capacity alerts -- is a
// count of open sessions, so every way a real door lies has to be handled
// here rather than papered over in a query:
//
//   OUTSIDE --ENTRY--> INSIDE --EXIT--> OUTSIDE
//
//   * A second ENTRY while already inside does not add a second person.
//     People scan twice when a door is slow.
//   * An EXIT with nobody inside does not subtract one. Occupancy can
//     therefore never go negative -- not because it is clamped, but
//     because there is no row to close.
//   * DENIED never counts. A refused card is someone who did NOT come in.
//   * Late events are ordered by occurred_at, the DOOR's clock. A device
//     that was offline all morning and uploads at 6pm must not stack its
//     backlog on top of this evening.
//   * Every event is idempotent on (org, provider, external_event_id).
//     Providers retry; a retry must not move the count.
//
// AT MOST ONE OPEN SESSION PER PERSON PER BRANCH IS A DATABASE
// CONSTRAINT, not a rule this file remembers (see the partial unique
// index in schema.sql). Two concurrent webhooks delivering the same entry
// cannot both win: the second insert fails and is recorded as a
// duplicate. Enforcing that in code alone would leave a race that only
// appears under the load a real gym generates at 6pm.
//
// WHAT IS NEVER HERE: biometric data of any kind. This module sees an
// opaque external id that a mapping row has already resolved to a user,
// a direction, and a timestamp.
// ============================================================
import { randomUUID } from 'node:crypto';

const nowIso = () => new Date().toISOString();

/** A timestamp we are willing to treat as an instant. */
export function parseInstant(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Apply one normalized event to presence state.
 *
 * Returns { outcome, sessionId, affectedOccupancy }, where outcome is one
 * of: 'entered' | 'exited' | 'duplicate_entry' | 'duplicate_exit' |
 * 'denied' | 'unmatched' | 'invalid'.
 *
 * `db` must already be inside a transaction when the caller needs the
 * event row and the session row to land together.
 */
export async function applyAccessEvent(db, event) {
  const {
    id, orgId, branchId = null, userId, clientId = null,
    eventType, occurredAt, isDemo = false,
  } = event;

  const at = parseInstant(occurredAt);
  if (!at) return { outcome: 'invalid', affectedOccupancy: 0, reason: 'unparseable occurred_at' };

  // A refused scan is a real record of someone who did not get in. It is
  // stored (the owner needs to see it) and it moves nothing.
  if (eventType === 'DENIED') return { outcome: 'denied', affectedOccupancy: 0 };

  // No mapping yet: the event is kept for reconciliation rather than
  // dropped, because "who is this?" is answerable later and the gym's own
  // head-count depends on the answer.
  if (!userId) return { outcome: 'unmatched', affectedOccupancy: 0 };

  if (eventType === 'ENTRY') return enter(db, { id, orgId, branchId, userId, clientId, at, isDemo });
  if (eventType === 'EXIT') return exit(db, { id, orgId, branchId, userId, at });
  return { outcome: 'invalid', affectedOccupancy: 0, reason: `unknown event type ${eventType}` };
}

async function openSessionFor(db, { orgId, branchId, userId }) {
  /* branch_id IS NULL has to be matched with IS NULL, not `= ?`. A
     single-branch gym stores null here, and `null = null` is false in
     SQL -- so the naive query finds nothing, every entry opens a new
     session, and the unique index then rejects it. The occupancy would
     have sat at whatever the first scan of the day produced. */
  return branchId == null
    ? db.q1(`SELECT * FROM gym_presence_sessions
              WHERE org_id = ? AND user_id = ? AND branch_id IS NULL AND status = 'OPEN'`, [orgId, userId])
    : db.q1(`SELECT * FROM gym_presence_sessions
              WHERE org_id = ? AND user_id = ? AND branch_id = ? AND status = 'OPEN'`, [orgId, userId, branchId]);
}

async function enter(db, { id, orgId, branchId, userId, clientId, at, isDemo = false }) {
  const open = await openSessionFor(db, { orgId, branchId, userId });
  if (open) {
    /* Already inside. Two readings, and the difference matters:

       A scan seconds after the last one is the same arrival twice -- the
       door did not open, the member pressed again. Nothing changes.

       A scan HOURS later, with no exit in between, means the exit was
       missed. Silently ignoring it would leave the member inside forever
       and inflate the gym's occupancy by one every day. So the stale
       session is closed as reconciled -- with its exit time left unknown
       rather than invented -- and a fresh one opened. */
    const ageMs = Date.parse(at) - Date.parse(open.entered_at);
    if (ageMs < RE_ENTRY_RECONCILE_MS) {
      return { outcome: 'duplicate_entry', sessionId: open.id, affectedOccupancy: 0 };
    }
    await closeSession(db, open, {
      exitedAt: null,
      reason: 'next_entry_reconciliation',
      confidence: 'estimated',
      exitEventId: null,
    });
    // Fall through and open the new one.
  }

  const sessionId = randomUUID();
  const ts = nowIso();
  try {
    await db.run(
      `INSERT INTO gym_presence_sessions
         (id, org_id, branch_id, user_id, client_id, entry_event_id, entered_at, status, confidence, is_demo, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'OPEN','exact',?,?,?)`,
      [sessionId, orgId, branchId, userId, clientId, id || null, at, isDemo ? 1 : 0, ts, ts]);
  } catch (e) {
    /* The unique index fired, which means a concurrent delivery of the
       same arrival won the race. That is the constraint doing its job:
       report it as the duplicate it is rather than as an error. */
    if (isUniqueViolation(e)) {
      const existing = await openSessionFor(db, { orgId, branchId, userId });
      return { outcome: 'duplicate_entry', sessionId: existing?.id, affectedOccupancy: 0 };
    }
    throw e;
  }
  return { outcome: 'entered', sessionId, affectedOccupancy: 1 };
}

async function exit(db, { id, orgId, branchId, userId, at }) {
  const open = await openSessionFor(db, { orgId, branchId, userId });
  // Nobody to let out. Recorded, ignored, and occupancy stays where it is
  // -- this is the case that would otherwise drive the count negative.
  if (!open) return { outcome: 'duplicate_exit', affectedOccupancy: 0 };

  /* An exit stamped BEFORE the entry it would close is a clock problem,
     not a visit. Accepting it would produce a negative duration, which
     then becomes a negative average visit length on the owner dashboard. */
  if (Date.parse(at) < Date.parse(open.entered_at)) {
    return { outcome: 'invalid', sessionId: open.id, affectedOccupancy: 0, reason: 'exit precedes entry' };
  }

  await closeSession(db, open, {
    exitedAt: at,
    reason: 'normal_exit',
    confidence: 'exact',
    exitEventId: id || null,
  });
  return { outcome: 'exited', sessionId: open.id, affectedOccupancy: -1 };
}

/**
 * Close a session.
 *
 * `exitedAt: null` is deliberate and is the honest answer for a
 * reconciled session: we know they left, we do not know when. Writing a
 * plausible-looking timestamp would turn a gap in the data into a fact,
 * and it is the duration figures that would carry the lie forward.
 */
export async function closeSession(db, session, { exitedAt, reason, confidence, exitEventId = null, actorNote = null }) {
  const duration = exitedAt
    ? Math.max(0, Math.round((Date.parse(exitedAt) - Date.parse(session.entered_at)) / 1000))
    : null;
  await db.run(
    `UPDATE gym_presence_sessions
        SET status = 'CLOSED', exited_at = ?, exit_event_id = ?, closure_reason = ?,
            confidence = ?, duration_sec = ?, updated_at = ?
      WHERE id = ? AND status = 'OPEN'`,
    [exitedAt, exitEventId, reason, confidence, duration, nowIso(), session.id]);
  return { closed: true, duration, reason, actorNote };
}

/* A second scan within this window is the same arrival; beyond it, the
   exit was missed. Four hours because a long session is real and a
   re-entry after lunch is also real -- this is the point where "still
   inside since this morning" stops being the likelier explanation. */
export const RE_ENTRY_RECONCILE_MS = 4 * 60 * 60 * 1000;

function isUniqueViolation(e) {
  const msg = String(e?.message || e || '');
  // SQLite and Postgres phrase it differently; both are the same fact.
  return /UNIQUE constraint failed/i.test(msg)
    || /duplicate key value violates unique constraint/i.test(msg)
    || e?.code === '23505';
}

/* ── occupancy ─────────────────────────────────────────────────────────
   A COUNT of open sessions, not a replay. The replay engine in
   services/occupancy.js still serves gyms on the manual check-in path;
   this one serves gyms with a connected access provider, and it stays
   constant-time however large the event log grows. */

/**
 * How many people are inside.
 *
 * DEMO SESSIONS ARE EXCLUDED BY DEFAULT, and that default is the whole
 * point. An owner trying the sandbox generates real presence rows; if
 * those counted, the crowd figure their members check before driving over
 * would include people who do not exist. Demo data never reaches a real
 * member -- so the caller has to ask for it explicitly, and only the
 * owner's own demo panel does.
 */
export async function liveOccupancy(db, orgId, { branchId = null, includeDemo = false } = {}) {
  const demoClause = includeDemo ? '' : ' AND is_demo = 0';
  const row = branchId == null
    ? await db.q1(`SELECT COUNT(*) AS n FROM gym_presence_sessions WHERE org_id = ? AND status = 'OPEN'${demoClause}`, [orgId])
    : await db.q1(`SELECT COUNT(*) AS n FROM gym_presence_sessions WHERE org_id = ? AND branch_id = ? AND status = 'OPEN'${demoClause}`, [orgId, branchId]);
  return Number(row?.n) || 0;
}

/** How many of the people "inside" are simulated. Owner panel only. */
export async function demoOccupancy(db, orgId) {
  const row = await db.q1(
    `SELECT COUNT(*) AS n FROM gym_presence_sessions WHERE org_id = ? AND status = 'OPEN' AND is_demo = 1`, [orgId]);
  return Number(row?.n) || 0;
}

/** Open sessions per branch, for the owner's branch comparison. */
export async function occupancyByBranch(db, orgId, { includeDemo = false } = {}) {
  return db.q(
    `SELECT branch_id, COUNT(*) AS occupancy
       FROM gym_presence_sessions
      WHERE org_id = ? AND status = 'OPEN'${includeDemo ? '' : ' AND is_demo = 0'}
      GROUP BY branch_id`, [orgId]);
}

/* ── reconciliation ────────────────────────────────────────────────────
   People forget to scan out. Left alone, every one of them is counted as
   present forever, and by the end of a month the gym reports a crowd of
   people who went home. */

/** Sessions open longer than the gym plausibly allows. */
export async function staleSessions(db, orgId, { maxHours = 12, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - maxHours * 3600_000).toISOString();
  return db.q(
    `SELECT s.*, u.name AS user_name
       FROM gym_presence_sessions s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.org_id = ? AND s.status = 'OPEN' AND s.entered_at < ?
      ORDER BY s.entered_at`, [orgId, cutoff]);
}

/**
 * Close everything that has been open too long.
 *
 * Returns what it did rather than just a count, because this is the one
 * routine that changes a member's recorded attendance without anyone
 * asking it to, and the owner is entitled to see exactly which sessions
 * it touched.
 */
export async function reconcileStaleSessions(db, orgId, { maxHours = 12, reason = 'auto_closed', now = new Date() } = {}) {
  const stale = await staleSessions(db, orgId, { maxHours, now });
  const closed = [];
  for (const s of stale) {
    // exitedAt null on purpose -- see closeSession. An auto-close knows
    // that they left, never when.
    await closeSession(db, s, { exitedAt: null, reason, confidence: 'estimated' });
    closed.push({ sessionId: s.id, userId: s.user_id, enteredAt: s.entered_at });
  }
  return { closed: closed.length, sessions: closed };
}

export default {
  applyAccessEvent, closeSession, liveOccupancy, demoOccupancy, occupancyByBranch,
  staleSessions, reconcileStaleSessions, parseInstant, RE_ENTRY_RECONCILE_MS,
};
