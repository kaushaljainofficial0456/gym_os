import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, orgScope } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { isIndependentOrg } from '../services/orgKind.js';
import {
  getMembership, setMembership, getCommunitySettings,
  leaderboards, feed, shareWorkout, unshareWorkout, copyWorkout,
  resolveMembers,
} from '../services/community.js';
import {
  communityOverview, memberDirectory, recentPRs,
} from '../services/communityIntel.js';
import {
  REACTIONS, isValidReaction, isValidTarget, targetExists,
  toggleReaction, reactionsFor, addComment, listComments, deleteComment,
  commentCountsFor, activeChallenges, createChallenge, deleteChallenge,
} from '../services/communitySocial.js';
import { todayKey } from '../utils/time.js';

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
    // The community is a GYM community -- there is no gym, and no fellow
    // members, for an independent client, so it is reported as
    // unavailable rather than as an empty community they can join.
    // (The independent org's gym_settings row never set community_enabled,
    // so it inherited the schema default of 1 and these users were being
    // offered a community that cannot exist -- see services/orgKind.js.)
    const independent = await isIndependentOrg(db, req.orgId);
    res.json({
      membership: membership || { client_id: client.id, enabled: 0 },
      settings: independent ? { ...settings, community_enabled: false, leaderboard_enabled: false } : settings,
      available: !independent,
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

  // ---- Overview (pulse, position, activity, PRs, recap) ----
  //
  // One request rather than six. Beyond the round trips, it keeps the
  // page INTERNALLY CONSISTENT: six independent calls can straddle
  // midnight or a workout being logged, and the pulse then contradicts
  // the position rendered beside it.
  r.get('/overview', async (req, res) => {
    let clientId = null;
    if (req.user.role === 'CLIENT') {
      const client = await getClient(req, res);
      if (!client) return;
      const membership = await getMembership(db, client.id);
      if (!membership || !membership.enabled) {
        return res.status(403).json({ error: 'Join the community to view it' });
      }
      clientId = client.id;
    }
    const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'week';
    const data = await communityOverview(db, { orgId: req.orgId, clientId, period, tz: req.tz });
    const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [req.orgId]);
    res.json({ gym: { id: req.orgId, name: org?.name || 'Your Gym' }, ...data });
  });

  // ---- Members ----
  r.get('/members', async (req, res) => {
    if (req.user.role === 'CLIENT') {
      const client = await getClient(req, res);
      if (!client) return;
      const membership = await getMembership(db, client.id);
      if (!membership || !membership.enabled) {
        return res.status(403).json({ error: 'Join the community to see members' });
      }
    }
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 60, 200));
    const search = req.query.q ? String(req.query.q).slice(0, 60) : null;
    const members = await memberDirectory(db, req.orgId, req.tz, { limit, search });
    res.json({ members });
  });

  // ---- PR activity ----
  r.get('/prs', async (req, res) => {
    if (req.user.role === 'CLIENT') {
      const client = await getClient(req, res);
      if (!client) return;
      const membership = await getMembership(db, client.id);
      if (!membership || !membership.enabled) {
        return res.status(403).json({ error: 'Join the community to view PR activity' });
      }
    }
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 50));
    const prs = await recentPRs(db, req.orgId, { limit });
    res.json({ prs });
  });

  // ---- Reactions ----
  //
  // Membership is re-checked on every write. A member who left the
  // community keeps a valid JWT until it expires, so the token alone is
  // not evidence they may still post into it.
  r.post('/reactions', writeLimit, validate(z.object({
    target_type: z.string().min(1).max(20),
    target_id: z.string().min(1).max(60),
    emoji: z.string().min(1).max(20),
  })), async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;
    const membership = await getMembership(db, client.id);
    if (!membership || !membership.enabled) {
      return res.status(403).json({ error: 'Join the community first' });
    }
    const { target_type: targetType, target_id: targetId, emoji } = req.body;
    if (!isValidTarget(targetType)) return res.status(422).json({ error: 'Unknown target type' });
    if (!isValidReaction(emoji)) {
      return res.status(422).json({ error: 'Reaction must be one of: ' + REACTIONS.join(', ') });
    }
    // Never attach to something that does not exist in THIS org -- see
    // targetExists for the cross-org leak it closes.
    if (!(await targetExists(db, req.orgId, targetType, targetId))) {
      return res.status(404).json({ error: 'That post no longer exists' });
    }
    const out = await toggleReaction(db, {
      orgId: req.orgId, clientId: client.id, targetType, targetId, emoji,
    });
    res.json({ ok: true, ...out });
  });

  // ---- Comments ----
  r.get('/comments', async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;
    const membership = await getMembership(db, client.id);
    if (!membership || !membership.enabled) {
      return res.status(403).json({ error: 'Join the community first' });
    }
    const targetType = String(req.query.target_type || '');
    const targetId = String(req.query.target_id || '');
    if (!isValidTarget(targetType) || !targetId) {
      return res.status(422).json({ error: 'target_type and target_id are required' });
    }
    const comments = await listComments(db, { orgId: req.orgId, targetType, targetId });
    res.json({ comments, you: client.id });
  });

  r.post('/comments', writeLimit, validate(z.object({
    target_type: z.string().min(1).max(20),
    target_id: z.string().min(1).max(60),
    body: z.string().min(1).max(500),
  })), async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;
    const membership = await getMembership(db, client.id);
    if (!membership || !membership.enabled) {
      return res.status(403).json({ error: 'Join the community first' });
    }
    const { target_type: targetType, target_id: targetId, body } = req.body;
    if (!isValidTarget(targetType)) return res.status(422).json({ error: 'Unknown target type' });
    if (!String(body).trim()) return res.status(422).json({ error: 'Write something first' });
    if (!(await targetExists(db, req.orgId, targetType, targetId))) {
      return res.status(404).json({ error: 'That post no longer exists' });
    }
    const out = await addComment(db, {
      orgId: req.orgId, clientId: client.id, targetType, targetId, body,
    });
    res.status(201).json({ ok: true, ...out });
  });

  r.delete('/comments/:id', writeLimit, async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;
    const removed = await deleteComment(db, {
      orgId: req.orgId, clientId: client.id, commentId: req.params.id,
    });
    // Same 404 whether the comment is missing or belongs to someone else:
    // distinguishing them would confirm another member's comment id.
    if (!removed) return res.status(404).json({ error: 'Comment not found' });
    res.json({ ok: true });
  });

  // ---- Social counts for a page of feed items ----
  //
  // The feed asks for its reaction/comment counts in ONE request for the
  // whole page instead of one per card, so the cost does not grow with
  // the length of the feed.
  r.post('/social', validate(z.object({
    targets: z.array(z.object({
      type: z.string().min(1).max(20),
      id: z.string().min(1).max(60),
    })).max(100),
  })), async (req, res) => {
    const client = await getClient(req, res);
    if (!client) return;
    const membership = await getMembership(db, client.id);
    if (!membership || !membership.enabled) {
      return res.status(403).json({ error: 'Join the community first' });
    }
    const targets = req.body.targets.filter((t) => isValidTarget(t.type));
    const [reactions, comments] = await Promise.all([
      reactionsFor(db, { orgId: req.orgId, clientId: client.id, targets }),
      commentCountsFor(db, { orgId: req.orgId, targets }),
    ]);
    const out = {};
    for (const t of targets) {
      const key = t.type + ':' + t.id;
      out[key] = {
        ...(reactions.get(key) || { counts: {}, mine: [], total: 0 }),
        comments: comments.get(key) || 0,
      };
    }
    res.json({ social: out, reactions: REACTIONS });
  });

  // ---- Challenges ----
  r.get('/challenges', async (req, res) => {
    let clientId = null;
    if (req.user.role === 'CLIENT') {
      const client = await getClient(req, res);
      if (!client) return;
      const membership = await getMembership(db, client.id);
      if (!membership || !membership.enabled) {
        return res.status(403).json({ error: 'Join the community first' });
      }
      clientId = client.id;
    }
    const challenges = await activeChallenges(db, {
      orgId: req.orgId, clientId, today: todayKey(req.tz),
    });
    res.json({ challenges });
  });

  // Staff only: a challenge is a gym-wide object, so a member cannot
  // create one for everyone else.
  r.post('/challenges', writeLimit, validate(z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    metric: z.enum(['workouts', 'volume', 'prs']),
    goal: z.number().positive().max(10000000),
    scope: z.enum(['member', 'community']).optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })), async (req, res) => {
    if (!['GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only gym staff can create challenges' });
    }
    const b = req.body;
    if (b.end_date < b.start_date) {
      return res.status(422).json({ error: 'The challenge cannot end before it starts' });
    }
    const out = await createChallenge(db, {
      orgId: req.orgId, name: b.name, description: b.description, metric: b.metric,
      goal: b.goal, scope: b.scope, startDate: b.start_date, endDate: b.end_date,
      createdBy: req.user.sub,
    });
    res.status(201).json({ ok: true, ...out });
  });

  r.delete('/challenges/:id', writeLimit, async (req, res) => {
    if (!['GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only gym staff can remove challenges' });
    }
    const removed = await deleteChallenge(db, { orgId: req.orgId, challengeId: req.params.id });
    if (!removed) return res.status(404).json({ error: 'Challenge not found' });
    res.json({ ok: true });
  });

  return r;
}
