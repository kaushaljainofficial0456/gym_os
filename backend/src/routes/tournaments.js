// ============================================================
// TOURNAMENTS — /api/tournaments (signed in) and
// /api/tournaments-public (the QR page, no account needed).
//
// Open to every role: a client, trainer or owner can host or compete, so
// this acts on the USER, not on a client profile. No org scoping: one
// tournament can span gyms. Access is decided per tournament in
// services/tournaments/access.js, and nothing in a request body can grant
// a permission. Scores can only be written through the hosts' routes.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { track } from '../services/events.js';
import { EVENT_CATALOG, METRICS, THEMES, LIMITS } from '../services/tournaments/catalog.js';
import {
  TournamentError, fail, loadViewer, loadContext, canSee, requireHost, requirePrime,
  hashGuestKey, newGuestKey, phaseOf, isTrue, TOURNAMENT_SELECT,
} from '../services/tournaments/access.js';
import {
  createTournament, updateTournament, cancelTournament, addEvent, updateEvent, removeEvent, rotateCodes,
  inviteCohost, respondToInvite, removeCohost, ensureUsername, setIdentity, searchPeople, joinTournament, joinAsGuest,
  claimGuest, leaveTournament, addPeople, decideRequest, updateEntrant, removeEntrant, hub, pulse, detail, cardsFor,
} from '../services/tournaments/store.js';
import {
  loadEvent, board, startEvent, recordResult, clearResult, finishEvent, reopenEvent, finishTournament,
  results, trophyShelf,
} from '../services/tournaments/live.js';

const idParam = z.string().min(1).max(64);
const when = z.string().max(40).nullable().optional();
const eventBody = z.object({
  kind: z.string().max(40).optional(),
  name: z.string().max(80).optional(),
  metric: z.enum(Object.keys(METRICS)).optional(),
  attempts: z.number().int().min(1).max(LIMITS.attempts).optional(),
  time_cap_sec: z.number().int().min(0).max(7200).nullable().optional(),
  win_positions: z.number().int().min(1).max(LIMITS.positions).optional(),
  capacity: z.number().int().min(0).max(5000).nullable().optional(),
  is_team: z.boolean().optional(),
});
const details = z.object({
  name: z.string().max(80).optional(),
  tagline: z.string().max(140).nullable().optional(),
  venue: z.string().max(120).nullable().optional(),
  prize: z.string().max(200).nullable().optional(),
  rules: z.string().max(1000).nullable().optional(),
  theme: z.enum(THEMES).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  capacity: z.number().int().min(0).max(5000).nullable().optional(),
  overall_positions: z.number().int().min(1).max(LIMITS.positions).optional(),
  registration_opens_at: when,
  registration_closes_at: when,
  withdraw_closes_at: when,
  starts_at: when,
});
const bodyWeight = z.number().min(20).max(400).nullable().optional();
const teams = z.record(z.string().max(64), z.string().max(40)).optional();
const eventIds = z.array(idParam).max(LIMITS.events);
const joinBody = z.object({
  event_ids: eventIds,
  teams,
  body_weight: bodyWeight,
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
});

/** TournamentError -> { error, reason } at its status; the rest is a real failure. */
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof TournamentError) return res.status(e.status).json({ error: e.message, reason: e.code });
    return next(e);
  }
};

