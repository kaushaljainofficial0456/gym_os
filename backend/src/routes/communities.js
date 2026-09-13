// ============================================================
// FRIEND COMMUNITIES — /api/communities
//
// Every route acts AS a client. A community is about training together,
// and only client accounts have workouts, records and streaks to share;
// staff accounts get a clear 403 rather than an empty page.
//
// AUTHORIZATION happens on the server, in two steps, on every request:
//   1. actingClient()     the caller has an active client profile
//   2. loadCommunityFor() the caller is an ACTIVE member of the community
//                         in the URL -- otherwise 404, identical to a
//                         community that does not exist
// Roles are read from the database each time. Nothing in a request body
// can grant a permission: validate() strips unknown fields, and no route
// reads a role, owner id or permission from the client.
//
// The gym community's routes (routes/community.js) are untouched. The two
// share the analytics engine underneath and nothing else: being in a
// friend community with someone never opens their gym's community, and a
// share into one never appears in the other.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, orgScope } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import {
  CommunityError, fail, loadCommunityFor, communityDTO, THEMES, MARKS, LIMITS,
  createCommunity, listForClient, gymCard, updateCommunity, deleteCommunity, leaveCommunity,
  removeMember, setMemberRole, transferOwnership, updateMySettings,
  generateCode, listInvites, revokeInvite, previewCode, redeemCode, inviteCandidates,
  createDirectInvite, listMyInvites, respondToInvite, CODE_EXPIRY_DAYS, CODE_MAX_USES,
  listEvents, shareToCommunity, shareTargets, shareableWorkouts, deleteEvent, copyEventWorkout,
  toggleEventReaction, socialForEvents,
  listEventComments, addEventComment, deleteEventComment, FEED_FILTERS,
  friendOverview, friendLeaderboards, friendMembers, memberProfile, listGroupChallenges,
  challengeDetail, createGroupChallenge, deleteGroupChallenge, CHALLENGE_METRICS, cleanPeriod,
  METRIC_DEFINITIONS,
} from '../services/friendCommunities/index.js';

const idParam = z.string().min(1).max(64);

