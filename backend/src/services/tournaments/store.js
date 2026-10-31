// ============================================================
// TOURNAMENTS: creating, joining, hosting. Every function assumes the
// caller already holds a context from access.js, or is about to prove one.
//
// RLS NOTE: inside db.tx the session is scoped to the caller's gym, so a
// transaction here can only touch tournament_* tables, which are not
// scoped. Anything that reads `users` or writes `notifications` for
// someone in another gym runs outside the transaction.
// ============================================================
import { id, now } from '../../ids.js';
import { notify } from '../enterprise/notifications.js';
import { EVENT_CATALOG, METRICS, THEMES, LIMITS } from './catalog.js';
import {
  fail, newCode, phaseOf, canWithdrawNow, canSee, gymLabelOf, isTrue,
  requireNotFinished, TOURNAMENT_SELECT,
} from './access.js';

const int = (v) => Number(v) || 0;
const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const placeholders = (list) => list.map(() => '?').join(',');
const clean = (v, max = 200) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
};
const iso = (v) => {
  if (v == null || v === '') return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) fail(422, 'bad_date', 'One of the dates is not valid');
  return new Date(ms).toISOString();
};

async function audit(db, tournamentId, actorId, action, detail = null) {
  await db.run(
    'INSERT INTO tournament_audit (id, tournament_id, actor_id, action, detail, created_at) VALUES (?,?,?,?,?,?)',
    [id('tau'), tournamentId, actorId, action, detail, now()]).catch(() => {});
}

/** Tells someone, linking to the right app for their role. Best effort. */
async function tell(db, t, userId, { type, title, body = null, path = '' }) {
  const u = await db.q1('SELECT role, org_id FROM users WHERE id = ?', [userId]);
  if (!u) return;
  const base = u.role === 'CLIENT' ? '/app/client' : '/app/trainer';
  await notify(db, {
    orgId: u.org_id || t.host_org_id, userId, type, title, body,
    data: { link: `${base}/tournaments/${t.id}${path}`, tournamentId: t.id },
  });
}

function checkDates({ registration_opens_at: opens, registration_closes_at: closes, withdraw_closes_at: leave, starts_at: starts }) {
  const ms = (v) => (v ? Date.parse(v) : null);
  if (opens && closes && ms(opens) >= ms(closes)) fail(422, 'bad_dates', 'Registration has to open before it closes');
  if (closes && starts && ms(closes) > ms(starts)) fail(422, 'bad_dates', 'Registration has to close before the tournament starts');
  if (leave && starts && ms(leave) > ms(starts)) fail(422, 'bad_dates', 'The leaving deadline has to be before the start');
}

function normalizeEvent(input, position) {
  const preset = EVENT_CATALOG.find((e) => e.kind === input.kind);
  const metric = input.metric || preset?.metric;
  if (!METRICS[metric]) fail(422, 'bad_metric', 'Choose how this competition is scored');
  const name = clean(input.name || preset?.name, LIMITS.nameLength);
  if (!name) fail(422, 'bad_event', 'Every competition needs a name');
  return {
    name,
    kind: preset ? preset.kind : 'custom',
    metric,
    attempts: clampInt(input.attempts ?? preset?.attempts ?? 1, 1, LIMITS.attempts, 1),
    time_cap_sec: input.time_cap_sec ? clampInt(input.time_cap_sec, 5, 7_200, null) : null,
    win_positions: clampInt(input.win_positions ?? 3, 1, LIMITS.positions, 3),
    capacity: input.capacity ? clampInt(input.capacity, 1, 5_000, null) : null,
    is_team: input.is_team ?? preset?.team ? 1 : 0,
    position,
  };
}

