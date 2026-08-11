import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword, signToken, requireAuth } from '../auth.js';
import { rateLimit } from '../rateLimit.js';
import { validate } from '../validate.js';
import { id, now } from '../ids.js';
import { track } from '../services/events.js';

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
    if (!user || !(await verifyPassword(req.body.password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.active) return res.status(403).json({ error: 'Account disabled' });
    const org = user.org_id ? await db.q1('SELECT id, name, slug FROM organizations WHERE id = ?', [user.org_id]) : null;
    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        orgId: user.org_id, orgName: org?.name || null
      }
    });
  });

  // Create a new organization + owner (multi-tenant onboarding).
  r.post('/setup-org', rateLimit({ windowMs: 60_000, max: 10 }),
    validate(z.object({
      orgName: z.string().min(2).max(80),
      ownerName: z.string().min(2).max(80),
      email: z.string().email(),
      password: z.string().min(6),
      type: z.enum(['gym', 'independent']).default('gym')
    })), async (req, res) => {
    const { orgName, ownerName, email, password, type } = req.body;
    const orgId = id('org');
    const userId = id('usr');
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + orgId.slice(-4);
    try {
      await db.run('INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, ?, ?)',
        [orgId, orgName, slug, type, now()]);
      await db.run(
        `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
         VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
        [userId, orgId, email.toLowerCase().trim(), await hashPassword(password), ownerName, now()]);
      await track(db, { orgId, userId, type: 'org_created', data: { orgName } });
      const user = { id: userId, org_id: orgId, role: 'GYM_OWNER', name: ownerName, email: email.toLowerCase().trim() };
      res.status(201).json({ token: signToken(user), user: { id: userId, name: ownerName, email: user.email, role: 'GYM_OWNER', orgId, orgName } });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
      throw e;
    }
  });

  r.get('/me', requireAuth, async (req, res) => {
    const user = await db.q1(
      `SELECT u.id, u.name, u.email, u.role, u.org_id, u.avatar,
              o.name AS org_name
         FROM users u LEFT JOIN organizations o ON o.id = u.org_id
        WHERE u.id = ?`, [req.user.sub]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  });

  return r;
}
