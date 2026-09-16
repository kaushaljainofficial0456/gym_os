// ============================================================
// DEMO SESSION ENGINE -- the single authority on "is this demo still
// alive", and the only place that answer is ever computed.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the clock is the SERVER'S. The
// frontend's countdown is a rendering of expires_at, nothing more --
// it is not consulted, not trusted, and cannot be negotiated with.
// Every demo-authenticated API request re-reads the session row and
// re-checks it against the server's own clock (see auth.js's
// requireAuth, which calls enforceSession below), so:
//
//   * refreshing the page              -> started_at is already set; untouched
//   * opening a second tab             -> same row, same expires_at
//   * closing and reopening the browser-> same row, same expires_at
//   * changing the device clock        -> never read; Date.now() here is the server's
//   * clearing localStorage            -> holds no timer state to clear
//   * editing the frontend JS          -> cannot reach past this check
//   * forging a JWT                    -> fails signature verification first (auth.js)
//   * replaying an old demo JWT        -> the row it names is already 'expired'
//
// None of those are handled by special cases. They all reduce to the
// same thing: the only durable record of when this demo ends is a
// database row the client cannot write to.
// ============================================================
import { createHash, randomBytes } from 'node:crypto';
import { id, now } from '../../ids.js';

/** Spec-mandated demo length. Stored per-session (demo_sessions.
 *  duration_minutes) rather than read from here at check time, so a
 *  session that was approved under one policy keeps its own length even
 *  if this constant later changes. */
export const DEMO_DURATION_MINUTES = 30;

/** How stale last_activity_at is allowed to get before a request
 *  refreshes it. Every demo request would otherwise issue an UPDATE --
 *  a write per request, on every request, purely for a founder-facing
 *  "last seen" readout. A minute's resolution is more than the admin UI
 *  can meaningfully show, and it keeps the demo off the write path. */
const ACTIVITY_WRITE_THROTTLE_MS = 60_000;

/** Mint a fresh access token. 32 bytes of CSPRNG entropy -- not an id(),
 *  not a uuid, not anything derived from a database key: the URL this
 *  ends up in is the entire credential, so it must be unguessable by
 *  construction rather than by obscurity. base64url so it survives a
 *  WhatsApp message, an email client's link detection, and a copy-paste
 *  without escaping. */
export function newAccessToken() {
  return randomBytes(32).toString('base64url');
}

/** What actually goes in the database. The raw token is shown to the
 *  founder exactly once (the approve / re-issue response) and is
 *  unrecoverable afterwards -- a leaked database backup therefore leaks
 *  no working demo links. SHA-256 with no salt is correct here and not
 *  an oversight: this is a 256-bit random secret, not a password, so
 *  there is no dictionary to stretch against, and an unsalted digest is
 *  what makes the O(1) lookup-by-hash below possible. Same posture as
 *  account_tokens and enrollment_tokens elsewhere in this codebase. */