async function insertEvent(db, tournamentId, ev) {
  const eventId = id('tev');
  await db.run(
    `INSERT INTO tournament_events (id, tournament_id, code, name, kind, metric, attempts, time_cap_sec, win_positions, capacity, is_team, position, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [eventId, tournamentId, newCode(), ev.name, ev.kind, ev.metric, ev.attempts, ev.time_cap_sec,
      ev.win_positions, ev.capacity, ev.is_team, ev.position, now()]);
  return eventId;
}

// ─── creating ────────────────────────────────────────────────────────

export async function createTournament(db, viewer, body) {
  const name = clean(body.name, LIMITS.nameLength);
  if (!name) fail(422, 'bad_name', 'Give the tournament a name');
  const events = (body.events || []).map(normalizeEvent);
  if (!events.length) fail(422, 'no_events', 'Add at least one competition');
  if (events.length > LIMITS.events) fail(422, 'too_many_events', `A tournament can have up to ${LIMITS.events} competitions`);
  const audience = body.audience === 'staff' ? 'staff' : 'everyone';
  if (audience === 'staff' && !viewer.isStaff) fail(403, 'staff_only', 'Only trainers and owners can host a staff-only tournament');
  // There is no gym to be limited to if the host does not belong to one,
  // and the shared Independent org is not a gym.
  const reach = viewer.independent ? 'everyone' : (body.reach === 'everyone' ? 'everyone' : 'gym');
  const dates = {
    registration_opens_at: iso(body.registration_opens_at),
    registration_closes_at: iso(body.registration_closes_at),
    withdraw_closes_at: iso(body.withdraw_closes_at),
    starts_at: iso(body.starts_at),
  };
  checkDates(dates);
  const tournamentId = id('trn');
  const stamp = now();
  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO tournaments (id, host_org_id, created_by, name, tagline, venue, prize, rules, theme, visibility, reach, audience,
         code, capacity, overall_positions, registration_opens_at, registration_closes_at, withdraw_closes_at, starts_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tournamentId, viewer.independent ? null : viewer.org_id, viewer.id, name, clean(body.tagline, 140), clean(body.venue, 120),
        clean(body.prize, 200), clean(body.rules, 1000), THEMES.includes(body.theme) ? body.theme : 'ember',
        body.visibility === 'private' ? 'private' : 'public', reach, audience, newCode(),
        body.capacity ? clampInt(body.capacity, 1, 5_000, null) : null, clampInt(body.overall_positions ?? 3, 1, LIMITS.positions, 3),
        dates.registration_opens_at, dates.registration_closes_at, dates.withdraw_closes_at, dates.starts_at, stamp, stamp]);
    await tx.run(
      `INSERT INTO tournament_hosts (tournament_id, user_id, role, status, invited_by, created_at, responded_at)
       VALUES (?,?,'prime','accepted',?,?,?)`, [tournamentId, viewer.id, viewer.id, stamp, stamp]);
    for (const ev of events) await insertEvent(tx, tournamentId, ev);
  });
  await audit(db, tournamentId, viewer.id, 'created', name);
  return tournamentId;
}

export async function updateTournament(db, ctx, body) {
  const { t } = ctx;
  requireNotFinished(t);
  const next = {
    name: body.name !== undefined ? clean(body.name, LIMITS.nameLength) : t.name,
    tagline: body.tagline !== undefined ? clean(body.tagline, 140) : t.tagline,
    venue: body.venue !== undefined ? clean(body.venue, 120) : t.venue,
    prize: body.prize !== undefined ? clean(body.prize, 200) : t.prize,
    rules: body.rules !== undefined ? clean(body.rules, 1000) : t.rules,
    theme: THEMES.includes(body.theme) ? body.theme : t.theme,
    visibility: ['public', 'private'].includes(body.visibility) ? body.visibility : t.visibility,
    overall_positions: body.overall_positions !== undefined ? clampInt(body.overall_positions, 1, LIMITS.positions, t.overall_positions) : t.overall_positions,
    capacity: body.capacity !== undefined ? (body.capacity ? clampInt(body.capacity, 1, 5_000, null) : null) : t.capacity,
    registration_opens_at: body.registration_opens_at !== undefined ? iso(body.registration_opens_at) : t.registration_opens_at,
    registration_closes_at: body.registration_closes_at !== undefined ? iso(body.registration_closes_at) : t.registration_closes_at,
    withdraw_closes_at: body.withdraw_closes_at !== undefined ? iso(body.withdraw_closes_at) : t.withdraw_closes_at,
    starts_at: body.starts_at !== undefined ? iso(body.starts_at) : t.starts_at,
  };
  if (!next.name) fail(422, 'bad_name', 'Give the tournament a name');
  checkDates(next);
  await db.run(
    `UPDATE tournaments SET name=?, tagline=?, venue=?, prize=?, rules=?, theme=?, visibility=?, overall_positions=?, capacity=?,
       registration_opens_at=?, registration_closes_at=?, withdraw_closes_at=?, starts_at=?, updated_at=? WHERE id=?`,
    [next.name, next.tagline, next.venue, next.prize, next.rules, next.theme, next.visibility, next.overall_positions, next.capacity,
      next.registration_opens_at, next.registration_closes_at, next.withdraw_closes_at, next.starts_at, now(), t.id]);
  await audit(db, t.id, ctx.viewer.id, 'edited');
}

export async function cancelTournament(db, ctx) {
  requireNotFinished(ctx.t);
  await db.run(`UPDATE tournaments SET status='cancelled', updated_at=? WHERE id=?`, [now(), ctx.t.id]);
  await audit(db, ctx.t.id, ctx.viewer.id, 'cancelled');
  const people = await db.q(`SELECT user_id FROM tournament_entrants WHERE tournament_id=? AND status='active' AND user_id IS NOT NULL`, [ctx.t.id]);
  for (const p of people) {
    if (p.user_id !== ctx.viewer.id) await tell(db, ctx.t, p.user_id, { type: 'tournament_cancelled', title: `${ctx.t.name} was cancelled` });
  }
}

export async function addEvent(db, ctx, body) {
  requireNotFinished(ctx.t);
  const count = int((await db.q1('SELECT COUNT(*) AS n FROM tournament_events WHERE tournament_id=?', [ctx.t.id]))?.n);
  if (count >= LIMITS.events) fail(422, 'too_many_events', `A tournament can have up to ${LIMITS.events} competitions`);
  return insertEvent(db, ctx.t.id, normalizeEvent(body, count));
}

export async function updateEvent(db, ctx, event, body) {
  requireNotFinished(ctx.t);
  await db.run(
    'UPDATE tournament_events SET name=?, attempts=?, time_cap_sec=?, win_positions=?, capacity=? WHERE id=?',
    [clean(body.name, LIMITS.nameLength) || event.name,
      body.attempts !== undefined ? clampInt(body.attempts, 1, LIMITS.attempts, event.attempts) : event.attempts,
      body.time_cap_sec !== undefined ? (body.time_cap_sec ? clampInt(body.time_cap_sec, 5, 7_200, null) : null) : event.time_cap_sec,
      body.win_positions !== undefined ? clampInt(body.win_positions, 1, LIMITS.positions, event.win_positions) : event.win_positions,
      body.capacity !== undefined ? (body.capacity ? clampInt(body.capacity, 1, 5_000, null) : null) : event.capacity,
      event.id]);
}

export async function removeEvent(db, ctx, event) {
  requireNotFinished(ctx.t);
  if (event.status !== 'upcoming') fail(409, 'event_started', 'A competition that has started cannot be removed');
  await db.run('DELETE FROM tournament_events WHERE id=?', [event.id]);
  await audit(db, ctx.t.id, ctx.viewer.id, 'event_removed', event.name);
}

export async function rotateCodes(db, ctx) {
  await db.run('UPDATE tournaments SET code=?, updated_at=? WHERE id=?', [newCode(), now(), ctx.t.id]);
  const events = await db.q('SELECT id FROM tournament_events WHERE tournament_id=?', [ctx.t.id]);
  for (const e of events) await db.run('UPDATE tournament_events SET code=? WHERE id=?', [newCode(), e.id]);
  await audit(db, ctx.t.id, ctx.viewer.id, 'codes_rotated');
}

// ─── hosts ───────────────────────────────────────────────────────────

export async function inviteCohost(db, ctx, targetId) {
  requireNotFinished(ctx.t);
  if (targetId === ctx.viewer.id) fail(422, 'self', 'You are already hosting this');
  const target = await db.q1(
    `SELECT u.id, u.role, u.org_id, o.is_demo FROM users u LEFT JOIN organizations o ON o.id = u.org_id
      WHERE u.id=? AND u.active=1 AND u.role <> 'SUPER_ADMIN'`, [targetId]);
  if (!target) fail(404, 'no_person', 'That person could not be found');
  if (isTrue(target.is_demo) !== ctx.viewer.isDemo) fail(404, 'no_person', 'That person could not be found');
  if (ctx.t.audience === 'staff' && target.role === 'CLIENT') fail(422, 'staff_only', 'This tournament is for trainers and owners only');
  const existing = await db.q1('SELECT * FROM tournament_hosts WHERE tournament_id=? AND user_id=?', [ctx.t.id, targetId]);
  if (existing?.status === 'accepted') fail(409, 'already_host', 'They are already a host');
  if (existing?.status === 'pending') return;
  await db.run(
    `INSERT INTO tournament_hosts (tournament_id, user_id, role, status, invited_by, created_at) VALUES (?,?,'cohost','pending',?,?)
     ON CONFLICT (tournament_id, user_id) DO UPDATE SET status='pending', invited_by=excluded.invited_by, created_at=excluded.created_at, responded_at=NULL`,
    [ctx.t.id, targetId, ctx.viewer.id, now()]);
  await tell(db, ctx.t, targetId, {
    type: 'tournament_cohost_invite',
    title: `${ctx.viewer.name} wants you to co-host`,
    body: ctx.t.name,
  });
}

export async function respondToInvite(db, ctx, accept) {
  const row = ctx.hostRow;
  if (!row || row.status !== 'pending') fail(404, 'no_invite', 'There is no invitation to answer');
  await db.run('UPDATE tournament_hosts SET status=?, responded_at=? WHERE tournament_id=? AND user_id=?',
    [accept ? 'accepted' : 'declined', now(), ctx.t.id, ctx.viewer.id]);
  await audit(db, ctx.t.id, ctx.viewer.id, accept ? 'cohost_accepted' : 'cohost_declined');
  if (row.invited_by) {
    await tell(db, ctx.t, row.invited_by, {
      type: 'tournament_cohost_reply',
      title: `${ctx.viewer.name} ${accept ? 'is now co-hosting' : 'declined to co-host'}`,
      body: ctx.t.name,
    });
  }
}

export async function removeCohost(db, ctx, targetId) {
  const leavingThemselves = targetId === ctx.viewer.id;
  if (!ctx.isPrime && !leavingThemselves) fail(403, 'prime_only', 'Only the main host can do that');
  const row = await db.q1('SELECT role FROM tournament_hosts WHERE tournament_id=? AND user_id=?', [ctx.t.id, targetId]);
  if (!row) fail(404, 'no_host', 'They are not a host');
  if (row.role === 'prime') fail(409, 'prime', 'The main host cannot be removed');
  await db.run('DELETE FROM tournament_hosts WHERE tournament_id=? AND user_id=?', [ctx.t.id, targetId]);
  await audit(db, ctx.t.id, ctx.viewer.id, 'cohost_removed', targetId);
}

// ─── people ──────────────────────────────────────────────────────────

const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;

/** Gives someone a username the first time it matters. */
export async function ensureUsername(db, viewer) {
  if (viewer.username) return viewer.username;
  const base = String(viewer.name || 'athlete').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14) || 'athlete';
  for (let i = 0; i < 6; i += 1) {
    const candidate = `${base}${1000 + Math.floor(Math.random() * 9000)}`;
    const taken = await db.q1('SELECT id FROM users WHERE username = ?', [candidate]);
    if (!taken) {
      await db.run('UPDATE users SET username = ? WHERE id = ? AND username IS NULL', [candidate, viewer.id]).catch(() => {});
      return candidate;
    }
  }
  return null;
}

export async function setIdentity(db, viewer, { username, findable }) {
  if (username !== undefined) {
    const u = String(username).trim().toLowerCase().replace(/^@/, '');
    if (!USERNAME_RE.test(u)) fail(422, 'bad_username', 'Use 3 to 24 letters, numbers, dots or underscores');
    const taken = await db.q1('SELECT id FROM users WHERE username = ? AND id <> ?', [u, viewer.id]);
    if (taken) fail(409, 'username_taken', 'That username is taken');
    await db.run('UPDATE users SET username = ? WHERE id = ?', [u, viewer.id]);
  }
  if (findable !== undefined) await db.run('UPDATE users SET findable = ? WHERE id = ?', [findable ? 1 : 0, viewer.id]);
}

const likeTerm = (raw) => `%${String(raw).toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

const RELATION_LABEL = {
  same_gym: 'Same gym',
  community: 'Common community',
  other_gym: 'Other gym',
  independent: 'Independent',
};

/**
 * Anyone on Barbell, by name or username, for inviting a co-host or adding
 * a competitor. Returns no email or phone, honours the opt-out (except
 * inside your own gym, where the host already knows the roster), and a demo
 * account only ever finds its own gym.
 */
export async function searchPeople(db, viewer, q) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const like = likeTerm(term.replace(/^@/, ''));
  const rows = await db.q(
    `SELECT u.id, u.name, u.username, u.role, u.avatar, u.org_id, u.findable, o.type AS org_type, o.is_demo
       FROM users u LEFT JOIN organizations o ON o.id = u.org_id
      WHERE u.active = 1 AND u.role <> 'SUPER_ADMIN' AND u.id <> ?
        AND (LOWER(u.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(u.username, '')) LIKE ? ESCAPE '\\')
      ORDER BY u.name LIMIT 60`, [viewer.id, like, like]);
  const sameGym = (r) => !viewer.independent && r.org_id === viewer.org_id;
  const shown = rows.filter((r) => {
    if (viewer.isDemo || isTrue(r.is_demo)) return viewer.isDemo && r.org_id === viewer.org_id;
    return sameGym(r) || isTrue(r.findable);
  }).slice(0, LIMITS.peoplePerSearch);
  const shared = await sharedCommunities(db, viewer.id, shown.map((r) => r.id));
  return shown
    .map((r) => {
      const relation = sameGym(r) ? 'same_gym'
        : shared.has(r.id) ? 'community'
          : (r.org_type === 'independent' || !r.org_id) ? 'independent' : 'other_gym';
      return {
        id: r.id,
        name: r.name,
        username: r.username,
        role: r.role,
        // A data URL can be a megabyte; twelve of those is no search box.
        avatar: r.avatar && !String(r.avatar).startsWith('data:') ? r.avatar : null,
        relation,
        relation_label: RELATION_LABEL[relation],
      };
    })
    .sort((a, b) => Object.keys(RELATION_LABEL).indexOf(a.relation) - Object.keys(RELATION_LABEL).indexOf(b.relation));
}

async function sharedCommunities(db, viewerId, ids) {
  if (!ids.length) return new Set();
  const rows = await db.q(
    `SELECT DISTINCT other.user_id FROM community_memberships a
       JOIN clients me ON me.id = a.client_id AND me.user_id = ?
       JOIN community_memberships b ON b.community_id = a.community_id AND b.status = 'active'
       JOIN clients other ON other.id = b.client_id
      WHERE a.status = 'active' AND other.user_id IN (${placeholders(ids)})`, [viewerId, ...ids]).catch(() => []);
  return new Set(rows.map((r) => r.user_id));
}

// ─── joining ─────────────────────────────────────────────────────────

async function activeCount(db, tournamentId) {
  return int((await db.q1(`SELECT COUNT(*) AS n FROM tournament_entrants WHERE tournament_id=? AND status='active'`, [tournamentId]))?.n);
}

async function eventCount(db, eventId) {
  return int((await db.q1(
    `SELECT COUNT(*) AS n FROM tournament_entries en JOIN tournament_entrants p ON p.id = en.entrant_id
      WHERE en.event_id=? AND p.status='active'`, [eventId]))?.n);
}

async function eventsById(db, tournamentId, ids) {
  const events = await db.q('SELECT * FROM tournament_events WHERE tournament_id=? ORDER BY position', [tournamentId]);
  const wanted = (ids || []).map((x) => events.find((e) => e.id === x)).filter(Boolean);
  if (!wanted.length) fail(422, 'no_events', 'Pick at least one competition');
  return wanted;
}

async function teamIdFor(db, event, teamName) {
  const name = clean(teamName, 40);
  if (!event.is_team || !name) return null;
  const teams = await db.q('SELECT id, name FROM tournament_teams WHERE event_id=?', [event.id]);
  const hit = teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const teamId = id('ttm');
  await db.run('INSERT INTO tournament_teams (id, event_id, name, created_at) VALUES (?,?,?,?)', [teamId, event.id, name, now()]);
  return teamId;
}

async function enrol(db, entrantId, events, teams = {}) {
  for (const ev of events) {
    const teamId = await teamIdFor(db, ev, teams[ev.id]);
    await db.run(
      `INSERT INTO tournament_entries (id, event_id, entrant_id, team_id, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT (event_id, entrant_id) DO UPDATE SET team_id = COALESCE(excluded.team_id, tournament_entries.team_id)`,
      [id('ten'), ev.id, entrantId, teamId, now()]);
  }
}

async function assertRoom(db, t, events, { addingPerson = true } = {}) {
  if (addingPerson && t.capacity && (await activeCount(db, t.id)) >= t.capacity) fail(409, 'full', 'This tournament is full');
  for (const ev of events) {
    if (ev.capacity && (await eventCount(db, ev.id)) >= ev.capacity) fail(409, 'event_full', `${ev.name} is full`);
  }
}

/**
 * A signed-in person joining. `viaCode` means they scanned the host's QR,
 * which is the host's own invitation, so it skips the private-tournament
 * request. A host joins directly too: they may compete in their own event.
 */
export async function joinTournament(db, ctx, { event_ids: eventIds, teams, body_weight: bodyWeight, gender }, { viaCode = false } = {}) {
  const { t, viewer, entrant } = ctx;
  requireNotFinished(t);
  const phase = phaseOf(t);
  if (phase === 'live') fail(409, 'started', 'This tournament has already started');
  if (phase === 'soon') fail(409, 'not_open', 'Registration has not opened yet');
  if (phase === 'closed') fail(409, 'closed', 'Registration has closed');
  if (t.audience === 'staff' && !viewer.isStaff) fail(403, 'staff_only', 'This tournament is for trainers and owners only');
  const events = await eventsById(db, t.id, eventIds);
  const direct = t.visibility === 'public' || viaCode || ctx.isHost;
  const alreadyIn = entrant?.status === 'active';
  if (direct) {
    // Only places they do not already hold count against the capacity.
    const held = entrant ? await db.q('SELECT event_id FROM tournament_entries WHERE entrant_id=?', [entrant.id]) : [];
    await assertRoom(db, t, events.filter((e) => !held.some((h) => h.event_id === e.id)), { addingPerson: !alreadyIn });
  }
  const status = alreadyIn || direct ? 'active' : 'pending';
  const stamp = now();
  let entrantId = entrant?.id;
  if (entrant) {
    await db.run('UPDATE tournament_entrants SET status=?, body_weight=COALESCE(?, body_weight), gender=COALESCE(?, gender), updated_at=? WHERE id=?',
      [status, bodyWeight ?? null, gender ?? null, stamp, entrant.id]);
  } else {
    entrantId = id('tep');
    await db.run(
      `INSERT INTO tournament_entrants (id, tournament_id, user_id, name, gym_label, body_weight, gender, status, source, added_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [entrantId, t.id, viewer.id, viewer.name, gymLabelOf(viewer), bodyWeight ?? null, gender ?? null, status,
        viaCode ? 'qr' : direct ? 'direct' : 'request', viewer.id, stamp, stamp]);
  }
  await enrol(db, entrantId, events, teams);
  if (status === 'pending') {
    const hosts = await db.q(`SELECT user_id FROM tournament_hosts WHERE tournament_id=? AND status='accepted'`, [t.id]);
    for (const h of hosts) {
      await tell(db, t, h.user_id, { type: 'tournament_request', title: `${viewer.name} wants to join`, body: t.name });
    }
  }
  return { status };
}

/** Someone without an account, from the QR. */
export async function joinAsGuest(db, t, { name, gym_label: gym, body_weight: bodyWeight, event_ids: eventIds, teams }, keyHash) {
  requireNotFinished(t);
  const phase = phaseOf(t);
  if (phase !== 'open') fail(409, 'closed', phase === 'soon' ? 'Registration has not opened yet' : 'Registration has closed');
  if (t.audience === 'staff') fail(403, 'staff_only', 'This tournament is for trainers and owners only');
  const clean_name = clean(name, LIMITS.nameLength);
  if (!clean_name) fail(422, 'bad_name', 'Add your name');
  const events = await eventsById(db, t.id, eventIds);
  await assertRoom(db, t, events);
  const entrantId = id('tep');
  const stamp = now();
  await db.run(
    `INSERT INTO tournament_entrants (id, tournament_id, name, gym_label, body_weight, status, source, guest_key_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,'active','guest',?,?,?)`,
    [entrantId, t.id, clean_name, clean(gym, 80) || 'Guest', bodyWeight ?? null, keyHash, stamp, stamp]);
  await enrol(db, entrantId, events, teams);
  return entrantId;
}

/** A guest who signed up later takes their results with them. */
export async function claimGuest(db, ctx, keyHash) {
  const row = await db.q1(
    `SELECT id FROM tournament_entrants WHERE tournament_id=? AND guest_key_hash=? AND user_id IS NULL`, [ctx.t.id, keyHash]);
  if (!row) fail(404, 'nothing_to_claim', 'There is nothing to claim here');
  if (ctx.entrant) fail(409, 'already_in', 'You are already in this tournament');
  await db.run(
    'UPDATE tournament_entrants SET user_id=?, name=?, gym_label=?, guest_key_hash=NULL, updated_at=? WHERE id=?',
    [ctx.viewer.id, ctx.viewer.name, gymLabelOf(ctx.viewer), now(), row.id]);
}

export async function leaveTournament(db, ctx, eventIds) {
  const { t, entrant } = ctx;
  if (!entrant || entrant.status === 'withdrawn') fail(404, 'not_entered', 'You are not in this tournament');
  // A request nobody has answered can always be taken back.
  if (entrant.status === 'active' && !canWithdrawNow(t)) fail(409, 'locked_in', 'The deadline to leave has passed');
  const entries = await db.q(
    `SELECT en.id, en.event_id, ev.status FROM tournament_entries en JOIN tournament_events ev ON ev.id = en.event_id WHERE en.entrant_id=?`,
    [entrant.id]);
  const dropping = eventIds?.length ? entries.filter((e) => eventIds.includes(e.event_id)) : entries;
  for (const e of dropping) await db.run('DELETE FROM tournament_entries WHERE id=?', [e.id]);
  if (dropping.length === entries.length) {
    await db.run(`UPDATE tournament_entrants SET status='withdrawn', updated_at=? WHERE id=?`, [now(), entrant.id]);
  }
}

/** The host adding people: typed names, or Barbell accounts. Deadlines do not bind the host. */
export async function addPeople(db, ctx, people) {
  const { t, viewer } = ctx;
  requireNotFinished(t);
  const added = [];
  for (const person of people) {
    const events = await eventsById(db, t.id, person.event_ids);
    let user = null;
    if (person.user_id) {
      user = await db.q1(
        `SELECT u.id, u.name, u.role, u.org_id, o.name AS org_name, o.type AS org_type FROM users u
           LEFT JOIN organizations o ON o.id = u.org_id WHERE u.id=? AND u.active=1`, [person.user_id]);
      if (!user) fail(404, 'no_person', 'That person could not be found');
      if (t.audience === 'staff' && user.role === 'CLIENT') fail(422, 'staff_only', 'This tournament is for trainers and owners only');
    }
    const name = clean(user?.name || person.name, LIMITS.nameLength);
    if (!name) fail(422, 'bad_name', 'Add a name');
    const stamp = now();
    const existing = user ? await db.q1('SELECT id, status FROM tournament_entrants WHERE tournament_id=? AND user_id=?', [t.id, user.id]) : null;
    await assertRoom(db, t, events, { addingPerson: existing?.status !== 'active' });
    let entrantId = existing?.id;
    if (existing) {
      await db.run(`UPDATE tournament_entrants SET status='active', updated_at=? WHERE id=?`, [stamp, existing.id]);
    } else {
      entrantId = id('tep');
      const gym = user ? (user.org_type === 'independent' || !user.org_id ? 'Independent' : user.org_name) : clean(person.gym_label, 80);
      await db.run(
        `INSERT INTO tournament_entrants (id, tournament_id, user_id, name, gym_label, body_weight, gender, status, source, added_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'active','manual',?,?,?)`,
        [entrantId, t.id, user?.id ?? null, name, gym, person.body_weight ?? null, person.gender ?? null, viewer.id, stamp, stamp]);
    }
    await enrol(db, entrantId, events, person.teams);
    added.push(entrantId);
    if (user && user.id !== viewer.id) {
      await tell(db, t, user.id, { type: 'tournament_added', title: `${viewer.name} added you to a tournament`, body: t.name });
    }
  }
  return added;
}

export async function decideRequest(db, ctx, entrantId, accept) {
  const { t } = ctx;
  requireNotFinished(t);
  const row = await db.q1('SELECT * FROM tournament_entrants WHERE id=? AND tournament_id=?', [entrantId, t.id]);
  if (!row || row.status !== 'pending') fail(404, 'no_request', 'That request is no longer waiting');
  if (accept) {
    const entries = await db.q('SELECT event_id FROM tournament_entries WHERE entrant_id=?', [entrantId]);
    const events = await db.q('SELECT * FROM tournament_events WHERE tournament_id=?', [t.id]);
    await assertRoom(db, t, events.filter((e) => entries.some((x) => x.event_id === e.id)));
  }
  await db.run('UPDATE tournament_entrants SET status=?, updated_at=? WHERE id=?', [accept ? 'active' : 'declined', now(), entrantId]);
  await audit(db, t.id, ctx.viewer.id, accept ? 'request_accepted' : 'request_declined', row.name);
  if (row.user_id) {
    await tell(db, t, row.user_id, {
      type: 'tournament_request_reply',
      title: accept ? `You're in: ${t.name}` : `Your request for ${t.name} was declined`,
    });
  }
}

export async function updateEntrant(db, ctx, entrantId, body) {
  const { t } = ctx;
  requireNotFinished(t);
  const row = await db.q1('SELECT * FROM tournament_entrants WHERE id=? AND tournament_id=?', [entrantId, t.id]);
  if (!row) fail(404, 'no_entrant', 'That person is not in this tournament');
  await db.run('UPDATE tournament_entrants SET name=?, gym_label=?, body_weight=?, updated_at=? WHERE id=?',
    [row.user_id ? row.name : (clean(body.name, LIMITS.nameLength) || row.name),
      body.gym_label !== undefined ? clean(body.gym_label, 80) : row.gym_label,
      body.body_weight !== undefined ? body.body_weight : row.body_weight, now(), entrantId]);
  if (body.event_ids) {
    const events = await eventsById(db, t.id, body.event_ids);
    await db.run(`DELETE FROM tournament_entries WHERE entrant_id=? AND event_id NOT IN (${placeholders(events)})`, [entrantId, ...events.map((e) => e.id)]);
    await enrol(db, entrantId, events, body.teams);
  } else if (body.teams) {
    const events = await eventsById(db, t.id, Object.keys(body.teams));
    await enrol(db, entrantId, events, body.teams);
  }
}

export async function removeEntrant(db, ctx, entrantId) {
  const { t } = ctx;
  requireNotFinished(t);
  const row = await db.q1('SELECT * FROM tournament_entrants WHERE id=? AND tournament_id=?', [entrantId, t.id]);
  if (!row) fail(404, 'no_entrant', 'That person is not in this tournament');
  await db.tx(async (tx) => {
    await tx.run('DELETE FROM tournament_results WHERE subject_id=?', [entrantId]);
    await tx.run('DELETE FROM tournament_entrants WHERE id=?', [entrantId]);
  });
  await audit(db, t.id, ctx.viewer.id, 'entrant_removed', row.name);
}

// ─── reading ─────────────────────────────────────────────────────────

/** Tournament cards for a list, with this person's relationship to each. */
export async function cardsFor(db, rows, viewer) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = placeholders(ids);
  const [counts, events, hosts, mine] = await Promise.all([
    db.q(`SELECT tournament_id, COUNT(*) AS n FROM tournament_entrants WHERE tournament_id IN (${marks}) AND status='active' GROUP BY tournament_id`, ids),
    db.q(`SELECT tournament_id, id, name, kind, metric, status FROM tournament_events WHERE tournament_id IN (${marks}) ORDER BY position`, ids),
    viewer ? db.q(`SELECT tournament_id, role, status FROM tournament_hosts WHERE tournament_id IN (${marks}) AND user_id=?`, [...ids, viewer.id]) : [],
    viewer ? db.q(`SELECT tournament_id, status FROM tournament_entrants WHERE tournament_id IN (${marks}) AND user_id=?`, [...ids, viewer.id]) : [],
  ]);
  return rows.map((t) => {
    const host = hosts.find((h) => h.tournament_id === t.id);
    return {
      id: t.id,
      name: t.name,
      tagline: t.tagline,
      venue: t.venue,
      theme: t.theme,
      status: t.status,
      phase: phaseOf(t),
      visibility: t.visibility,
      reach: t.reach,
      audience: t.audience,
      starts_at: t.starts_at,
      registration_closes_at: t.registration_closes_at,
      capacity: t.capacity,
      host_name: t.host_name,
      gym_name: t.host_org_name,
      entrants: int(counts.find((c) => c.tournament_id === t.id)?.n),
      events: events.filter((e) => e.tournament_id === t.id).map(({ tournament_id: _, ...e }) => e),
      my_host_role: host?.status === 'accepted' ? host.role : null,
      my_host_invite: host?.status === 'pending',
      my_entry: mine.find((m) => m.tournament_id === t.id)?.status || null,
    };
  });
}

