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
    { sub: user.id, role: user.role, org: user.org_id, name: user.name, email: user.email },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, algorithm: JWT_ALGORITHM }
  );
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
  try {
    const db = await getDb();
    req.tz = await getOrgTzCached(db, req.user.org || null);
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
