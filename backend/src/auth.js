import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { getDb, runWithOrg } from './db.js';
import { getOrgTzCached, DEFAULT_TZ } from './utils/time.js';
import { enforceSession, touchSession } from './services/demo/session.js';

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

// Is this org a DEMO TENANT? Same cache/TTL shape as the billing lookup
// above, for the same reason (one cheap cached read per request rather
// than a query on every call), and effectively permanent data -- an org
// is created as a demo or it is not, and nothing in the product flips
// the flag afterwards.
//
// This exists for ONE check in requireAuth: a token whose org is a demo
// tenant but which carries NO demo-session claim is rejected. Without it
// the demo tenant would be reachable by any token naming that org --
// including one minted before a session ended, or by some future code
// path that calls the ordinary signToken() for a demo user. With it,
// there is exactly one way to be inside the demo gym: an unexpired,
// founder-approved demo session, re-verified on every request.
//
// FAILS OPEN (treated as "not a demo org") when the lookup itself fails,
// the same posture as the tz and billing lookups above -- and the choice
// matters enough to spell out, because the first version of this failed
// CLOSED and that was a production-outage bug.
//
// The `is_demo` column arrives via init-db.js's guarded migrations, so
// any database that has not been migrated yet does not have it, and
// `SELECT is_demo` there does not return null -- it THROWS. Failing
// closed turned that throw into "every org is a demo org", which made
// this gate reject every authenticated request from every real customer
// with a 401. Caught by the existing admin-tenant-isolation suite
// running against a pre-migration database: 10 tests, all of them
// `401 !== 201`. Deployed in that order -- new code live, migration not
// yet run -- it would have taken the whole product down, which is
// exactly the hazard "do not assume columns exist" is about.
//
// Failing open is not a weakened control, because this check is not the
// control. There is no way to hold a non-demo token for a demo org in
// the first place: every account inside a demo tenant is seeded with an
// unusable password hash so /auth/login can never authenticate one, and
// the only thing that mints a token for one is signDemoToken(), which
// always sets the `demo` claim. This lookup is a third layer under those
// two. The layer that must NEVER degrade is the session check itself --
// enforceSession(), which fails closed, and which still runs on every
// request carrying a demo claim regardless of what this returns.
const ORG_DEMO_TTL_MS = 5 * 60 * 1000;
const orgDemoCache = new Map(); // orgId -> { isDemo, at }

export async function isDemoOrgCached(db, orgId) {
  if (!orgId) return false;
  const hit = orgDemoCache.get(orgId);
  const nowMs = Date.now();
  if (hit && (nowMs - hit.at) < ORG_DEMO_TTL_MS) return hit.isDemo;
  let isDemo = false;
  try {
    const row = await db.q1('SELECT is_demo FROM organizations WHERE id = ?', [orgId]);
    // A missing row is not a demo org -- it is a token naming an org that
    // no longer exists, which every downstream org-scoped query will
    // return nothing for anyway. Only an existing row with the flag set
    // counts.
    isDemo = row ? !!Number(row.is_demo) : false;
  } catch {
    isDemo = false; // column or table absent, or a transient error -- see above
  }
  orgDemoCache.set(orgId, { isDemo, at: nowMs });
  return isDemo;
}

