// ============================================================
// QR ENROLLMENT TOKENS — client + trainer onboarding.
//
// Design: opaque bearer secret + stored hash, the same shape as a
// session token, NOT a signed/JWT-style token that embeds claims. The
// QR encodes ONLY `<row id>.<random secret>` -- no gym id, role, price,
// or membership plan is readable from the QR itself (per spec: "Do NOT
// put sensitive information directly into the QR"). Every one of those
// values is resolved server-side from the `enrollment_tokens` row once
// the id/secret pair is presented and verified -- the QR is a bearer
// credential, nothing more.
//
// The raw secret is NEVER persisted -- only sha256(secret) is stored in
// `token_hash` (UNIQUE), so a database read alone (a backup leak, a
// misconfigured read replica, an SQL-injection read) can never
// reconstruct a still-usable QR. Verification re-hashes the presented
// secret and does a constant-time compare against the stored hash.
//
// Single-use is enforced by an ATOMIC conditional UPDATE
// (`WHERE status = 'AVAILABLE'`), not a read-then-write -- see
// consumeToken() below -- so two simultaneous scans of the same QR can
// only ever have one winner, verified by test/enrollment.test.js's
// concurrent-consumption scenario.
// ============================================================

import crypto from 'node:crypto';
import { id, now } from '../../ids.js';

const SECRET_BYTES = 32; // 256 bits of entropy for the bearer secret
const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes, matches the spec's QR-experience copy ("Expires: 10 minutes")

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false; // crypto.timingSafeEqual throws on length mismatch -- guard first
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generates a new single-use enrollment token row and returns the
 * QR PAYLOAD STRING (`<id>.<secret>`) -- this is the only moment the raw
 * secret ever exists; the caller must encode it into a QR image and
 * never log/store it elsewhere. `membershipPlanId` is CLIENT-purpose
 * only (which package.js membership offer this QR enrolls into);
 * TRAINER-purpose tokens leave it null (trainer capacity is unlimited,
 * see the report's "Trainer capacity" note).
 */
export async function issueEnrollmentToken(db, { orgId, createdBy, purpose, membershipPlanId = null, ttlMs = DEFAULT_TTL_MS }) {
  if (purpose !== 'CLIENT' && purpose !== 'TRAINER') throw new Error(`invalid purpose: ${purpose}`);
  const rowId = id('enr');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const tokenHash = sha256Hex(secret);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await db.run(
    `INSERT INTO enrollment_tokens (id, org_id, created_by, purpose, token_hash, membership_plan_id, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?)`,
    [rowId, orgId, createdBy, purpose, tokenHash, membershipPlanId, expiresAt, now()]);
  return { payload: `${rowId}.${secret}`, id: rowId, expiresAt };
}

/**
 * Looks up and verifies a scanned QR payload WITHOUT consuming it --
 * used by the "preview what you're joining" screen (spec: client sees
 * gym/membership BEFORE paying, trainer sees gym BEFORE joining).
 * Returns { ok: true, token } or { ok: false, reason }. Never throws on
 * a malformed/garbage payload -- a scanner pointed at a random QR is an
 * expected input, not a server error.
 */
export async function verifyEnrollmentToken(db, payload, { expectedPurpose } = {}) {
  const parsed = parsePayload(payload);
  if (!parsed) return { ok: false, reason: 'malformed_token' };
  const row = await db.q1('SELECT * FROM enrollment_tokens WHERE id = ?', [parsed.id]);
  if (!row) return { ok: false, reason: 'not_found' };
  if (!timingSafeEqualHex(sha256Hex(parsed.secret), row.token_hash)) return { ok: false, reason: 'invalid_secret' };
  if (expectedPurpose && row.purpose !== expectedPurpose) return { ok: false, reason: 'wrong_purpose' };
  if (row.status === 'REVOKED') return { ok: false, reason: 'revoked' };
  if (row.status === 'CONSUMED') return { ok: false, reason: 'already_consumed' };
  if (row.status === 'EXPIRED' || Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: 'expired' };
  // Org/owner/package active-state checks happen in the calling route
  // (enrollment.js), which already has to load those rows anyway for
  // the "gym active, package active" business checks the spec requires.
  return { ok: true, token: row };
}

/**
 * Verifies AND atomically consumes a token in one step -- the only path
 * that should ever run at actual enrollment time (as opposed to the
 * preview-only verifyEnrollmentToken above). The UPDATE's own
 * `WHERE status = 'AVAILABLE'` is the race-condition guard: if two
 * requests race for the same token, at most one UPDATE affects a row
 * (`changes === 1`); the loser sees `changes === 0` and is told the
 * token was already consumed, never allowed to proceed as if it won.
 */
export async function consumeEnrollmentToken(db, payload, { expectedPurpose, consumedBy }) {
  const verified = await verifyEnrollmentToken(db, payload, { expectedPurpose });
  if (!verified.ok) return verified;
  const result = await db.run(
    `UPDATE enrollment_tokens SET status = 'CONSUMED', consumed_by = ?, consumed_at = ?
     WHERE id = ? AND status = 'AVAILABLE'`,
    [consumedBy, now(), verified.token.id]);
  if (result.changes !== 1) {
    // Someone else consumed it in the gap between our SELECT and this
    // UPDATE (or it expired in that same gap) -- re-check to give an
    // accurate reason rather than a generic failure.
    const fresh = await db.q1('SELECT status FROM enrollment_tokens WHERE id = ?', [verified.token.id]);
    return { ok: false, reason: fresh?.status === 'CONSUMED' ? 'already_consumed' : 'expired' };
  }
  return { ok: true, token: verified.token };
}

/** Owner-initiated revoke of a still-AVAILABLE token. Never revokes (or
 *  un-consumes) an already-consumed one -- that would desync a real
 *  enrollment that already happened. */
export async function revokeEnrollmentToken(db, { orgId, tokenId }) {
  const result = await db.run(
    `UPDATE enrollment_tokens SET status = 'REVOKED', revoked_at = ?
     WHERE id = ? AND org_id = ? AND status = 'AVAILABLE'`,
    [now(), tokenId, orgId]);
  return result.changes === 1;
}

function parsePayload(payload) {
  if (typeof payload !== 'string') return null;
  const dot = payload.indexOf('.');
  if (dot <= 0 || dot === payload.length - 1) return null;
  const rowId = payload.slice(0, dot);
  const secret = payload.slice(dot + 1);
  if (!rowId.startsWith('enr_') || secret.length < 20) return null; // cheap shape check before ever touching the DB
  return { id: rowId, secret };
}