export function hashToken(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

/** ---- THE DECISION, as a pure function ----
 *  Given a session row and a moment in time, is this demo usable?
 *  Deliberately pure (no db, no Date.now()) so the boundary cases the
 *  spec calls out -- 29:59 active, 00:01 active, 00:00 expired -- are
 *  testable as arithmetic rather than by sleeping through a real
 *  half-hour. Every caller in this file funnels through it, so there is
 *  exactly one definition of "expired" in the system.
 *
 *  Returns { ok, reason, remainingMs, state }:
 *    reason 'ok'          -- running, remainingMs > 0
 *    reason 'not_started' -- approved, link issued, prospect hasn't
 *                            clicked Start yet. NOT an error: this is
 *                            the pre-demo screen's normal state, and the
 *                            reason approving does not start the clock.
 *    reason 'expired' | 'revoked' | 'completed' -- terminal.
 */
export function evaluateSession(session, nowMs = Date.now()) {
  if (!session) return { ok: false, reason: 'not_found', remainingMs: 0, state: 'not_found' };
  if (session.status === 'revoked') return { ok: false, reason: 'revoked', remainingMs: 0, state: 'revoked' };
  if (session.status === 'completed') return { ok: false, reason: 'completed', remainingMs: 0, state: 'completed' };
  if (session.status === 'expired') return { ok: false, reason: 'expired', remainingMs: 0, state: 'expired' };
  if (!session.started_at || !session.expires_at) {
    return { ok: false, reason: 'not_started', remainingMs: null, state: 'approved' };
  }
  const expiresMs = Date.parse(session.expires_at);
  // An unparseable expires_at is a corrupt row, and the safe reading of a
  // corrupt time-box is "over", never "unlimited".
  if (!Number.isFinite(expiresMs)) return { ok: false, reason: 'expired', remainingMs: 0, state: 'expired' };
  const remainingMs = expiresMs - nowMs;
  // `<= 0`, so the exact instant of expiry is already expired -- the spec
  // asks for 00:00 to be over, not for one more millisecond of grace.
  if (remainingMs <= 0) return { ok: false, reason: 'expired', remainingMs: 0, state: 'expired' };
  return { ok: true, reason: 'ok', remainingMs, state: 'active' };
}

/** Compute a session's expiry from a start instant. The one place the
 *  arithmetic lives, so the value written at Start and any value
 *  recomputed later can never disagree. */
export function expiryFor(startedAtIso, durationMinutes = DEMO_DURATION_MINUTES) {
  return new Date(Date.parse(startedAtIso) + durationMinutes * 60_000).toISOString();
}

export async function findSessionById(db, sessionId) {
  if (!sessionId) return null;
  return db.q1('SELECT * FROM demo_sessions WHERE id = ?', [sessionId]);
}

/** Look a session up by the RAW token from the URL. The lookup is by
 *  hash, so the raw token is never compared against anything stored and
 *  never has to be. An unknown token is indistinguishable from a
 *  well-formed one that simply does not exist -- both return null. */
export async function findSessionByToken(db, rawToken) {
  const raw = String(rawToken || '');
  // Cheap shape gate before touching the database: a 32-byte base64url
  // token is 43 characters, so anything else cannot be one of ours and
  // does not deserve a query.
  if (raw.length < 20 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  return db.q1('SELECT * FROM demo_sessions WHERE access_token_hash = ?', [hashToken(raw)]);
}

/** Mark a session terminal and mirror the outcome onto its request row,
 *  so the founder's list reads correctly from one query. Idempotent. */
export async function closeSession(db, session, status, { at = now() } = {}) {
  const stamp = status === 'expired' ? 'expires_at' : status === 'completed' ? 'completed_at' : 'revoked_at';
  await db.run(
    `UPDATE demo_sessions SET status = ?, ${stamp} = COALESCE(${stamp}, ?), updated_at = ? WHERE id = ?`,
    [status, at, at, session.id]);
  await db.run(
    'UPDATE demo_requests SET status = ?, updated_at = ? WHERE id = ?',
    [status, at, session.demo_request_id]);
}

/** ---- THE REQUEST-TIME GATE ----
 *  Called by requireAuth for every single request carrying a demo token
 *  (auth.js), and directly by the demo routes. Re-reads the row, applies
 *  evaluateSession, and -- this is the part that makes expiry stick --
 *  writes the terminal status back the first time a live session is
 *  found to be over, so it is expired for every other tab, device and
 *  future request too, not just for this one.
 *
 *  Never throws: a database hiccup must fail CLOSED here (the demo stops
 *  working) rather than open. This is the opposite of the tz/billing
 *  lookups in auth.js, which fail open deliberately -- those degrade a
 *  real customer's session, this one is the whole security boundary. */
export async function enforceSession(db, sessionId, nowMs = Date.now()) {
  let session;
  try {
    session = await findSessionById(db, sessionId);
  } catch {
    return { ok: false, reason: 'unavailable', remainingMs: 0, state: 'unavailable', session: null };
  }
  const verdict = evaluateSession(session, nowMs);
  // A session whose clock has run out but whose row still says 'active'
  // is the ordinary case (nothing sweeps these -- there is no scheduler
  // on a serverless deployment); the first request to notice closes it.
  if (!verdict.ok && verdict.reason === 'expired' && session && session.status === 'active') {
    try { await closeSession(db, session, 'expired', { at: new Date(nowMs).toISOString() }); } catch { /* the verdict already stands; persisting it is best-effort */ }
  }
  return { ...verdict, session: session || null };
}

/** Refresh last_activity_at, at most once a minute per session. Fully
 *  best-effort and never awaited on the request path's critical section:
 *  this exists for the founder's activity readout, and no demo should
 *  ever fail because a bookkeeping write did. */
export async function touchSession(db, session, nowMs = Date.now()) {
  if (!session) return;
  const last = session.last_activity_at ? Date.parse(session.last_activity_at) : 0;
  if (Number.isFinite(last) && nowMs - last < ACTIVITY_WRITE_THROTTLE_MS) return;
  const iso = new Date(nowMs).toISOString();
  try {
    await db.run('UPDATE demo_sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?', [iso, iso, session.id]);
  } catch { /* bookkeeping only */ }
}

/** The demo's own analytics trail (spec 24). Reuses the demo_events
 *  table rather than the platform `events` table because a demo event
 *  belongs to a SESSION, not to an org/user pair -- and because mixing
 *  prospect telemetry into the table that also records server_error rows
 *  would make both harder to read. Best-effort: analytics must never be
 *  able to fail a product action. */
export async function trackDemoEvent(db, sessionId, type, data = null) {
  if (!sessionId || !type) return;
  try {
    await db.run(
      'INSERT INTO demo_events (id, session_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [id('dev'), sessionId, String(type).slice(0, 64), data ? JSON.stringify(data).slice(0, 2000) : null, now()]);
  } catch { /* analytics is never load-bearing */ }
}

/** Thrown when a demo session tries to reach the real payment gateway.
 *  Carries a `code` the API error handler can turn into a clean 4xx
 *  instead of a 500 (see index.js's error handler). */
export class DemoPaymentBlockedError extends Error {
  constructor(action) {
    super(`Demo tenants cannot ${action}.`);
    this.name = 'DemoPaymentBlockedError';
    this.code = 'demo_payment_blocked';
    this.status = 403;
  }
}

/** Refuse anything that would reach a real payment provider on behalf of a
 *  DEMO TENANT.
 *
 *  A demo prospect signs in as the demo gym's OWNER, and an owner's
 *  product legitimately includes the Enterprise billing screens -- so
 *  "Upgrade your plan" is two clicks from the dashboard we hand them. In
 *  production that reaches Razorpay and creates a REAL payment order
 *  against a real merchant account, from a stranger evaluating the
 *  software. A refund on a seeded payment is the same problem pointed the
 *  other way: an outbound call about a gateway payment that never existed.
 *
 *  Guarded HERE, at the two service functions every payment path funnels
 *  through, rather than on a list of route prefixes -- a route list is a
 *  thing to keep in sync, and the next payment route somebody adds would
 *  not be on it. Everything else about billing stays fully explorable:
 *  the demo owner can still see packages, prices, invoices, their
 *  subscription and their members' payment history, because all of that
 *  is reading rows, not moving money.
 *
 *  Fails OPEN on a lookup error, matching isDemoOrgCached in auth.js: a
 *  database blip must not start refusing real customers' payments, and
 *  the demo tenant is only reachable through a live demo session anyway. */
export async function assertNotDemoOrg(db, orgId, action) {
  if (!orgId) return;
  let isDemo = false;
  try {
    const row = await db.q1('SELECT is_demo FROM organizations WHERE id = ?', [orgId]);
    isDemo = row ? !!Number(row.is_demo) : false;
  } catch {
    isDemo = false;
  }
  if (isDemo) throw new DemoPaymentBlockedError(action);
}

/** The event names the demo emits. Listed explicitly so the founder
 *  dashboard's "features visited" can be rendered from a known set
 *  instead of whatever strings happened to arrive, and so a typo in a
 *  caller shows up as a missing feature rather than a new one. */
export const DEMO_EVENT_TYPES = Object.freeze([
  'demo_started', 'dashboard_viewed', 'members_viewed', 'member_profile_viewed',
  'trainer_viewed', 'workout_viewed', 'workout_created', 'nutrition_viewed',
  'nutrition_created', 'community_viewed', 'community_post_created',
  'leaderboard_viewed', 'attendance_viewed', 'progress_viewed',
  'member_mode_entered', 'trainer_mode_entered', 'owner_mode_entered',
  'demo_expired', 'demo_completed', 'cta_clicked',
]);

/** Human labels for the founder's "features visited" list. */
export const DEMO_FEATURE_LABELS = Object.freeze({
  dashboard_viewed: 'Dashboard', members_viewed: 'Members',
  member_profile_viewed: 'Member profile', trainer_viewed: 'Trainers',
  workout_viewed: 'Workouts', workout_created: 'Workout created',
  nutrition_viewed: 'Nutrition', nutrition_created: 'Nutrition plan created',
  community_viewed: 'Community', community_post_created: 'Community post',
  leaderboard_viewed: 'Leaderboard', attendance_viewed: 'Attendance',
  progress_viewed: 'Progress',
});

/** Shape a session row for a client response. Deliberately narrow: the
 *  prospect's browser gets the two timestamps it needs to render a
 *  countdown and nothing else -- no session id, no token, no request id,
 *  no org id. */
export function publicSessionView(session, nowMs = Date.now()) {
  const verdict = evaluateSession(session, nowMs);
  return {
    state: verdict.state,
    startedAt: session?.started_at || null,
    expiresAt: session?.expires_at || null,
    remainingMs: verdict.remainingMs,
    durationMinutes: Number(session?.duration_minutes || DEMO_DURATION_MINUTES),
    // The server's own clock, sent alongside expiresAt so the frontend can
    // render a countdown from the DIFFERENCE of two server timestamps
    // rather than from the device clock -- a phone an hour fast would
    // otherwise show a wrong number (the demo would still end at exactly
    // the right moment either way; this is about the display not lying).
    serverTime: new Date(nowMs).toISOString(),
  };
}