export function invalidateOrgDemoCache(orgId) {
  if (orgId) orgDemoCache.delete(orgId);
  else orgDemoCache.clear();
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

// A demo session's token. Same signature, same algorithm, same
// verification path as every other token in this app -- it is an
// ORDINARY session for an ordinary user, with two extra claims:
//
//   demo    the demo_sessions row id. Its PRESENCE is what makes
//           requireAuth re-check the server-side clock below; its VALUE
//           names which session to check.
//   persona which of the three demo identities this token is for
//           (OWNER/TRAINER/MEMBER). Display only -- `role` is still the
//           thing every authorization check in this codebase reads, and
//           it is copied off the real user row, never from a request.
//
// The claims are signed, so a prospect cannot edit `demo` to point at a
// different session, `org` at a different tenant, or `role` at
// SUPER_ADMIN, any more than they can forge an ordinary login token.
//
// TTL is short and deliberately longer than one demo (45m vs 30m): the
// JWT expiry is a backstop, not the timer. Making them equal would put
// two clocks in charge of the same deadline and invite them to disagree;
// the authoritative one is demo_sessions.expires_at, checked below on
// every single request. The 7-day default a real login gets would be
// wrong here for the obvious reason.
export const DEMO_TOKEN_TTL = '45m';

export function signDemoToken(user, { sessionId, persona }) {
  return jwt.sign(
    {
      sub: user.id, role: user.role, org: user.org_id, name: user.name, email: user.email,
      demo: sessionId, persona,
    },
    config.jwtSecret,
    { expiresIn: DEMO_TOKEN_TTL, algorithm: JWT_ALGORITHM }
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
    // The APP's own database handle when one has been registered
    // (buildApp does this), falling back to the process-wide singleton.
    //
    // This used to be getDb() unconditionally, which is the same object
    // in production but NOT in tests, where each test builds an Express
    // app around its own in-memory database -- so requireAuth's lookups
    // silently ran against a different (empty) database and fell into
    // their own catch blocks. That was harmless while those lookups were
    // only timezone and billing status, both of which fail open by
    // design. It is NOT harmless for the demo-session gate below, which
    // must fail CLOSED: a gate that cannot read its own table would
    // either block every demo or, worse, be untestable. Preferring the
    // app's handle makes the middleware read the same data the routes
    // mounted beside it do, in every environment.
    db = (typeof req.app?.get === 'function' ? req.app.get('db') : null) || await getDb();
    req.tz = await getOrgTzCached(db, req.user.org || null);
  } catch {
    req.tz = DEFAULT_TZ;
  }
  // ---- DEMO SESSION GATE ----
  // The server-side half of the 30-minute timer, and the reason a
  // frontend countdown cannot be negotiated with: EVERY request carrying
  // a demo token re-reads demo_sessions and re-checks its expiry against
  // the server's own clock before the route ever runs. See
  // services/demo/session.js for the full list of bypasses this closes
  // (refresh, second tab, browser restart, device clock, localStorage,
  // edited JS) -- none of them is a special case here; they all fail for
  // the same reason, which is that the deadline lives in a row the
  // client cannot write.
  //
  // Placed BEFORE the suspension check below so a demo session gets the
  // specific "your demo has ended" answer rather than a generic one, and
  // so the demo's own tenant state can never be confused with a paying
  // gym's billing state.
  if (req.user.demo || (req.user.org && db && await isDemoOrgCached(db, req.user.org))) {
    if (!db) return res.status(503).json({ error: 'demo_unavailable', message: 'Demo is temporarily unavailable.' });
    // An org-less token (SUPER_ADMIN) never reaches here, so this is
    // always a demo-tenant token -- and one WITHOUT a demo claim is by
    // definition not a live session, whatever else it is.
    if (!req.user.demo) {
      return res.status(401).json({ error: 'demo_session_ended', reason: 'invalid', message: 'This demo session is no longer valid.' });
    }
    const verdict = await enforceSession(db, req.user.demo);
    if (!verdict.ok) {
      // 401, not 403: the session is GONE, not insufficient. The frontend
      // keys off `error` to route to /demo-expired rather than the login
      // screen -- see frontend/src/api.js.
      return res.status(401).json({
        error: 'demo_session_ended',
        reason: verdict.reason,
        message: verdict.reason === 'revoked'
          ? 'This demo has been revoked by the administrator.'
          : verdict.reason === 'not_started'
            ? 'This demo has not been started yet.'
            : 'Your demo session has ended.',
      });
    }
    // The token says which tenant; the SESSION ROW says which tenant it
    // was actually granted for. They must agree. This is what makes a
    // re-signed or mis-minted token naming another org useless: the org
    // claim is checked against server-side state, not trusted.
    if (verdict.session.demo_org_id !== req.user.org) {
      return res.status(403).json({ error: 'demo_tenant_mismatch', message: 'This demo session does not grant access to that gym.' });
    }
    req.demoSession = verdict.session;
    req.demoRemainingMs = verdict.remainingMs;
    // Bookkeeping for the founder's activity readout, at most once a
    // minute and never awaited -- a demo must not wait on, or fail
    // because of, an analytics write.
    touchSession(db, verdict.session).catch(() => {});
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
