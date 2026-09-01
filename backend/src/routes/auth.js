import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { hashPassword, verifyPassword, signToken, setAuthCookie, requireAuth } from '../auth.js';
import { rateLimit } from '../rateLimit.js';
import { validate } from '../validate.js';
import { id, now } from '../ids.js';
import { track } from '../services/events.js';
import { syncPrimaryMembership, listUserMemberships, getActiveMembership } from '../services/enterprise/gymMemberships.js';

// Simple in-memory login rate limit (dev-safe, no external deps).
// 5 failed attempts per email+IP in 60s -> 429. Production should use a
// shared store (Redis) and/or an API gateway.
const loginAttempts = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
function rateLimited(email, ip) {
  const key = (email || '') + '|' + (ip || '');
  const nowMs = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || nowMs - rec.start > RATE_WINDOW_MS) {
    loginAttempts.set(key, { start: nowMs, count: 1 });
    return false;
  }
  rec.count += 1;
  if (rec.count > RATE_MAX) return true;
  return false;
}
function recordFailure(email, ip) {
  const key = (email || '') + '|' + (ip || '');
  const nowMs = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || nowMs - rec.start > RATE_WINDOW_MS) {
    loginAttempts.set(key, { start: nowMs, count: 1 });
  } else {
    rec.count += 1;
  }
  // Prevent unbounded growth: evict entries older than 2× the window.
  if (loginAttempts.size > 500) {
    for (const [k, v] of loginAttempts) {
      if (nowMs - v.start > RATE_WINDOW_MS * 2) loginAttempts.delete(k);
    }
  }
}