export default function tournamentRoutes(db) {
  const r = Router();
  r.use(requireAuth);

  const perUser = (req) => req.user?.sub || 'anon';
  // Live boards poll, and a scorer writes on every tap: sized for a host
  // counting a fast set of burpees while a co-host does the same.
  r.use(rateLimit({ windowMs: 60_000, max: 600, keyFn: perUser }));
  const writeLimit = rateLimit({ windowMs: 60_000, max: 60, keyFn: perUser });
  const searchLimit = rateLimit({ windowMs: 60_000, max: 40, keyFn: perUser });

  const viewerOf = (req) => loadViewer(db, req.user.sub);
  const contextOf = async (req) => loadContext(db, req.params.id, await viewerOf(req));
  const hostContext = async (req) => { const ctx = await contextOf(req); requireHost(ctx); return ctx; };
  const respond = async (res, ctx) => res.json(await detail(db, await loadContext(db, ctx.t.id, ctx.viewer)));

  // ---- home ----
  r.get('/', handle(async (req, res) => {
    res.json(await hub(db, await viewerOf(req)));
  }));

  r.get('/pulse', handle(async (req, res) => {
    res.json(await pulse(db, await viewerOf(req)));
  }));

  r.get('/options', handle(async (req, res) => {
    res.json({
      catalog: EVENT_CATALOG,
      metrics: Object.entries(METRICS).map(([key, m]) => ({ key, label: m.label, unit: m.unit })),
      themes: THEMES,
      limits: LIMITS,
    });
  }));

  r.get('/trophies', handle(async (req, res) => {
    res.json(await trophyShelf(db, req.user.sub));
  }));

  // ---- my tournament identity ----
  r.get('/identity', handle(async (req, res) => {
    const viewer = await viewerOf(req);
    res.json({ username: await ensureUsername(db, viewer), findable: isTrue(viewer.findable) });
  }));

  r.patch('/identity', writeLimit, validate(z.object({
    username: z.string().max(30).optional(),
    findable: z.boolean().optional(),
  })), handle(async (req, res) => {
    await setIdentity(db, await viewerOf(req), req.body);
    res.json({ ok: true });
  }));

  // ---- global people search ----
  r.get('/people', searchLimit, handle(async (req, res) => {
    res.json({ people: await searchPeople(db, await viewerOf(req), String(req.query.q || '').slice(0, 60)) });
  }));

  // ---- a QR scanned inside the app ----
  r.get('/code/:code', handle(async (req, res) => {
    const code = String(req.params.code || '').toUpperCase().slice(0, 12);
    const viewer = await viewerOf(req);
    const t = await findByCode(db, code);
    if (!t) fail(404, 'no_code', 'That code does not match a tournament');
    res.json({ id: t.id, event_id: t.matched_event_id || null, visible: canSee(t, viewer) });
  }));

  // ---- create ----
  r.post('/', writeLimit, validate(details.extend({
    name: z.string().min(2).max(80),
    reach: z.enum(['gym', 'everyone']).optional(),
    audience: z.enum(['everyone', 'staff']).optional(),
    events: z.array(eventBody).min(1).max(LIMITS.events),
  })), handle(async (req, res) => {
    const viewer = await viewerOf(req);
    const tournamentId = await createTournament(db, viewer, req.body);
    await track(db, { orgId: viewer.org_id, userId: viewer.id, type: 'tournament_created', data: { events: req.body.events.length } }).catch(() => {});
    res.status(201).json({ id: tournamentId });
  }));

  // ---- one tournament ----
  r.get('/:id', handle(async (req, res) => {
    res.json(await detail(db, await contextOf(req)));
  }));

  r.patch('/:id', writeLimit, validate(details), handle(async (req, res) => {
    const ctx = await hostContext(req);
    await updateTournament(db, ctx, req.body);
    await respond(res, ctx);
  }));

  r.delete('/:id', writeLimit, handle(async (req, res) => {
    const ctx = await contextOf(req);
    requirePrime(ctx);
    await cancelTournament(db, ctx);
    res.json({ ok: true });
  }));

  r.post('/:id/rotate-codes', writeLimit, handle(async (req, res) => {
    const ctx = await hostContext(req);
    await rotateCodes(db, ctx);
    await respond(res, ctx);
  }));

  r.get('/:id/audit', handle(async (req, res) => {
    const ctx = await hostContext(req);
    res.json({
      entries: await db.q(
        `SELECT a.action, a.detail, a.created_at, u.name AS actor FROM tournament_audit a
           LEFT JOIN users u ON u.id = a.actor_id WHERE a.tournament_id=? ORDER BY a.created_at DESC LIMIT 200`, [ctx.t.id]),
    });
  }));

  // ---- competitions ----
  r.post('/:id/events', writeLimit, validate(eventBody), handle(async (req, res) => {
    const ctx = await hostContext(req);
    await addEvent(db, ctx, req.body);
    await respond(res, ctx);
  }));

  r.patch('/:id/events/:eventId', writeLimit, validate(eventBody), handle(async (req, res) => {
    const ctx = await hostContext(req);
    await updateEvent(db, ctx, await loadEvent(db, ctx.t.id, req.params.eventId), req.body);
    await respond(res, ctx);
  }));

  r.delete('/:id/events/:eventId', writeLimit, handle(async (req, res) => {
    const ctx = await hostContext(req);
    await removeEvent(db, ctx, await loadEvent(db, ctx.t.id, req.params.eventId));
    await respond(res, ctx);
  }));

  // The live board: anyone who can see the tournament can watch it.
  r.get('/:id/events/:eventId/board', handle(async (req, res) => {
    const ctx = await contextOf(req);
    const event = await loadEvent(db, ctx.t.id, req.params.eventId);
    res.set('Cache-Control', 'no-store');
    res.json({ ...(await board(db, event, ctx.viewer.id)), is_host: ctx.isHost });
  }));

  for (const [path, action] of [['start', startEvent], ['finish', finishEvent], ['reopen', reopenEvent]]) {
    r.post(`/:id/events/:eventId/${path}`, writeLimit, handle(async (req, res) => {
      const ctx = await hostContext(req);
      await action(db, ctx, await loadEvent(db, ctx.t.id, req.params.eventId));
      await respond(res, ctx);
    }));
  }

  // Hosts only. There is deliberately no route a competitor could call.
  r.put('/:id/events/:eventId/results', validate(z.object({
    subject_id: idParam,
    attempt: z.number().int().min(1).max(LIMITS.attempts).optional(),
    value: z.number(),
    valid: z.boolean().optional(),
  })), handle(async (req, res) => {
    const ctx = await hostContext(req);
    const event = await loadEvent(db, ctx.t.id, req.params.eventId);
    await recordResult(db, ctx, event, req.body);
    res.json(await board(db, event, ctx.viewer.id));
  }));

  r.delete('/:id/events/:eventId/results', validate(z.object({
    subject_id: idParam, attempt: z.number().int().min(1).max(LIMITS.attempts),
  })), handle(async (req, res) => {
    const ctx = await hostContext(req);
    const event = await loadEvent(db, ctx.t.id, req.params.eventId);
    await clearResult(db, ctx, event, req.body.subject_id, req.body.attempt);
    res.json(await board(db, event, ctx.viewer.id));
  }));

  r.post('/:id/finish', writeLimit, handle(async (req, res) => {
    const ctx = await hostContext(req);
    await finishTournament(db, ctx);
    await respond(res, ctx);
  }));

  r.get('/:id/results', handle(async (req, res) => {
    const ctx = await contextOf(req);
    res.json(await results(db, ctx.t, { viewerId: ctx.viewer.id }));
  }));

  // ---- hosts ----
  r.post('/:id/hosts', writeLimit, validate(z.object({ user_id: idParam })), handle(async (req, res) => {
    const ctx = await contextOf(req);
    requirePrime(ctx);
    await inviteCohost(db, ctx, req.body.user_id);
    await respond(res, ctx);
  }));

  r.post('/:id/hosts/respond', writeLimit, validate(z.object({ accept: z.boolean() })), handle(async (req, res) => {
    const ctx = await contextOf(req);
    await respondToInvite(db, ctx, req.body.accept);
    res.json({ ok: true });
  }));

  r.delete('/:id/hosts/:userId', writeLimit, handle(async (req, res) => {
    const ctx = await contextOf(req);
    await removeCohost(db, ctx, req.params.userId);
    res.json({ ok: true });
  }));

  // ---- joining ----
  r.post('/:id/join', writeLimit, validate(joinBody.extend({ code: z.string().max(12).optional() })), handle(async (req, res) => {
    const viaCode = !!req.body.code && await codeBelongsTo(db, req.body.code, req.params.id);
    const ctx = await loadContext(db, req.params.id, await viewerOf(req), { viaCode });
    res.json(await joinTournament(db, ctx, req.body, { viaCode }));
  }));

  r.post('/:id/leave', writeLimit, validate(z.object({ event_ids: eventIds.optional() })), handle(async (req, res) => {
    const ctx = await contextOf(req);
    await leaveTournament(db, ctx, req.body.event_ids);
    await respond(res, ctx);
  }));

  // The key was issued to whoever entered, so it opens the tournament the
  // same way their QR did, even a gym-only one.
  r.post('/:id/claim', writeLimit, validate(z.object({ key: z.string().min(10).max(80) })), handle(async (req, res) => {
    const ctx = await loadContext(db, req.params.id, await viewerOf(req), { viaCode: true });
    await claimGuest(db, ctx, hashGuestKey(req.body.key));
    res.json({ ok: true });
  }));

  // ---- the hosts' roster ----
  r.post('/:id/entrants', writeLimit, validate(z.object({
    people: z.array(z.object({
      name: z.string().max(80).optional(),
      user_id: idParam.optional(),
      gym_label: z.string().max(80).nullable().optional(),
      body_weight: bodyWeight,
      gender: z.enum(['male', 'female', 'other']).nullable().optional(),
      event_ids: eventIds.min(1),
      teams,
    })).min(1).max(100),
  })), handle(async (req, res) => {
    const ctx = await hostContext(req);
    await addPeople(db, ctx, req.body.people);
    await respond(res, ctx);
  }));

  r.post('/:id/entrants/:entrantId/decision', writeLimit, validate(z.object({ accept: z.boolean() })), handle(async (req, res) => {
    const ctx = await hostContext(req);
    await decideRequest(db, ctx, req.params.entrantId, req.body.accept);
    await respond(res, ctx);
  }));

  r.patch('/:id/entrants/:entrantId', writeLimit, validate(z.object({
    name: z.string().max(80).optional(),
    gym_label: z.string().max(80).nullable().optional(),
    body_weight: bodyWeight,
    event_ids: eventIds.optional(),
    teams,
  })), handle(async (req, res) => {
    const ctx = await hostContext(req);
    await updateEntrant(db, ctx, req.params.entrantId, req.body);
    await respond(res, ctx);
  }));

  r.delete('/:id/entrants/:entrantId', writeLimit, handle(async (req, res) => {
    const ctx = await hostContext(req);
    await removeEntrant(db, ctx, req.params.entrantId);
    await respond(res, ctx);
  }));

  return r;
}

