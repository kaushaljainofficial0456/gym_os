import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { getDb, runWithOrg } from './db.js';
import { getOrgTzCached, DEFAULT_TZ } from './utils/time.js';

// Suspending a gym (SUPER_ADMIN console -> POST /console/gyms/:id/suspend)
// updated org_billing_state.status but nothing in the actual request path
// ever read it back -- a suspended gym's owner/trainers/clients could log
// in and use every route completely normally. Confirmed live: suspending a
// freshly-onboarded test gym, then logging in as its owner, returned a
// normal 200 from GET /admin/overview. The platform operator's "Suspend"
// button changed a database value nothing else consulted.
//
// Same cache/TTL/invalidate shape as getOrgTzCached just above (short TTL,
// explicit invalidation on write so a suspend/reactivate takes effect on
// the NEXT request rather than waiting out the TTL) -- requireAuth already
// pays one cached lookup per request for org timezone; this adds the same
// kind of lookup, not a second uncached query shape.
//
// org_billing_state is populated only for orgs that went through real
// Enterprise onboarding (/setup-org, /auth/google-enterprise) -- a legacy
// or directly-seeded org has no row at all, which correctly means "not
// gated by this system" (getOrgBillingStatusCached returns null), not
// "blocked". Only an explicit 'SUSPENDED' status blocks; every other
// status (SETUP, ACTIVE, PAST_DUE, ...) passes through unchanged -- this
// enforces the one state the console can actually put an org into via
// /suspend, without inventing gating for states nothing here decided the
// meaning of.
const ORG_BILLING_TTL_MS = 60 * 1000;
const orgBillingCache = new Map(); // orgId -> { status, at }

export async function getOrgBillingStatusCached(db, orgId) {
  if (!orgId) return null;
  const hit = orgBillingCache.get(orgId);
  const now = Date.now();
  if (hit && (now - hit.at) < ORG_BILLING_TTL_MS) return hit.status;
  let status = null;
  try {
    const row = await db.q1('SELECT status FROM org_billing_state WHERE org_id = ?', [orgId]);
    status = row?.status || null;
  } catch { status = null; } // table/row absent -- treat as ungated, never block on a lookup failure
  orgBillingCache.set(orgId, { status, at: now });
  return status;
}

// Call after any write to org_billing_state.status (console.js's
// suspend/reactivate) so the change is picked up immediately instead of
// waiting out the TTL.
export function invalidateOrgBillingCache(orgId) {
  if (orgId) orgBillingCache.delete(orgId);
  else orgBillingCache.clear();
}

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

// The attributes sk_token is set with. Shared by setAuthCookie and
// clearAuthCookie ON PURPOSE: a browser only removes a cookie when the
// clearing Set-Cookie's name/path/domain AND its security attributes match
// the ones it was stored with (Express says as much of res.clearCookie --
// "clients will only clear the cookie if the given options is identical to
// those given to res.cookie()"). clearAuthCookie used to pass `path` alone,
// so the clear response disagreed with the original on httpOnly/secure/
// sameSite and a compliant browser was entitled to keep the cookie -- a
// second, independent way for logout to leave the session alive. One
// definition means the two can no longer drift apart.
const authCookieOptions = () => ({
  httpOnly: true,
  secure: config.nodeEnv === 'production' || config.nodeEnv === 'staging',
  sameSite: 'strict',
  // Root, not '/api': requireAuth also gates /uploads/:key (private
  // photo/image serving, see index.js), a SIBLING mount, not a path under
  // /api. A cookie scoped to path=/api is a browser-enforced restriction
  // the server-side route never knows happened -- every request to
  // /uploads/* simply arrives with no cookie, at all, for every role,
  // including the photo's own owner. Combined with the frontend no longer
  // sending a Bearer header as a fallback (removed; auth is cookie-only
  // now, see api.js), this meant NO transformation photo could ever
  // actually load for anyone, in any environment -- confirmed live:
  // authenticating and then requesting a just-uploaded photo's own URL
  // returned 401 "Authentication required" regardless of who was logged
  // in. Scoping to '/' costs nothing extra: the cookie is httpOnly
  // (immune to XSS reads), secure+sameSite=strict in prod/staging
  // (immune to cross-site leakage), so widening which same-origin PATHS
  // it's attached to is not a new exposure -- it only fixes which of the
  // app's OWN routes can see it.
  path: '/',
});

// Set the JWT as an httpOnly cookie — immune to XSS token theft.
export function setAuthCookie(res, token) {
  // maxAge lives here rather than in authCookieOptions(): it is the one
  // attribute clearAuthCookie must NOT repeat (it would fight the
  // expiry-in-the-past that does the clearing), and Express excludes
  // expires/maxAge from the attributes a client matches on anyway.
  res.cookie('sk_token', token, {
    ...authCookieOptions(),
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days — matches JWT expiry
  });
}

// The legacy path this cookie used to be scoped to. Until c257290
// (2026-09-11) setAuthCookie wrote sk_token with path '/api'; that commit
// moved it to '/' so requireAuth could also gate /uploads/:key (see
// authCookieOptions above for the full reasoning).
const LEGACY_COOKIE_PATH = '/api';

export function clearAuthCookie(res) {
  res.clearCookie('sk_token', authCookieOptions());
  // Clear the LEGACY '/api'-scoped cookie as well, not just the current
  // '/'-scoped one. A cookie's identity is (name, domain, path), so the
  // clear above is incapable of touching a cookie stored under a different
  // path -- it is a different cookie as far as the browser is concerned,
  // no matter that the name matches.
  //
  // Root cause of "Sign out still does nothing on production", found after
  // the earlier fixes were already live and verified: every session created
  // BEFORE c257290 deployed still holds sk_token at path=/api, carrying a
  // JWT good for 7 days. The browser sends it on every /api/* request, so
  // after a logout that only cleared '/', it was the ONLY sk_token left --
  // /auth/me authenticated with it, and App.jsx's <GuestOnly> bounced the
  // user off /login straight back into the app. Reproduced against a real
  // cookie engine: with the legacy cookie present /auth/me returned 200
  // after logout; without it, 401.
  //
  // Harmless for everyone else: clearing a cookie the browser does not have
  // is a no-op. Safe to delete once every pre-c257290 cookie has aged out
  // (7-day maxAge, so after ~2026-09-18) -- keeping it costs one header.
  res.clearCookie('sk_token', { ...authCookieOptions(), path: LEGACY_COOKIE_PATH });
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
  let db;
  try {
    db = await getDb();
    req.tz = await getOrgTzCached(db, req.user.org || null);
  } catch {
    req.tz = DEFAULT_TZ;
  }
  // A SUSPENDED gym (SUPER_ADMIN console) blocks every org-scoped request
  // for that org, at the one place ALL of them already pass through --
  // see getOrgBillingStatusCached's own comment for why this exists and
  // why only 'SUSPENDED' (not a missing row, and not any other status)
  // blocks. SUPER_ADMIN is platform-wide (req.user.org is always null for
  // that role, same as orgScope's own handling below) and is exactly who
  // needs to still be able to act on a suspended org, so this can never
  // lock an operator out of the gym they just suspended.
  if (req.user.org && db) {
    try {
      const billingStatus = await getOrgBillingStatusCached(db, req.user.org);
      if (billingStatus === 'SUSPENDED') {
        return res.status(403).json({ error: 'This gym\'s account has been suspended. Contact support.' });
      }
    } catch { /* lookup failure must never itself block a login -- fail open, same as the tz lookup above */ }
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
