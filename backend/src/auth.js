import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { getDb, runWithOrg } from './db.js';
import { getOrgTzCached, DEFAULT_TZ } from './utils/time.js';

// F-12h hardening: bumped from 10 -> 12, OWASP's current recommended
// bcrypt minimum. Benchmarked on this deployment's target hardware shape
// before choosing it (see commit message): cost 10 ~75ms, 12 ~263ms,
// 13 ~532ms per hash -- 12 stays comfortably under any reasonable login-
// latency budget at this app's documented ~2,500-client scale (this
// runs once per login/signup/password-change, never per-request).
//
// bcrypt hashes are self-describing -- the cost factor is embedded in the
// hash string itself ($2a$10$... vs $2a$12$...) -- so verifyPassword()
// below needs NO change at all to keep validating every password hashed
// at the old cost 10. BCRYPT_COST/needsRehash() exist so a successful
// login can transparently re-hash a still-cost-10 password at the new
// cost (see routes/auth.js's /login) -- existing users are migrated
// gradually, on their own next login, never all at once and never by a
// migration script touching every row.
const BCRYPT_COST = 12;
export const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_COST);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);
/** True when a stored hash was created at a lower cost than BCRYPT_COST
 *  -- bcrypt hash format is $<algo>$<cost>$<22-char-salt><31-char-hash>,
 *  so the cost is the second '$'-delimited field, parsed directly rather
 *  than re-hashing to compare (which would defeat the purpose). */
export function needsRehash(hash) {
  const parts = String(hash || '').split('$');
  const cost = Number(parts[2]);
  return !Number.isFinite(cost) || cost < BCRYPT_COST;
}

// F-12b hardening: explicitly pin HS256 on both sign and verify, rather
// than relying on jsonwebtoken's own default behavior (which -- given a
// plain string secret to jwt.verify -- already only accepts the HS*
// family, so an `alg: none` or RS256-confusion forgery already fails
// today; verified live: forged alg:none, wrong-secret, and tampered-
// payload tokens are all rejected). Pinning here removes the dependency
// on that library-default behavior remaining what it is, and makes the
// accepted algorithm an explicit, auditable line in this file rather
// than an assumption about jsonwebtoken's internals.
export const JWT_ALGORITHM = 'HS256';

export function signToken(user) {
  return jwt.sign(
    // `epoch` (REMEDIATION: session revocation) -- carries the user's
    // token_epoch at sign time. requireAuth below rejects a token whose
    // epoch doesn't match the user's CURRENT epoch, which is what makes
    // /auth/change-password, /auth/reset-password and
    // /auth/logout-everywhere able to revoke every OTHER already-issued
    // token for this user, not just clear one browser's own cookie.
    // Defaults to 0 -- a caller that doesn't carry token_epoch on its user
    // object (none of this codebase's other call sites need to) signs an
    // epoch-0 token, matching every existing user row's DB default.
    { sub: user.id, role: user.role, org: user.org_id, name: user.name, email: user.email, epoch: user.token_epoch || 0 },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, algorithm: JWT_ALGORITHM }
  );
}

// ---- REMEDIATION: session revocation (per-user token epoch) ----
// Same shape as utils/time.js's getOrgTzCached: a per-key TTL cache in
// front of a DB read, so requireAuth's hot path doesn't take a second
// query on every single authenticated request. The trade-off is explicit
// and bounded: a token revoked by a password change/reset/logout-
// everywhere on ONE serverless instance stops working there immediately
// (the cache is invalidated in-process the moment the epoch is bumped),
// but a DIFFERENT warm instance that already cached the old epoch keeps
// accepting that token for up to EPOCH_TTL_MS. That is a real, bounded
// window, not instant global revocation -- true instant cross-instance
// revocation would need a shared cache/pub-sub this codebase doesn't have
// (the same limitation upstashRateLimitStore.js's own header discusses for
// rate-limit state). 60s was chosen to keep the residual window small
// without adding a DB round trip to every request in the common case.
const EPOCH_TTL_MS = 60_000;
const epochCache = new Map(); // userId -> { epoch, at }