export default function authRoutes(db) {
  const r = Router();
  // Per-IP ceiling on auth endpoints (login + org setup) — 30/min.
  r.post('/login', rateLimit({ windowMs: 60_000, max: 30 }),
    validate(z.object({
      email: z.string().email(),
      password: z.string().min(4)
    })), async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const ip = req.ip || req.socket?.remoteAddress;
    if (rateLimited(email, ip)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
    }
    const user = await db.q1('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !(await verifyPassword(req.body.password, user.password_hash))) {
      recordFailure(email, ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    loginAttempts.delete(email + '|' + ip);
    if (!user.active) return res.status(403).json({ error: 'Account disabled' });
    const org = user.org_id ? await db.q1('SELECT id, name, slug FROM organizations WHERE id = ?', [user.org_id]) : null;
    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        orgId: user.org_id, orgName: org?.name || null, orgSlug: org?.slug || null
      }
    });
  });

  // Self-service client signup (pre-auth). Distinct from POST /clients
  // (staff-created accounts, requires an authenticated trainer/owner
  // session) -- this is how a client joins on their own, given the gym
  // code their trainer/owner shares with them. Mirrors setup-org's shape:
  // one db.tx() insert of users + clients + client_profiles (never two
  // separate calls -- a failure on the second/third insert must not leave
  // an orphaned account that can log in but 404s everywhere), then
  // auto-login via the same signed-cookie + token response as /login.
  // Deliberately collects only name/email/password/gymCode here -- goal,
  // weight, height etc. are collected right after by OnboardingWizard
  // (ClientLayout already shows it automatically while onboarding_completed
  // is false), so this form stays a 30-second signup, not a full profile.
  // gymCode is now OPTIONAL -- this is the one behavior change to an
  // existing route in this whole Enterprise build, and it's additive
  // only: every EXISTING caller that already sends a real gymCode gets
  // byte-for-byte the same response as before (same branch, untouched
  // below). Omitting it is the NEW path: the spec's "client enters SK
  // OS, creates an account, THEN scans a gym QR separately" flow --
  // this account is created with org_id NULL and no clients row at all
  // yet (clients.org_id is NOT NULL, so a real clients row literally
  // cannot exist before a gym is known), and the frontend is told to
  // show "Join your gym" instead of the normal app shell. See
  // enrollment.js's /enrollment/client/join for what completes this.
  r.post('/register', rateLimit({ windowMs: 60_000, max: 10 }),
    validate(z.object({
      name: z.string().min(1).max(80),
      email: z.string().email(),
      password: z.string().min(6),
      gymCode: z.string().min(1).max(80).optional()
    })), async (req, res) => {
    const email = req.body.email.toLowerCase().trim();

    if (!req.body.gymCode) {
      const userId = id('usr');
      try {
        const passwordHash = await hashPassword(req.body.password);
        await db.run(
          `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
           VALUES (?, NULL, ?, ?, 'CLIENT', ?, 1, ?)`,
          [userId, email, passwordHash, req.body.name, now()]);
        await track(db, { userId, type: 'client_self_registered_pending_gym', data: {} });
        const user = { id: userId, org_id: null, role: 'CLIENT', name: req.body.name, email };
        const token = signToken(user);
        setAuthCookie(res, token);
        return res.status(201).json({
          token,
          user: { id: userId, name: req.body.name, email, role: 'CLIENT', orgId: null, pendingGymEnrollment: true }
        });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
        throw e;
      }
    }

    const slug = req.body.gymCode.toLowerCase().trim();
    const org = await db.q1('SELECT id, name, slug FROM organizations WHERE slug = ?', [slug]);
    if (!org) return res.status(404).json({ error: 'Gym code not found. Check with your trainer or gym owner.' });
    const userId = id('usr');
    const clientId = id('cli');
    try {
      const passwordHash = await hashPassword(req.body.password);
      await db.tx(async (tx) => {
        await tx.run(
          `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
           VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
          [userId, org.id, email, passwordHash, req.body.name, now()]);
        // goal defaults to 'GENERAL' here (not the clients table's own
        // DB-level default of 'FAT_LOSS') to match POST /clients' documented
        // default when a goal isn't supplied -- the wizard sets the real
        // one moments later, so the account shouldn't silently pick one.
        await tx.run(
          `INSERT INTO clients (id, user_id, org_id, status, goal, created_at)
           VALUES (?, ?, ?, 'ON_TRACK', 'GENERAL', ?)`,
          [clientId, userId, org.id, now()]);
        await tx.run(
          `INSERT INTO client_profiles (client_id, meals_per_day, sleep_target_h, water_target_l) VALUES (?, 5, 8, 3)`,
          [clientId]);
      });
      await track(db, { orgId: org.id, userId, type: 'client_self_registered', data: {} });
      const user = { id: userId, org_id: org.id, role: 'CLIENT', name: req.body.name, email };
      const token = signToken(user);
      setAuthCookie(res, token);
      res.status(201).json({
        token,
        user: { id: userId, name: req.body.name, email, role: 'CLIENT', orgId: org.id, orgName: org.name, orgSlug: org.slug }
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
      throw e;
    }
  });

  // Trainer self-registration -- did not exist before (trainers were
  // previously only ever created BY an owner/admin). Same
  // pending-enrollment shape as /register's gymCode-less path: org_id
  // NULL, no `trainers` row yet, "Join a gym" screen until a QR scan
  // completes it via /enrollment/trainer/join.
  r.post('/register-trainer', rateLimit({ windowMs: 60_000, max: 10 }),
    validate(z.object({
      name: z.string().min(1).max(80),
      email: z.string().email(),
      password: z.string().min(6)
    })), async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const userId = id('usr');
    try {
      const passwordHash = await hashPassword(req.body.password);
      await db.run(
        `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
         VALUES (?, NULL, ?, ?, 'TRAINER', ?, 1, ?)`,
        [userId, email, passwordHash, req.body.name, now()]);
      await track(db, { userId, type: 'trainer_self_registered_pending_gym', data: {} });
      const user = { id: userId, org_id: null, role: 'TRAINER', name: req.body.name, email };
      const token = signToken(user);
      setAuthCookie(res, token);
      res.status(201).json({
        token,
        user: { id: userId, name: req.body.name, email, role: 'TRAINER', orgId: null, pendingGymEnrollment: true }
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
      throw e;
    }
  });

  // Google Sign-In for independent clients -- the "Independent client" path
  // on the login screen. Independent clients have no gym: no gym code to
  // type, so email/password self-signup doesn't fit; Google gives identity
  // (email, name, picture) with one tap instead. This verifies a Google
  // Identity Services ID token (the `credential` GIS hands the frontend --
  // see IndependentLogin.jsx) against Google's own public keys, so it needs
  // ONLY GOOGLE_CLIENT_ID as the expected audience -- no client secret. A
  // client secret is for exchanging an auth CODE for tokens (offline access
  // to call Google APIs later); this app never does that, it only needs to
  // know who signed in, once, at login time.
  const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
  let googleClient = null;
  if (googleClientId) {
    googleClient = new OAuth2Client(googleClientId);
  }

  // All independent clients share one pseudo-organization rather than a
  // schema change to make clients.org_id nullable -- `organizations.type`
  // already had an 'independent' value reserved (see the setup-org schema
  // above), so this reuses it rather than inventing a second mechanism.
  // INSERT ... ON CONFLICT DO NOTHING + a SELECT-back is race-safe under
  // concurrent first-time signups (two requests racing to create it both
  // land on the same row), unlike a SELECT-then-INSERT-if-missing check.
  // The gym_settings row is what actually turns off gym-only features for
  // these clients: crowd_enabled=0 (there's no physical gym to have a live
  // crowd) and full self-service permissions (custom workout mode, every
  // allow_* on), since there's no trainer to prescribe anything.
  const INDEPENDENT_ORG_SLUG = 'independent';
  async function ensureIndependentOrg() {
    const existing = await db.q1('SELECT id FROM organizations WHERE slug = ?', [INDEPENDENT_ORG_SLUG]);
    if (existing) return existing.id;
    const orgId = id('org');
    await db.run(
      `INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, 'independent', ?)
       ON CONFLICT (slug) DO NOTHING`,
      [orgId, 'Independent Clients', INDEPENDENT_ORG_SLUG, now()]);
    const row = await db.q1('SELECT id FROM organizations WHERE slug = ?', [INDEPENDENT_ORG_SLUG]);
    await db.run(
      `INSERT INTO gym_settings (org_id, brand_name, tagline, crowd_capacity, crowd_enabled, workout_mode_default, allow_substitute, allow_add_exercise, allow_edit_targets, updated_at)
       VALUES (?, 'SK OS', 'Your own coach, in your pocket.', 150, 0, 'custom', 1, 1, 1, ?)
       ON CONFLICT (org_id) DO NOTHING`,
      [row.id, now()]);
    return row.id;
  }

  r.post('/google', rateLimit({ windowMs: 60_000, max: 20 }),
    validate(z.object({ credential: z.string().min(20) })), async (req, res) => {
    if (!googleClient) {
      return res.status(503).json({ error: 'Google sign-in is not configured on this server yet.' });
    }
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: req.body.credential, audience: googleClientId });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Could not verify Google sign-in. Please try again.' });
    }
    if (!payload?.email) return res.status(401).json({ error: 'Google did not share an email for this account.' });
    const email = payload.email.toLowerCase().trim();

    const existing = await db.q1('SELECT * FROM users WHERE email = ?', [email]);
    if (existing) {
      if (existing.role !== 'CLIENT') {
        // A staff account (trainer/owner) already owns this email -- Google
        // sign-in only ever creates/logs into CLIENT accounts, so this must
        // fail rather than silently cross role boundaries.
        return res.status(409).json({ error: 'This email is registered to a staff account. Sign in from the Gym ecosystem option instead.' });
      }
      if (!existing.active) return res.status(403).json({ error: 'Account disabled' });
      const org = existing.org_id ? await db.q1('SELECT id, name, slug FROM organizations WHERE id = ?', [existing.org_id]) : null;
      const token = signToken(existing);
      setAuthCookie(res, token);
      return res.json({
        token,
        user: { id: existing.id, name: existing.name, email: existing.email, role: 'CLIENT', orgId: existing.org_id, orgName: org?.name || null, orgSlug: org?.slug || null }
      });
    }

    const orgId = await ensureIndependentOrg();
    const userId = id('usr');
    const clientId = id('cli');
    const name = String(payload.name || email.split('@')[0]).slice(0, 80);
    try {
      // Google users never set a password -- a random unusable hash fills
      // the NOT NULL column without anyone knowing (or needing) it; the
      // account can only ever be reached via Google sign-in.
      const passwordHash = await hashPassword(crypto.randomUUID() + crypto.randomUUID());
      await db.tx(async (tx) => {
        await tx.run(
          `INSERT INTO users (id, org_id, email, password_hash, role, name, avatar, active, created_at)
           VALUES (?, ?, ?, ?, 'CLIENT', ?, ?, 1, ?)`,
          [userId, orgId, email, passwordHash, name, payload.picture || null, now()]);
        await tx.run(
          `INSERT INTO clients (id, user_id, org_id, status, goal, created_at)
           VALUES (?, ?, ?, 'ON_TRACK', 'GENERAL', ?)`,
          [clientId, userId, orgId, now()]);
        await tx.run(
          `INSERT INTO client_profiles (client_id, meals_per_day, sleep_target_h, water_target_l) VALUES (?, 5, 8, 3)`,
          [clientId]);
      });
      await track(db, { orgId, userId, type: 'client_google_registered', data: {} });
      await syncPrimaryMembership(db, { userId, orgId, role: 'CLIENT' }).catch(() => {});
      const user = { id: userId, org_id: orgId, role: 'CLIENT', name, email };
      const token = signToken(user);
      setAuthCookie(res, token);
      res.status(201).json({
        token,
        user: { id: userId, name, email, role: 'CLIENT', orgId, orgName: 'Independent Clients', orgSlug: INDEPENDENT_ORG_SLUG }
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
      throw e;
    }
  });

  // Google Sign-In for GYM OWNERS -- the "Enterprise" flow's Google
  // option. Shares the SAME googleClient/GOOGLE_CLIENT_ID as the
  // independent-client route above: a Google OAuth Client ID is not a
  // secret (it's the expected token AUDIENCE, meant to be public --
  // unlike a client secret, which this app never uses at all, see the
  // /google route's own comment on why), so reusing it across both
  // entry points is fine.
  //
  // An EXISTING GYM_OWNER logs straight in via Google -- no password
  // needed, identity is proven by the verified token instead. A
  // brand-new signup creates the org + owner in one call, mirroring
  // /setup-org's own transaction exactly (organizations, users,
  // org_billing_state, gym_memberships), just with Google-verified
  // identity standing in for a password.
  //
  // Deliberately a SEPARATE route from /google above rather than one
  // handler branched by an `intent` parameter: the two outcomes (join
  // the one shared "independent" pseudo-org vs. create a brand new
  // org) are different enough that forcing them through one function
  // would make both harder to read, and a bug in this path can never
  // accidentally reach the independent-client flow's own tested
  // behavior, or vice versa.
  r.post('/google/enterprise', rateLimit({ windowMs: 60_000, max: 20 }),
    validate(z.object({ credential: z.string().min(20), orgName: z.string().min(2).max(80).optional() })), async (req, res) => {
    if (!googleClient) {
      return res.status(503).json({ error: 'Google sign-in is not configured on this server yet.' });
    }
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: req.body.credential, audience: googleClientId });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Could not verify Google sign-in. Please try again.' });
    }
    if (!payload?.email) return res.status(401).json({ error: 'Google did not share an email for this account.' });
    const email = payload.email.toLowerCase().trim();

    const existing = await db.q1('SELECT * FROM users WHERE email = ?', [email]);
    if (existing) {
      if (existing.role !== 'GYM_OWNER') {
        // A client/trainer/admin account already owns this email --
        // Google sign-in from the Enterprise screen only ever
        // creates/logs into GYM_OWNER accounts, so this must fail
        // rather than silently cross role boundaries (mirrors the
        // /google route's own reverse-direction check).
        return res.status(409).json({ error: 'This email is registered to a different kind of account. Sign in from the right option on the login screen.' });
      }
      if (!existing.active) return res.status(403).json({ error: 'Account disabled' });
      const org = existing.org_id ? await db.q1('SELECT id, name, slug FROM organizations WHERE id = ?', [existing.org_id]) : null;
      const token = signToken(existing);
      setAuthCookie(res, token);
      return res.json({
        token,
        user: { id: existing.id, name: existing.name, email: existing.email, role: 'GYM_OWNER', orgId: existing.org_id, orgName: org?.name || null, orgSlug: org?.slug || null }
      });
    }

    // Brand-new gym owner -- creating an org needs a name, which Google
    // never supplies, so the frontend collects it (see SetupOrg.jsx)
    // and sends it alongside the credential. Same opt-in invite gate as
    // /setup-org (SETUP_SECRET) -- checked here too since this is
    // another path to the identical "create a new org" outcome; a
    // deployment that locks one must lock both.
    const setupSecretEnterprise = process.env.SETUP_SECRET || '';
    if (setupSecretEnterprise) {
      const provided = req.headers['x-setup-secret'] || '';
      const providedBuf = Buffer.from(provided, 'utf8');
      const secretBuf = Buffer.from(setupSecretEnterprise, 'utf8');
      const lengthOk = providedBuf.length === secretBuf.length;
      const contentOk = lengthOk && crypto.timingSafeEqual(providedBuf, secretBuf);
      if (!contentOk) return res.status(403).json({ error: 'Setup not available. An invitation is required.' });
    }
    if (!req.body.orgName) return res.status(422).json({ error: 'orgName is required to create a new gym.' });

    const orgId = id('org');
    const userId = id('usr');
    const orgName = req.body.orgName;
    // Same slugify + collision-safe suffix as /setup-org -- see that
    // route's own comment on why .toLowerCase() must cover the WHOLE
    // string, id() suffix included.
    const slug = (orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + orgId.slice(-4)).toLowerCase();
    const name = String(payload.name || email.split('@')[0]).slice(0, 80);
    try {
      // Google users never set a password -- see the /google route's
      // own comment on why a random unusable hash is correct here.
      const passwordHash = await hashPassword(crypto.randomUUID() + crypto.randomUUID());
      await db.tx(async (tx) => {
        await tx.run('INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, ?, ?)', [orgId, orgName, slug, 'gym', now()]);
        await tx.run(
          `INSERT INTO users (id, org_id, email, password_hash, role, name, avatar, active, created_at)
           VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, ?, 1, ?)`,
          [userId, orgId, email, passwordHash, name, payload.picture || null, now()]);
        // Enterprise (gym) signups start in SETUP, exactly like
        // /setup-org's own gym-type branch.
        await tx.run(`INSERT INTO org_billing_state (org_id, status, updated_at) VALUES (?, 'SETUP', ?)`, [orgId, now()]);
      });
      await track(db, { orgId, userId, type: 'org_created_via_google', data: { orgName } });
      await syncPrimaryMembership(db, { userId, orgId, role: 'GYM_OWNER' }).catch(() => {});
      const user = { id: userId, org_id: orgId, role: 'GYM_OWNER', name, email };
      const token = signToken(user);
      setAuthCookie(res, token);
      res.status(201).json({
        token,
        user: { id: userId, name, email, role: 'GYM_OWNER', orgId, orgName, orgSlug: slug }
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
      throw e;
    }
  });

  // Create a new organization + owner (multi-tenant onboarding). This is
  // the backend for the "Enterprise" option on the login screen -- a gym's
  // very first visit, before any account exists.
  //
  // GATE POSTURE (changed): this used to fail-locked in production/staging
  // unless SETUP_SECRET was set (and since it never was, the endpoint was
  // permanently 403 in the deployed app -- effectively disabled). Now that
  // "Enterprise" is a first-class, public entry point on the login screen
  // -- exactly like any SaaS's own "start free trial" -- a fail-locked
  // default defeats the point of self-serve onboarding. The gate is now
  // OPT-IN: set SETUP_SECRET to require the X-Setup-Secret header (for a
  // deployment that wants invite-only onboarding); leave it unset and
  // setup is open to anyone, in every environment. This is a deliberate
  // security-posture change, not an oversight -- flagged to the user.
  const setupSecret = process.env.SETUP_SECRET || '';
  r.post('/setup-org', rateLimit({ windowMs: 60_000, max: 10 }),
    validate(z.object({
      orgName: z.string().min(2).max(80),
      ownerName: z.string().min(2).max(80),
      email: z.string().email(),
      password: z.string().min(6),
      type: z.enum(['gym', 'independent']).default('gym'),
      // Enterprise signup's optional gym-profile fields (spec: "Gym
      // Contact Number, Country, City, Address"). All optional so
      // /independent's own setup-org call (type: 'independent', no
      // profile form) is completely unaffected.
      contactPhone: z.string().max(30).optional(),
      country: z.string().max(60).optional(),
      city: z.string().max(60).optional(),
      address: z.string().max(300).optional()
    })), async (req, res) => {
    // Only gate when a secret has actually been configured.
    if (setupSecret) {
      const provided = req.headers['x-setup-secret'] || '';
      const providedBuf = Buffer.from(provided, 'utf8');
      const secretBuf = Buffer.from(setupSecret, 'utf8');
      // timingSafeEqual requires equal-length buffers; compare length first
      // to avoid a RangeError crash. Different lengths → invalid secret.
      const lengthOk = providedBuf.length === secretBuf.length;
      const contentOk = lengthOk && crypto.timingSafeEqual(providedBuf, secretBuf);
      if (!contentOk) {
        return res.status(403).json({ error: 'Setup not available. An invitation is required.' });
      }
    }
    const { orgName, ownerName, email, password, type } = req.body;
    const orgId = id('org');
    const userId = id('usr');
    // .toLowerCase() applies to the WHOLE string, including the orgId
    // suffix -- id() generates mixed-case nanoid-style ids, so without this
    // the stored slug could contain uppercase letters while /auth/register
    // always lowercases the gym code it's given before looking it up
    // (case-insensitive by design, since a client typing a code shouldn't
    // need to match its exact casing). A slug with real uppercase in it
    // would then never match ANY input a client could type -- gym-code
    // signup silently unusable for that org. Found while reproducing an
    // unrelated report by creating a real test org and hitting exactly
    // this.
    const slug = (orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + orgId.slice(-4)).toLowerCase();
    try {
      // Hashed before the transaction opens — bcrypt is CPU-bound, no reason
      // to hold a DB connection (Postgres: a pooled one) for it.
      const passwordHash = await hashPassword(password);
      // Was two separate db.run() calls: a failure on the second (e.g. a
      // duplicate email) left the organization row committed with no
      // owner — an orphaned org, unrecoverable except by hand, and its slug
      // permanently unavailable to a retry. Same db.tx() pattern already
      // used for workout completion.
      const { contactPhone, country, city, address } = req.body;
      await db.tx(async (tx) => {
        await tx.run('INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, ?, ?)',
          [orgId, orgName, slug, type, now()]);
        await tx.run(
          `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
           VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
          [userId, orgId, email.toLowerCase().trim(), passwordHash, ownerName, now()]);
        // Enterprise (gym) signups start in SETUP -- the dashboard gates
        // most features behind onboarding + a purchased package (see
        // enterprise.js). Independent-client-style orgs (type:
        // 'independent', used only by /auth/google's own org bootstrap,
        // never by this route's own UI) have no such concept and never
        // read this table, so leaving it unset for them is correct.
        if (type === 'gym') {
          await tx.run(`INSERT INTO org_billing_state (org_id, status, updated_at) VALUES (?, 'SETUP', ?)`, [orgId, now()]);
        }
        if (contactPhone || country || city || address) {
          await tx.run(
            `INSERT INTO gym_settings (org_id, contact_email, contact_phone, address, city, country, updated_at) VALUES (?,?,?,?,?,?,?)`,
            [orgId, email.toLowerCase().trim(), contactPhone || null, address || null, city || null, country || null, now()]);
        }
      });
      await track(db, { orgId, userId, type: 'org_created', data: { orgName } });
      // Phase 2: mirrors the primary org_id/role relationship just
      // created into gym_memberships too, so multi-gym features (switch-
      // gym, permission checks scoped per-membership) see this owner's
      // home gym from day one, without needing a separate backfill.
      await syncPrimaryMembership(db, { userId, orgId, role: 'GYM_OWNER' }).catch(() => {});
      const user = { id: userId, org_id: orgId, role: 'GYM_OWNER', name: ownerName, email: email.toLowerCase().trim() };
      const token = signToken(user);
      setAuthCookie(res, token);
      res.status(201).json({ token, user: { id: userId, name: ownerName, email: user.email, role: 'GYM_OWNER', orgId, orgName, orgSlug: slug } });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
      throw e;
    }
  });

  // ---- password change (authenticated) ----
  r.post('/change-password', requireAuth, validate(z.object({
    current_password: z.string().min(1),
    new_password: z.string().min(6)
  })), async (req, res) => {
    const user = await db.q1('SELECT * FROM users WHERE id = ?', [req.user.sub]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!(await verifyPassword(req.body.current_password, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?',
      [await hashPassword(req.body.new_password), user.id]);
    res.json({ ok: true });
  });

  // ---- Phase 2: multi-gym identity ----
  // A user's SINGLE primary org (users.org_id, still the source of
  // truth for every existing route) is what the JWT's `org` claim
  // normally carries. These two routes are the ADDITIVE layer on top:
  // list every gym this user also has an active membership at, and
  // (only if one genuinely exists -- never a bare client-supplied org
  // id) re-sign a fresh token scoped to it for this session. Switching
  // never mutates users.org_id/role -- it's a per-session context
  // change, not a permanent identity change.
  r.get('/my-gyms', requireAuth, async (req, res) => {
    const memberships = await listUserMemberships(db, req.user.sub);
    res.json({ memberships, currentOrgId: req.user.org || null });
  });

  r.post('/switch-gym', requireAuth, validate(z.object({ orgId: z.string().min(1) })), async (req, res) => {
    const membership = await getActiveMembership(db, { userId: req.user.sub, orgId: req.body.orgId });
    if (!membership) return res.status(403).json({ error: 'You do not have an active membership at that gym' });
    const user = await db.q1('SELECT id, name, email FROM users WHERE id = ?', [req.user.sub]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const token = signToken({ id: user.id, org_id: membership.org_id, role: membership.role, name: user.name, email: user.email });
    setAuthCookie(res, token);
    const org = await db.q1('SELECT id, name, slug FROM organizations WHERE id = ?', [membership.org_id]);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: membership.role, orgId: membership.org_id, orgName: org?.name || null, orgSlug: org?.slug || null } });
  });

  r.get('/me', requireAuth, async (req, res) => {
    const user = await db.q1(
      `SELECT u.id, u.name, u.email, u.role, u.org_id, u.avatar,
              u.terms_accepted_at, u.terms_version,
              o.name AS org_name, o.slug AS org_slug
         FROM users u LEFT JOIN organizations o ON o.id = u.org_id
        WHERE u.id = ?`, [req.user.sub]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  });

  // ---- Legal consent / Terms & Conditions ----
  // Current required terms version. Bump this value when terms are
  // materially updated — every user who accepted an older version
  // (or has never accepted) will be prompted again.
  const REQUIRED_TERMS_VERSION = '1.0';

  // Returns the user's terms acceptance status.
  r.get('/terms/status', requireAuth, async (req, res) => {
    const user = await db.q1(
      'SELECT terms_accepted_at, terms_version FROM users WHERE id = ?',
      [req.user.sub]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const accepted = !!user.terms_accepted_at && user.terms_version === REQUIRED_TERMS_VERSION;
    res.json({
      accepted,
      requiredVersion: REQUIRED_TERMS_VERSION,
      acceptedVersion: user.terms_version || null,
      acceptedAt: user.terms_accepted_at || null,
    });
  });

  // Record the user's acceptance of the current terms version.
  r.post('/terms/accept', requireAuth, async (req, res) => {
    const { version } = req.body || {};
    if (version !== REQUIRED_TERMS_VERSION) {
      return res.status(400).json({ error: 'Invalid terms version' });
    }
    await db.run(
      'UPDATE users SET terms_accepted_at = ?, terms_version = ? WHERE id = ?',
      [now(), version, req.user.sub]);
    res.json({ ok: true, acceptedAt: now(), version });
  });

  return r;
}
