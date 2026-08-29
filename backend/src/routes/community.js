import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, orgScope } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import {
  getMembership, setMembership, getCommunitySettings,
  leaderboards, feed, shareWorkout, unshareWorkout, copyWorkout,
  resolveMembers,
} from '../services/community.js';

export default function communityRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);

  // Community writes are user-triggered and cheap to spam (a double-tapped
  // Share button, a held-down Join toggle), and every one of them writes to
  // the DB. Same shape/keyFn as admin.js's own action limiters -- per
  // authenticated user, not per IP, so one gym behind a single NAT can't
  // rate-limit its own members.
  const writeLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });

  // Resolve the authenticated client (CLIENT role only for mutations)
  const getClient = async (req, res) => {
    const c = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!c) { res.status(404).json({ error: 'No client profile linked to this account' }); return null; }
    return c;
  };

  // ---- Membership ----

  r.get('/membership', async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;
    const membership = await getMembership(db, client.id);
    const settings = await getCommunitySettings(db, req.orgId);
    const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [req.orgId]);
    res.json({
      membership: membership || { client_id: client.id, enabled: 0 },
      settings,
      gym: { id: req.orgId, name: org?.name || 'Your Gym' },
    });
  });

  r.put('/membership', writeLimit, validate(z.object({ enabled: z.boolean() })), async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;
    const settings = await getCommunitySettings(db, req.orgId);
    if (!settings.community_enabled && req.body.enabled) {
      return res.status(403).json({ error: 'Community is disabled by your gym' });
    }
    await setMembership(db, client.id, req.orgId, req.body.enabled);
    res.json({ ok: true, enabled: req.body.enabled });
  });

  // ---- Leaderboards ----

  r.get('/leaderboards', async (req, res) => {
    // Clients must be community members to view; trainers/owners have read-only access
    if (req.user.role === 'CLIENT') {
      const client = await getClient(req, res);
      if (!client) return;
      const membership = await getMembership(db, client.id);
      if (!membership || !membership.enabled) {
        return res.status(403).json({ error: 'Join the community to view leaderboards' });
      }
    }

    const period = ['day', 'week', 'month', 'all'].includes(req.query.period)
      ? req.query.period : 'week';

    const result = await leaderboards(db, req.orgId, period, req.tz);

    // Resolve names/avatars — omit avatars to keep payload small
    const allIds = new Set();
    for (const board of Object.values(result.leaderboards)) {
      for (const entry of board) allIds.add(entry.clientId);
    }
    const members = await resolveMembers(db, [...allIds]);

    // Enrich boards (no avatar data URLs — use initials via frontend)
    const enrich = (board) => board.map(entry => {
      const m = members.get(entry.clientId) || {};
      return { ...entry, name: m.name || 'Member' };
    });

    const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [req.orgId]);
    res.json({
      gym: { id: req.orgId, name: org?.name || 'Your Gym' },
      ...result,
      leaderboards: {
        streak: enrich(result.leaderboards.streak),
        volume: enrich(result.leaderboards.volume),
        completedWorkouts: enrich(result.leaderboards.completedWorkouts),
      },
    });
  });

  // ---- Feed ----

  r.get('/feed', async (req, res) => {
    // Clients must be community members to view; trainers/owners have read-only access
    if (req.user.role === 'CLIENT') {
      const client = await getClient(req, res);
      if (!client) return;
      const membership = await getMembership(db, client.id);
      if (!membership || !membership.enabled) {
        return res.status(403).json({ error: 'Join the community to view the feed' });
      }
    }

    // Clamp to [1, 100]. The lower bound is not cosmetic: parseInt('-5') is
    // -5, which is truthy, so it survived the `|| 30` default and
    // Math.min(-5, 100) kept it -- sending LIMIT -5 to the database. SQLite
    // reads a negative LIMIT as "no limit" (the whole org's feed in one
    // response); PostgreSQL rejects it outright, so in production a client
    // could turn ?limit=-5 into a 500.
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 30, 100));
    const rawOffset = parseInt(req.query.offset, 10);
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
    const result = await feed(db, req.orgId, { limit, offset });
    res.json(result);
  });

  // ---- Share ----

  r.post('/shares', writeLimit, validate(z.object({ workout_id: z.string().min(1) })), async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;

    const membership = await getMembership(db, client.id);
    if (!membership || !membership.enabled) {
      return res.status(403).json({ error: 'Join the community first to share workouts' });
    }

    const settings = await getCommunitySettings(db, req.orgId);
    if (!settings.community_enabled) {
      return res.status(403).json({ error: 'Community is disabled by your gym' });
    }

    const result = await shareWorkout(db, {
      clientId: client.id,
      orgId: req.orgId,
      workoutId: req.body.workout_id,
    });

    if (!result) {
      return res.status(404).json({ error: 'Completed workout not found' });
    }

    res.status(201).json({ ok: true, id: result.id, workoutName: result.workoutName });
  });

  r.delete('/shares/:id', writeLimit, async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;

    const removed = await unshareWorkout(db, { clientId: client.id, shareId: req.params.id });
    if (!removed) return res.status(404).json({ error: 'Share not found' });
    res.json({ ok: true });
  });

  // ---- Copy ----

  r.post('/shares/:id/copy', writeLimit, validate(z.object({
    name: z.string().max(80).optional(),
    exercises: z.array(z.object({
      exercise_id: z.string().nullish(),
      name: z.string().min(1).max(100),
      sets: z.number().int().min(1).max(20).default(3),
      reps: z.string().max(20).default('10'),
      weight: z.string().max(20).default('BW'),
      rest_sec: z.number().int().min(0).max(600).optional(),
    })).max(20).optional(),
  })), async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;

    const membership = await getMembership(db, client.id);
    if (!membership || !membership.enabled) {
      return res.status(403).json({ error: 'Join the community first to copy workouts' });
    }

    const settings = await getCommunitySettings(db, req.orgId);
    if (!settings.community_enabled) {
      return res.status(403).json({ error: 'Community is disabled by your gym' });
    }

    const result = await copyWorkout(db, {
      shareId: req.params.id,
      clientId: client.id,
      orgId: req.orgId,
      overrides: {
        name: req.body.name,
        exercises: req.body.exercises,
      },
    });

    if (!result) {
      return res.status(404).json({ error: 'Share not found or no valid exercises' });
    }

    res.status(201).json({ ok: true, id: result.id, name: result.name, exerciseCount: result.exerciseCount });
  });

  return r;
}