export async function getUserEpochCached(db, userId) {
  const hit = epochCache.get(userId);
  const now = Date.now();
  if (hit && (now - hit.at) < EPOCH_TTL_MS) return hit.epoch;
  const row = await db.q1('SELECT token_epoch FROM users WHERE id = ?', [userId]);
  const epoch = row?.token_epoch || 0;
  epochCache.set(userId, { epoch, at: now });
  return epoch;
}

// Call immediately after any write to users.token_epoch so THIS process
// stops accepting the old epoch right away, instead of waiting out the TTL.
export function invalidateUserEpochCache(userId) {
  if (userId) epochCache.delete(userId);
  else epochCache.clear();
}

// Set the JWT as an httpOnly cookie — immune to XSS token theft.
// The frontend's Bearer header continues to work as a fallback.
export function setAuthCookie(res, token) {
  const isSecure = config.nodeEnv === 'production' || config.nodeEnv === 'staging';
  res.cookie('sk_token', token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    path: '/api',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days — matches JWT expiry
  });
}

export function clearAuthCookie(res) {
  res.clearCookie('sk_token', { path: '/api' });
}

// Attach req.user from the Bearer token (claims carry identity), then resolve the
// authenticated organization's timezone into req.tz. Resolving tz AFTER auth is
// intentional: the org is only known once the token is verified. The old app-level
// middleware ran before this and always fell back to the default timezone.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies?.sk_token || null);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // REMEDIATION: session revocation. A token's own `epoch` claim (defaults
  // to 0 for tokens signed before this existed, or by any caller that never
  // set one) must match the user's CURRENT token_epoch -- see signToken's
  // own comment and getUserEpochCached above for exactly what this closes.
  // Fails OPEN on any error getting there (db unavailable, or the epoch
  // read itself failing), matching this function's own pre-existing
  // posture on the tz lookup right below: a transient DB hiccup failing
  // EVERY authenticated request app-wide is a worse outage than the narrow
  // window where a revoked token might still work during that same hiccup
  // -- and any route this request goes on to call almost certainly hits
  // the same DB anyway, so failing closed here would not add real
  // protection, only a new single point of failure on the auth hot path.
  let db;
  try {
    db = await getDb();
    const currentEpoch = await getUserEpochCached(db, req.user.sub);
    if ((req.user.epoch || 0) !== currentEpoch) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (e) {
    console.error('[auth] token-epoch check failed, failing open:', e?.message || e);
  }
  try {
    req.tz = db ? await getOrgTzCached(db, req.user.org || null) : DEFAULT_TZ;
  } catch {
    req.tz = DEFAULT_TZ;
  }
  // Scope the authenticated org for the rest of this request (db.tx uses it to
  // engage PostgreSQL RLS). Must wrap next() so the ALS context covers downstream.
  runWithOrg(req.user.org || null, () => next());
}

// Role gate. Call AFTER requireAuth.
export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

// Tenant isolation: the token carries the org the user belongs to.
// SUPER_ADMIN spans all orgs (platform admin); everyone else is scoped to their org.
export const orgScope = (req, res, next) => {
  if (req.user.role === 'SUPER_ADMIN') {
    req.orgId = req.params.orgId || null; // platform admin may pass ?org= or :orgId
    return next();
  }
  req.orgId = req.user.org;
  next();
};

// Resolve the client record + enforce that the requesting user may see it:
//   * same-org trainer who owns the client (or owner/admin of the org)
//   * the client themselves
export async function resolveClient(db, req, res, clientId) {
  const client = await db.q1(
    `SELECT c.*, u.name, u.email, u.avatar, u.phone
       FROM clients c JOIN users u ON u.id = c.user_id
      WHERE c.id = ?`, [clientId]);
  if (!client) { res.status(404).json({ error: 'Client not found' }); return null; }
  const { role, org, sub } = req.user;
  const sameOrg = client.org_id === org || role === 'SUPER_ADMIN';
  const isTrainerOfClient = client.trainer_id === sub;
  const isOwnerOrAdmin = role === 'GYM_OWNER' || role === 'SUPER_ADMIN';
  const isClientSelf = role === 'CLIENT' && client.user_id === sub;
  if (!sameOrg || !(isClientSelf || isTrainerOfClient || isOwnerOrAdmin)) {
    res.status(403).json({ error: 'You do not have access to this client' });
    return null;
  }
  return client;
}