export default function communitiesRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);

  // Per authenticated user, not per IP: friends on one gym's wifi must not
  // throttle each other.
  const perUser = (req) => req.user?.sub || 'anon';
  const writeLimit = rateLimit({ windowMs: 60_000, max: 40, keyFn: perUser });
  const inviteLimit = rateLimit({ windowMs: 60_000, max: 20, keyFn: perUser });
  // Code redemption is the one guessable surface; see invites.js for the
  // arithmetic this limit is part of.
  const joinLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: perUser });

  /** CommunityError -> { error, reason } at its status; anything else is a
   *  real failure and goes to the app's error handler. */
  const handle = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof CommunityError) {
        return res.status(e.status).json({ error: e.message, reason: e.code });
      }
      return next(e);
    }
  };

  async function actingClient(req) {
    const client = await db.q1(
      `SELECT c.id, c.org_id, c.user_id FROM clients c JOIN users u ON u.id = c.user_id
        WHERE c.user_id = ? AND u.active = 1`,
      [req.user.sub]);
    if (!client) fail(403, 'no_client_profile', 'Communities are available on member accounts');
    return client;
  }

  async function context(req) {
    const client = await actingClient(req);
    const { community, membership } = await loadCommunityFor(db, req.params.id, client.id);
    return { client, community, membership };
  }

  const options = () => ({
    themes: THEMES,
    marks: MARKS,
    feedFilters: Object.keys(FEED_FILTERS),
    challengeMetrics: CHALLENGE_METRICS,
    codeExpiryDays: CODE_EXPIRY_DAYS,
    codeMaxUses: CODE_MAX_USES,
  });

  // ================= home =================

  r.get('/', handle(async (req, res) => {
    const client = await actingClient(req);
    const [gym, communities, invites] = await Promise.all([
      gymCard(db, { client, orgId: req.orgId, tz: req.tz }),
      listForClient(db, { clientId: client.id, tz: req.tz }),
      listMyInvites(db, { clientId: client.id }),
    ]);
    res.json({
      gym, communities, invites,
      limits: { maxOwned: LIMITS.maxOwned, maxMembers: LIMITS.maxMembers },
      options: options(),
    });
  }));

  r.post('/', writeLimit, validate(z.object({
    name: z.string().max(200),
    description: z.string().max(1000).nullish(),
    theme: z.string().max(20).nullish(),
    mark: z.string().max(16).nullish(),
  })), handle(async (req, res) => {
    const client = await actingClient(req);
    res.status(201).json(await createCommunity(db, { client, ...req.body }));
  }));

  // ================= invitations addressed to me =================
  // Registered before /:id so "invites" is never read as a community id.

  r.post('/invites/:inviteId/accept', inviteLimit, handle(async (req, res) => {
    const client = await actingClient(req);
    res.json(await respondToInvite(db, { inviteId: req.params.inviteId, client, accept: true }));
  }));

  r.post('/invites/:inviteId/decline', inviteLimit, handle(async (req, res) => {
    const client = await actingClient(req);
    res.json(await respondToInvite(db, { inviteId: req.params.inviteId, client, accept: false }));
  }));

  // ================= invite codes =================

  r.get('/join/:code', joinLimit, handle(async (req, res) => {
    const client = await actingClient(req);
    res.set('Cache-Control', 'no-store');
    res.json(await previewCode(db, String(req.params.code || '').slice(0, 40), { clientId: client.id }));
  }));

  r.post('/join', joinLimit, validate(z.object({ code: z.string().max(40) })), handle(async (req, res) => {
    const client = await actingClient(req);
    const out = await redeemCode(db, { rawCode: req.body.code, client });
    res.status(out.already ? 200 : 201).json(out);
  }));

  // ================= share destinations for one workout =================

  r.get('/share-targets', handle(async (req, res) => {
    const client = await actingClient(req);
    const workoutId = String(req.query.workout_id || '').slice(0, 64);
    res.json(await shareTargets(db, { client, orgId: req.orgId, workoutId }));
  }));

  // ================= one community =================

  r.get('/:id', handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json({ community: communityDTO(community, membership), options: options() });
  }));

  r.patch('/:id', writeLimit, validate(z.object({
    name: z.string().max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    theme: z.string().max(20).optional(),
    mark: z.string().max(16).nullable().optional(),
  })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    await updateCommunity(db, { community, membership, patch: req.body });
    const fresh = await loadCommunityFor(db, community.id, membership.client_id);
    res.json({ community: communityDTO(fresh.community, fresh.membership) });
  }));

  r.delete('/:id', writeLimit, validate(z.object({ confirm_name: z.string().max(200) })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await deleteCommunity(db, { community, membership, confirmName: req.body.confirm_name }));
  }));

  r.get('/:id/overview', handle(async (req, res) => {
    const { community, membership } = await context(req);
    const data = await friendOverview(db, {
      community, membership, period: cleanPeriod(req.query.period), tz: req.tz,
    });
    res.json({ community: communityDTO(community, membership), ...data });
  }));

  r.get('/:id/leaderboards', handle(async (req, res) => {
    const { community } = await context(req);
    res.json(await friendLeaderboards(db, { community, period: cleanPeriod(req.query.period), tz: req.tz }));
  }));

  r.get('/:id/metric-definitions', handle(async (req, res) => {
    await context(req);
    res.json({ definitions: METRIC_DEFINITIONS });
  }));

  // ================= feed =================

  r.get('/:id/feed', handle(async (req, res) => {
    const { community, membership } = await context(req);
    const filter = Object.prototype.hasOwnProperty.call(FEED_FILTERS, req.query.filter) ? req.query.filter : 'all';
    const rawLimit = parseInt(req.query.limit, 10);
    res.json(await listEvents(db, {
      community,
      viewerClientId: membership.client_id,
      cursor: req.query.cursor ? String(req.query.cursor) : null,
      limit: Number.isFinite(rawLimit) ? rawLimit : 15,
      filter,
    }));
  }));

  r.get('/:id/shareable-workouts', handle(async (req, res) => {
    const { client, community } = await context(req);
    res.json({ workouts: await shareableWorkouts(db, { community, client }) });
  }));

  r.post('/:id/shares', writeLimit, validate(z.object({
    workout_id: idParam,
    include_workout: z.boolean().optional(),
    include_prs: z.boolean().optional(),
  })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.status(201).json(await shareToCommunity(db, {
      community,
      membership,
      workoutId: req.body.workout_id,
      includeWorkout: req.body.include_workout ?? true,
      includePrs: req.body.include_prs ?? false,
    }));
  }));

  r.delete('/:id/events/:eventId', writeLimit, handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await deleteEvent(db, { community, membership, eventId: req.params.eventId }));
  }));

  // Take a friend's shared session into your own planner.
  r.post('/:id/events/:eventId/copy', writeLimit, handle(async (req, res) => {
    const { client, community } = await context(req);
    res.status(201).json(await copyEventWorkout(db, { community, client, eventId: req.params.eventId }));
  }));

  r.post('/:id/social', validate(z.object({ event_ids: z.array(idParam).max(100) })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json({ social: await socialForEvents(db, { community, clientId: membership.client_id, eventIds: req.body.event_ids }) });
  }));

  r.post('/:id/reactions', writeLimit, validate(z.object({
    event_id: idParam,
    emoji: z.string().min(1).max(20),
  })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await toggleEventReaction(db, { community, membership, eventId: req.body.event_id, emoji: req.body.emoji }));
  }));

  r.get('/:id/comments', handle(async (req, res) => {
    const { community, membership } = await context(req);
    const comments = await listEventComments(db, {
      community, viewerClientId: membership.client_id, eventId: String(req.query.event_id || ''),
    });
    res.json({ comments });
  }));

  r.post('/:id/comments', writeLimit, validate(z.object({
    event_id: idParam,
    body: z.string().max(2000),
  })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.status(201).json(await addEventComment(db, {
      community, membership, eventId: req.body.event_id, body: req.body.body,
    }));
  }));

  r.delete('/:id/comments/:commentId', writeLimit, handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await deleteEventComment(db, { community, membership, commentId: req.params.commentId }));
  }));

  // ================= members =================

  r.get('/:id/members', handle(async (req, res) => {
    const { community, membership } = await context(req);
    const search = req.query.q ? String(req.query.q).slice(0, 60) : null;
    res.json({ members: await friendMembers(db, { community, membership, tz: req.tz, search }) });
  }));

  r.get('/:id/members/:clientId', handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await memberProfile(db, { community, membership, targetClientId: req.params.clientId, tz: req.tz }));
  }));

  r.patch('/:id/members/:clientId', writeLimit, validate(z.object({
    role: z.enum(['admin', 'member']),
  })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await setMemberRole(db, { community, membership, targetClientId: req.params.clientId, role: req.body.role }));
  }));

  r.delete('/:id/members/:clientId', writeLimit, handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await removeMember(db, { community, membership, targetClientId: req.params.clientId }));
  }));

  r.post('/:id/transfer', writeLimit, validate(z.object({ client_id: idParam })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await transferOwnership(db, { community, membership, targetClientId: req.body.client_id }));
  }));

  r.post('/:id/leave', writeLimit, handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await leaveCommunity(db, { community, membership }));
  }));

  r.patch('/:id/me', writeLimit, validate(z.object({
    share_stats: z.boolean().optional(),
    show_gym: z.boolean().optional(),
    muted: z.boolean().optional(),
  })), handle(async (req, res) => {
    const { membership } = await context(req);
    const you = await updateMySettings(db, {
      membership,
      patch: { shareStats: req.body.share_stats, showGym: req.body.show_gym, muted: req.body.muted },
    });
    res.json({ you });
  }));

  // ================= invitations (owners & admins) =================

  r.get('/:id/invites', handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await listInvites(db, { community, membership }));
  }));

  r.post('/:id/invites', inviteLimit, validate(z.object({ client_id: idParam })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.status(201).json(await createDirectInvite(db, {
      community, membership, orgId: req.orgId, inviteeClientId: req.body.client_id,
    }));
  }));

  r.delete('/:id/invites/:inviteId', writeLimit, handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await revokeInvite(db, { community, membership, inviteId: req.params.inviteId }));
  }));

  r.post('/:id/codes', inviteLimit, validate(z.object({
    expires_in_days: z.number().int().optional(),
    max_uses: z.number().int().optional(),
  })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.set('Cache-Control', 'no-store');
    res.status(201).json(await generateCode(db, {
      community,
      membership,
      expiresInDays: req.body.expires_in_days ?? 7,
      maxUses: req.body.max_uses ?? 25,
    }));
  }));

  r.get('/:id/candidates', handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json({ people: await inviteCandidates(db, { community, membership, orgId: req.orgId, q: req.query.q }) });
  }));

  // ================= challenges =================

  r.get('/:id/challenges', handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await listGroupChallenges(db, { community, clientId: membership.client_id, tz: req.tz }));
  }));

  r.post('/:id/challenges', writeLimit, validate(z.object({
    name: z.string().max(200),
    description: z.string().max(1000).nullish(),
    metric: z.string().max(20),
    goal: z.number(),
    scope: z.enum(['member', 'community']).optional(),
    start_date: z.string().max(10),
    end_date: z.string().max(10),
  })), handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.status(201).json(await createGroupChallenge(db, { community, membership, input: req.body, tz: req.tz }));
  }));

  r.get('/:id/challenges/:challengeId', handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await challengeDetail(db, { community, membership, challengeId: req.params.challengeId, tz: req.tz }));
  }));

  r.delete('/:id/challenges/:challengeId', writeLimit, handle(async (req, res) => {
    const { community, membership } = await context(req);
    res.json(await deleteGroupChallenge(db, { community, membership, challengeId: req.params.challengeId }));
  }));

  return r;
}
