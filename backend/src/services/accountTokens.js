// ============================================================
// F-10 — ACCOUNT TOKENS: email verification + password reset.
//
// Same bearer-secret shape as services/enterprise/enrollmentToken.js
// (that file's own header comment explains the design in full -- this
// mirrors it deliberately rather than inventing a second pattern):
//   * opaque `<row id>.<random secret>` payload, never a signed/JWT
//     token that embeds claims -- nothing about WHO or WHY is readable
//     from the token itself.
//   * only sha256(secret) is ever stored (token_hash, UNIQUE) -- a
//     database read alone can never reconstruct a still-usable token.
//   * verification re-hashes the presented secret and does a constant-
//     time compare against the stored hash.
//   * single-use is enforced by an ATOMIC conditional UPDATE
//     (`WHERE status = 'AVAILABLE'`), not a read-then-write, so two
//     simultaneous uses of the same link can only ever have one winner.
//
// PURPOSE is 'EMAIL_VERIFY' or 'PASSWORD_RESET' -- one shared table
// (account_tokens), one shared issue/verify/consume implementation,
// used by both features in routes/auth.js.
// ============================================================
import crypto from 'node:crypto';
import { id, now } from '../ids.js';

const SECRET_BYTES = 32; // 256 bits of entropy for the bearer secret
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60_000; // 24h -- a verification link is low-stakes, generous window is fine
const PASSWORD_RESET_TTL_MS = 60 * 60_000;    // 1h -- a reset link grants a real account takeover if intercepted; keep the window tight

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false; // crypto.timingSafeEqual throws on length mismatch -- guard first
  return crypto.timingSafeEqual(bufA, bufB);
}

function ttlFor(purpose) {
  return purpose === 'PASSWORD_RESET' ? PASSWORD_RESET_TTL_MS : EMAIL_VERIFY_TTL_MS;
}

/** Issues a new single-use token for `purpose` and returns the raw
 *  PAYLOAD STRING (`<id>.<secret>`) to embed in the email link -- this
 *  is the only moment the raw secret ever exists; callers must never
 *  log or store it anywhere but the outgoing email. Does NOT invalidate
 *  any prior still-AVAILABLE token for the same user+purpose -- a user
 *  who clicks "resend" twice can use either link; the atomic consume
 *  below is what stops a token being used more than once, not this. */
export async function issueAccountToken(db, { userId, purpose, ttlMs }) {
  if (purpose !== 'EMAIL_VERIFY' && purpose !== 'PASSWORD_RESET') throw new Error(`invalid purpose: ${purpose}`);
  const rowId = id('atk');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const tokenHash = sha256Hex(secret);
  // ttlMs is test-only in practice (e.g. a negative value to construct an
  // already-expired token directly, same technique enrollmentToken.js's
  // issueEnrollmentToken already uses) -- every real call site omits it
  // and gets the purpose-appropriate default below.
  const expiresAt = new Date(Date.now() + (ttlMs ?? ttlFor(purpose))).toISOString();
  await db.run(
    `INSERT INTO account_tokens (id, user_id, purpose, token_hash, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'AVAILABLE', ?, ?)`,
    [rowId, userId, purpose, tokenHash, expiresAt, now()]);
  return { payload: `${rowId}.${secret}`, id: rowId, expiresAt };
}

/** Verifies AND atomically consumes a token in one step. Returns
 *  `{ ok: true, userId }` or `{ ok: false, reason }` --
 *  reason is one of 'malformed_token' | 'not_found' | 'invalid_secret' |
 *  'already_consumed' | 'expired' | 'wrong_purpose'. Never throws on a
 *  malformed/garbage payload -- a mistyped or truncated link is an
 *  expected input, not a server error. */
export async function consumeAccountToken(db, payload, { purpose }) {
  const parsed = parsePayload(payload);
  if (!parsed) return { ok: false, reason: 'malformed_token' };
  const row = await db.q1('SELECT * FROM account_tokens WHERE id = ?', [parsed.id]);
  if (!row) return { ok: false, reason: 'not_found' };
  if (!timingSafeEqualHex(sha256Hex(parsed.secret), row.token_hash)) return { ok: false, reason: 'invalid_secret' };
  if (row.purpose !== purpose) return { ok: false, reason: 'wrong_purpose' };
  if (row.status === 'CONSUMED') return { ok: false, reason: 'already_consumed' };
  if (row.status === 'EXPIRED' || Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: 'expired' };

  const result = await db.run(
    `UPDATE account_tokens SET status = 'CONSUMED', consumed_at = ? WHERE id = ? AND status = 'AVAILABLE'`,
    [now(), row.id]);
  if (result.changes !== 1) {
    // Someone else consumed it in the gap between the SELECT and this
    // UPDATE (or it expired in that same gap) -- re-check for an
    // accurate reason rather than a generic failure, same race-safety
    // pattern as enrollmentToken.js's consumeEnrollmentToken.
    const fresh = await db.q1('SELECT status FROM account_tokens WHERE id = ?', [row.id]);
    return { ok: false, reason: fresh?.status === 'CONSUMED' ? 'already_consumed' : 'expired' };
  }
  return { ok: true, userId: row.user_id };
}

function parsePayload(payload) {
  if (typeof payload !== 'string') return null;
  const dot = payload.indexOf('.');
  if (dot <= 0 || dot === payload.length - 1) return null;
  const rowId = payload.slice(0, dot);
  const secret = payload.slice(dot + 1);
  if (!rowId.startsWith('atk_') || secret.length < 20) return null; // cheap shape check before ever touching the DB
  return { id: rowId, secret };
}