export async function hub(db, viewer) {
  const username = await ensureUsername(db, viewer);
  const rows = await db.q(
    `${TOURNAMENT_SELECT}
      WHERE t.status IN ('upcoming','live','completed')
        AND (t.reach = 'everyone' OR t.host_org_id = ?)
      ORDER BY CASE t.status WHEN 'live' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END, COALESCE(t.starts_at, t.created_at) DESC
      LIMIT 120`, [viewer.org_id || '']);
  const mineRows = await db.q(
    `${TOURNAMENT_SELECT}
      WHERE t.status <> 'cancelled' AND t.id IN (
        SELECT tournament_id FROM tournament_hosts WHERE user_id=? AND status IN ('accepted','pending')
        UNION SELECT tournament_id FROM tournament_entrants WHERE user_id=? AND status IN ('active','pending'))
      ORDER BY COALESCE(t.starts_at, t.created_at) DESC LIMIT 100`, [viewer.id, viewer.id]);
  const mineIds = new Set(mineRows.map((r) => r.id));
  const others = rows.filter((t) => !mineIds.has(t.id) && canSee(t, viewer));
  const [mineCards, otherCards] = await Promise.all([cardsFor(db, mineRows, viewer), cardsFor(db, others, viewer)]);
  return {
    me: { id: viewer.id, name: viewer.name, username, findable: isTrue(viewer.findable), isStaff: viewer.isStaff, independent: viewer.independent },
    invites: mineCards.filter((c) => c.my_host_invite),
    mine: mineCards.filter((c) => !c.my_host_invite),
    discover: otherCards.filter((c) => c.status !== 'completed'),
    results: otherCards.filter((c) => c.status === 'completed').slice(0, 20),
  };
}

