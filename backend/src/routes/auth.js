import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { hashPassword, verifyPassword, signToken, setAuthCookie, requireAuth } from '../auth.js';
import { rateLimit } from '../rateLimit.js';
import { validate } from '../validate.js';
import { id, now } from '../ids.js';
import { track } from '../services/events.js';
import { config } from '../config.js';

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
  r.post('/register', rateLimit({ windowMs: 60_000, max: 10 }),
    validate(z.object({
      name: z.string().min(1).max(80),
      email: z.string().email(),
      password: z.string().min(6),
      gymCode: z.string().min(1).max(80)
    })), async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
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

  // Create a new organization + owner (multi-tenant onboarding).
  // PRODUCTION SAFETY: In production/staging, SETUP_SECRET env var must be set.
  // The client must send it in the X-Setup-Secret header. In development mode
  // the endpoint is open (no secret required) to keep local dev effortless.
  const setupSecret = process.env.SETUP_SECRET || '';
  const isSetupLocked = config.nodeEnv === 'production' || config.nodeEnv === 'staging';
  r.post('/setup-org', rateLimit({ windowMs: 60_000, max: 10 }),
    validate(z.object({
      orgName: z.string().min(2).max(80),
      ownerName: z.string().min(2).max(80),
      email: z.string().email(),
      password: z.string().min(6),
      type: z.enum(['gym', 'independent']).default('gym')
    })), async (req, res) => {
    // Production gate: require a valid setup secret
    if (isSetupLocked) {
      const provided = req.headers['x-setup-secret'] || '';
      const providedBuf = Buffer.from(provided, 'utf8');
      const secretBuf = Buffer.from(setupSecret, 'utf8');
      // timingSafeEqual requires equal-length buffers; compare length first
      // to avoid a RangeError crash. Different lengths → invalid secret.
      const lengthOk = providedBuf.length === secretBuf.length;
      const contentOk = lengthOk && crypto.timingSafeEqual(providedBuf, secretBuf);
      if (!setupSecret || !contentOk) {
        return res.status(403).json({ error: 'Setup not available. An invitation is required.' });
      }
    }
    const { orgName, ownerName, email, password, type } = req.body;
    const orgId = id('org');
    const userId = id('usr');
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + orgId.slice(-4);
    try {
      // Hashed before the transaction opens — bcrypt is CPU-bound, no reason
      // to hold a DB connection (Postgres: a pooled one) for it.
      const passwordHash = await hashPassword(password);
      // Was two separate db.run() calls: a failure on the second (e.g. a
      // duplicate email) left the organization row committed with no
      // owner — an orphaned org, unrecoverable except by hand, and its slug
      // permanently unavailable to a retry. Same db.tx() pattern already
      // used for workout completion.
      await db.tx(async (tx) => {
        await tx.run('INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, ?, ?)',
          [orgId, orgName, slug, type, now()]);
        await tx.run(
          `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
           VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
          [userId, orgId, email.toLowerCase().trim(), passwordHash, ownerName, now()]);
      });
      await track(db, { orgId, userId, type: 'org_created', data: { orgName } });
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

  r.get('/me', requireAuth, async (req, res) => {
    const user = await db.q1(
      `SELECT u.id, u.name, u.email, u.role, u.org_id, u.avatar,
              o.name AS org_name, o.slug AS org_slug
         FROM users u LEFT JOIN organizations o ON o.id = u.org_id
        WHERE u.id = ?`, [req.user.sub]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  });

  return r;
}