/** A tournament from its own code, or from one of its competitions' codes. */
async function findByCode(db, code) {
  const direct = await db.q1(`${TOURNAMENT_SELECT} WHERE t.code = ?`, [code]);
  if (direct) return direct;
  const ev = await db.q1('SELECT id, tournament_id FROM tournament_events WHERE code = ?', [code]);
  if (!ev) return null;
  const t = await db.q1(`${TOURNAMENT_SELECT} WHERE t.id = ?`, [ev.tournament_id]);
  return t ? { ...t, matched_event_id: ev.id } : null;
}

async function codeBelongsTo(db, code, tournamentId) {
  const t = await findByCode(db, String(code).toUpperCase());
  return t?.id === tournamentId;
}

/**
 * What a QR or shared link opens, with no account: the tournament, live
 * boards and final results, and the guest sign-up. Names and scores are
 * what a scoreboard on a gym wall would show; nothing else leaves here.
 * A cancelled tournament, a staff-only one, or a demo gym answers 404.
 */
export function tournamentPublicRoutes(db) {
  const r = Router();
  const previewLimit = rateLimit({ windowMs: 60_000, max: 120, keyFn: (req) => req.ip || 'ip' });
  const joinLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.ip || 'ip' });

  const load = async (req) => {
    const code = String(req.params.code || '').toUpperCase().slice(0, 12);
    const t = await findByCode(db, code);
    if (!t || t.status === 'cancelled' || t.audience === 'staff' || isTrue(t.host_is_demo)) fail(404, 'no_code', 'That code does not match a tournament');
    return t;
  };

  r.get('/:code', previewLimit, handle(async (req, res) => {
    const t = await load(req);
    const [card] = await cardsFor(db, [t], null);
    const events = await db.q(
      `SELECT id, name, kind, metric, is_team, capacity, status FROM tournament_events WHERE tournament_id=? ORDER BY position`, [t.id]);
    res.set('Cache-Control', 'no-store');
    res.json({
      ...card,
      id: t.id,
      prize: t.prize,
      rules: t.rules,
      can_join: phaseOf(t) === 'open',
      events,
      matched_event_id: t.matched_event_id || null,
      results: await results(db, t),
    });
  }));

  r.post('/:code/join', joinLimit, validate(z.object({
    name: z.string().min(2).max(80),
    gym_label: z.string().max(80).optional(),
    body_weight: bodyWeight,
    event_ids: eventIds.min(1),
    teams,
  })), handle(async (req, res) => {
    const t = await load(req);
    const key = newGuestKey();
    const entrantId = await joinAsGuest(db, t, req.body, hashGuestKey(key));
    res.status(201).json({ key, entrant_id: entrantId, tournament_id: t.id });
  }));

  // A guest's own report. The key was only ever given to them.
  r.post('/:code/me', previewLimit, validate(z.object({ key: z.string().min(10).max(80) })), handle(async (req, res) => {
    const t = await load(req);
    const row = await db.q1('SELECT id FROM tournament_entrants WHERE tournament_id=? AND guest_key_hash=?', [t.id, hashGuestKey(req.body.key)]);
    if (!row) fail(404, 'no_guest', 'That link is not valid');
    res.json(await results(db, t, { entrantId: row.id }));
  }));

  return r;
}