/** A glance for the Home and Community banners: cheap enough to load with them. */
export async function pulse(db, viewer) {
  const rows = await db.q(
    `${TOURNAMENT_SELECT}
      WHERE t.status IN ('upcoming','live') AND (t.reach = 'everyone' OR t.host_org_id = ?)
      ORDER BY CASE t.status WHEN 'live' THEN 0 ELSE 1 END, COALESCE(t.starts_at, t.created_at)
      LIMIT 40`, [viewer.org_id || '']);
  const seen = rows.filter((t) => canSee(t, viewer));
  const waiting = await db.q1(`SELECT COUNT(*) AS n FROM tournament_hosts WHERE user_id=? AND status='pending'`, [viewer.id]);
  const next = seen[0];
  return {
    live: seen.filter((t) => t.status === 'live').length,
    upcoming: seen.filter((t) => t.status === 'upcoming').length,
    invites: int(waiting?.n),
    next: next ? { id: next.id, name: next.name, theme: next.theme, status: next.status, phase: phaseOf(next), starts_at: next.starts_at } : null,
  };
}

/** Everything the tournament page needs. Hosts also get the people who are waiting. */
export async function detail(db, ctx) {
  const { t, viewer, entrant, isHost, isPrime, hostRow } = ctx;
  const [card] = await cardsFor(db, [t], viewer);
  const events = await db.q('SELECT * FROM tournament_events WHERE tournament_id=? ORDER BY position', [t.id]);
  const enrolled = await db.q(
    `SELECT en.event_id, en.entrant_id, en.team_id, tm.name AS team_name FROM tournament_entries en
       JOIN tournament_events ev ON ev.id = en.event_id
       LEFT JOIN tournament_teams tm ON tm.id = en.team_id
      WHERE ev.tournament_id=?`, [t.id]);
  const teams = await db.q(
    `SELECT tm.id, tm.event_id, tm.name FROM tournament_teams tm JOIN tournament_events ev ON ev.id = tm.event_id WHERE ev.tournament_id=?`, [t.id]);
  const entrants = await db.q(
    `SELECT id, user_id, name, gym_label, body_weight, gender, status, source FROM tournament_entrants
      WHERE tournament_id=? AND status IN ('active','pending') ORDER BY name`, [t.id]);
  const hosts = await db.q(
    `SELECT h.user_id, h.role, h.status, u.name, u.username FROM tournament_hosts h JOIN users u ON u.id = h.user_id
      WHERE h.tournament_id=? AND h.status <> 'declined' ORDER BY h.role DESC, u.name`, [t.id]);
  const active = entrants.filter((e) => e.status === 'active');
  const entriesOf = (entrantId) => enrolled.filter((x) => x.entrant_id === entrantId);
  const publicPerson = (e) => ({
    id: e.id, name: e.name, gym_label: e.gym_label, is_me: e.user_id === viewer.id,
    event_ids: entriesOf(e.id).map((x) => x.event_id),
    teams: Object.fromEntries(entriesOf(e.id).filter((x) => x.team_name).map((x) => [x.event_id, x.team_name])),
  });
  const myEntryRows = entrant ? entriesOf(entrant.id) : [];
  return {
    ...card,
    prize: t.prize,
    rules: t.rules,
    overall_positions: t.overall_positions,
    registration_opens_at: t.registration_opens_at,
    withdraw_closes_at: t.withdraw_closes_at,
    started_at: t.started_at,
    completed_at: t.completed_at,
    // The join code is the host's to hand out; a public tournament's page
    // can be shared by anyone in it, which is how these spread.
    code: isHost || t.visibility === 'public' ? t.code : null,
    events: events.map((e) => ({
      id: e.id, name: e.name, kind: e.kind, metric: e.metric, attempts: e.attempts, time_cap_sec: e.time_cap_sec,
      win_positions: e.win_positions, capacity: e.capacity, is_team: isTrue(e.is_team), status: e.status,
      started_at: e.started_at, finished_at: e.finished_at,
      code: isHost ? e.code : (t.visibility === 'public' ? e.code : null),
      entrants: enrolled.filter((x) => x.event_id === e.id && active.some((p) => p.id === x.entrant_id)).length,
      teams: teams.filter((tm) => tm.event_id === e.id).map((tm) => tm.name),
    })),
    hosts: hosts.map((h) => ({ user_id: h.user_id, name: h.name, username: h.username, role: h.role, status: h.status })),
    people: active.map(publicPerson),
    requests: isHost ? entrants.filter((e) => e.status === 'pending').map(publicPerson) : [],
    you: {
      is_host: isHost,
      is_prime: isPrime,
      invited_to_host: hostRow?.status === 'pending',
      entrant_id: entrant?.id || null,
      entry_status: entrant?.status || null,
      event_ids: myEntryRows.map((x) => x.event_id),
      teams: Object.fromEntries(myEntryRows.filter((x) => x.team_name).map((x) => [x.event_id, x.team_name])),
      can_join: phaseOf(t) === 'open' && (!entrant || entrant.status === 'withdrawn' || entrant.status === 'active'),
      can_leave: !!entrant && (entrant.status === 'pending' || (entrant.status === 'active' && canWithdrawNow(t))),
      needs_approval: t.visibility === 'private' && !isHost,
      body_weight: entrant?.body_weight ?? null,
    },
  };
}
