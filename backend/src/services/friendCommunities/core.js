// ============================================================
// FRIEND COMMUNITIES — the community itself: creation, membership,
// roles, and the rules that keep a private group private.
//
// ACCESS IS AN ACTIVE MEMBERSHIP ROW. Nothing here trusts a role or a
// community id sent by the browser. Every function that acts on a
// community takes the { community, membership } pair produced by
// loadCommunityFor(), which reads the caller's OWN membership from the
// database. A client who is not an active member gets the same 404 as a
// community that does not exist, so ids cannot be probed for existence.
//
// CROSS-GYM BY CONSTRUCTION. No query in this directory filters by org.
// Membership grants nothing outside the community: the gym community
// keeps its own opt-in and its own routes, and belonging to a friend
// community with someone never exposes that person's gym community.
//
// READS OF OTHER MEMBERS NEVER RUN INSIDE db.tx(). A transaction engages
// app.org_id on PostgreSQL, and the client-scoped RLS policies would then
// silently drop every other gym's rows (see rls.sql). Transactions here
// write community_* rows and read only the caller's own data.
// ============================================================
import { id, now } from '../../ids.js';
import { friendCountedPredicate } from '../communityScope.js';
import { periodRange, getCommunitySettings, getMembership as getGymMembership } from '../community.js';
import { communityPulse } from '../communityIntel.js';
import { isIndependentOrg } from '../orgKind.js';
import { notify } from '../enterprise/notifications.js';

/** A refusal the route layer turns into { error, reason } with `status`. */
export class CommunityError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fail(status, code, message) {
  throw new CommunityError(status, code, message);
}

/** Postgres returns COUNT/SUM as bigint strings; see communityIntel.js. */
export const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/**
 * Abuse limits, sized for groups of friends rather than for gyms. Each one
 * blocks a specific failure: an account spinning up hundreds of groups to
 * spam invitations, a "community" that is really a broadcast list, or an
 * invite code left live long after the group stopped needing it.
 */
export const LIMITS = Object.freeze({
  maxOwned: 10,
  maxJoined: 30,
  maxMembers: 100,
  maxActiveCodes: 5,
  maxPendingDirect: 50,
  nameMin: 2,
  nameMax: 40,
  descriptionMax: 160,
});

/** Palette keys. Resolved to theme tokens in the browser, so every
 *  identity is legible on both the light and the dark ground. */
export const THEMES = Object.freeze(['ember', 'violet', 'sage', 'ocean', 'champagne', 'steel']);

/** The optional mark. A short curated list rather than free text: a
 *  community's identity is shown to every member and in notifications,
 *  and an allow-list is the only input that can never be abused. */
export const MARKS = Object.freeze(['🔥', '⚡', '💪', '🏋️', '🏃', '🚴', '🥇', '🎯', '⛰️', '🌅']);

/** Event kinds the feed understands. The table deliberately has no CHECK
 *  on type (see schema.sql), so this list is the allow-list. */
export const EVENT_TYPES = Object.freeze(['created', 'joined', 'workout', 'pr']);

// ---------------- permissions ----------------

/**
 * v1 roles, kept deliberately small. An owner runs the community; an admin
 * helps grow and moderate it; a member trains in it. There is no custom
 * role builder, because a group of eight friends does not need one.
 */
const CAN = Object.freeze({
  edit: ['owner'],
  delete: ['owner'],
  transfer: ['owner'],
  setRole: ['owner'],
  invite: ['owner', 'admin'],
  removeMember: ['owner', 'admin'],
  moderate: ['owner', 'admin'],
  manageChallenges: ['owner', 'admin'],
});

export const ROLE_RANK = Object.freeze({ owner: 3, admin: 2, member: 1 });

export function can(role, action) {
  return (CAN[action] || []).includes(role);
}

/** What the caller may do, for the UI to decide which controls to render.
 *  Advisory only -- every action re-checks on the server. */
export function permissionsFor(role) {
  return Object.fromEntries(Object.keys(CAN).map((action) => [action, can(role, action)]));
}

export function requireCan(membership, action, message) {
  if (!membership || !can(membership.role, action)) {
    fail(403, 'forbidden', message || 'You do not have permission to do that');
  }
}

// ---------------- input hygiene ----------------

// Control characters and the invisible formatting set (zero-width joiners,
// bidi overrides). Names are shown to other people; a name that renders
// differently from how it reads -- or reverses the text after it -- is a
// spoofing tool, not a style choice.
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;

export function cleanName(raw) {
  if (typeof raw !== 'string') fail(422, 'bad_name', 'Give your community a name');
  // Whitespace runs collapse BEFORE the hidden-character check, so a tab or
  // newline typed by mistake becomes a space rather than a rejection.
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (HIDDEN.test(name)) fail(422, 'bad_name', 'Names cannot contain hidden or control characters');
  // Code points, not UTF-16 units, so an emoji counts once.
  const length = [...name].length;
  if (length < LIMITS.nameMin) fail(422, 'bad_name', `Name must be at least ${LIMITS.nameMin} characters`);
  if (length > LIMITS.nameMax) fail(422, 'bad_name', `Name must be ${LIMITS.nameMax} characters or fewer`);
  if (!/[\p{L}\p{N}]/u.test(name)) fail(422, 'bad_name', 'Name needs at least one letter or number');
  return name;
}

export function cleanDescription(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') fail(422, 'bad_description', 'Description must be text');
  const text = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (HIDDEN.test(text)) fail(422, 'bad_description', 'Description cannot contain hidden or control characters');
  if ([...text].length > LIMITS.descriptionMax) {
    fail(422, 'bad_description', `Description must be ${LIMITS.descriptionMax} characters or fewer`);
  }
  return text;
}

export function cleanTheme(raw) {
  if (raw == null) return 'ember';
  if (!THEMES.includes(raw)) fail(422, 'bad_theme', 'Pick one of the available colours');
  return raw;
}

export function cleanMark(raw) {
  if (raw == null || raw === '') return null;
  if (!MARKS.includes(raw)) fail(422, 'bad_mark', 'Pick one of the available marks');
  return raw;
}

/** Escape LIKE wildcards in user input, so searching for "50%" matches
 *  the text rather than every name. Pair with ESCAPE '\'. */
export function likeTerm(raw) {
  return `%${String(raw).toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Anything else members type that other members read -- challenge names,
 * comments. The same hygiene as a community name: whitespace runs collapse,
 * hidden or control characters are refused, length is counted in code
 * points. Empty input returns null when `optional` (or `min` is 0).
 */
export function cleanText(raw, { field = 'Text', min = 1, max = 500, optional = false } = {}) {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) {
    if (optional || min === 0) return null;
    fail(422, 'bad_text', `${field} cannot be empty`);
  }
  if (typeof raw !== 'string') fail(422, 'bad_text', `${field} must be text`);
  const text = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (HIDDEN.test(text)) fail(422, 'bad_text', `${field} cannot contain hidden or control characters`);
  const length = [...text].length;
  if (length < min) fail(422, 'bad_text', `${field} must be at least ${min} characters`);
  if (length > max) fail(422, 'bad_text', `${field} must be ${max} characters or fewer`);
  return text;
}

// ---------------- loading ----------------

export async function activeMembership(db, communityId, clientId) {
  return db.q1(
    `SELECT * FROM community_memberships
      WHERE community_id = ? AND client_id = ? AND status = 'active'`,
    [communityId, clientId]);
}

/**
 * The only way a route reaches a community. Resolves the caller's active
 * membership first and refuses with a uniform 404 otherwise.
 */
export async function loadCommunityFor(db, communityId, clientId) {
  if (typeof communityId !== 'string' || !communityId || communityId.length > 64) {
    fail(404, 'not_found', 'Community not found');
  }
  let membership = await activeMembership(db, communityId, clientId);
  if (!membership) fail(404, 'not_found', 'Community not found');

  const community = await db.q1(
    `SELECT c.*,
            (SELECT COUNT(*) FROM community_memberships a
              WHERE a.community_id = c.id AND a.status = 'active') AS member_count,
            (SELECT COUNT(*) FROM community_memberships o
              WHERE o.community_id = c.id AND o.status = 'active' AND o.role = 'owner') AS owner_count
       FROM communities c WHERE c.id = ?`,
    [communityId]);
  if (!community) fail(404, 'not_found', 'Community not found');

  if (int(community.owner_count) === 0) {
    await ensureOwner(db, communityId);
    membership = await activeMembership(db, communityId, clientId);
  }
  return { community: { ...community, member_count: int(community.member_count) }, membership };
}

/**
 * Succession. Ownership lives on a membership row, and that row cascades
 * away if the owner's client record is deleted -- by a gym owner acting in
 * a completely different tenant. Rather than leave the group unmanageable
 * (or delete it out from under everyone), the longest-standing admin, else
 * the longest-standing member, becomes owner. Deterministic, so two
 * concurrent requests promote the same person.
 */
async function ensureOwner(db, communityId) {
  const heir = await db.q1(
    `SELECT id FROM community_memberships
      WHERE community_id = ? AND status = 'active'
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at ASC, id ASC
      LIMIT 1`,
    [communityId]);
  if (!heir) return;
  await db.run(
    `UPDATE community_memberships SET role = 'owner', updated_at = ?
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM community_memberships o
         WHERE o.community_id = ? AND o.status = 'active' AND o.role = 'owner')`,
    [now(), heir.id, communityId]);
}

// ---------------- shapes ----------------

export function membershipDTO(m) {
  return {
    clientId: m.client_id,
    role: m.role,
    shareStats: !!Number(m.share_stats),
    showGym: !!Number(m.show_gym),
    muted: !!Number(m.muted),
    joinedAt: m.joined_at,
    permissions: permissionsFor(m.role),
  };
}

export function communityDTO(c, membership = null) {
  return {
    id: c.id,
    type: c.type || 'friend',
    name: c.name,
    description: c.description || null,
    theme: c.theme || 'ember',
    mark: c.mark || null,
    privacy: c.privacy || 'private',
    memberCount: int(c.member_count),
    createdAt: c.created_at,
    you: membership ? membershipDTO(membership) : null,
  };
}

/** A member's gym, only when they chose to show it AND they actually have
 *  one -- the shared independent pseudo-org is not a gym to show. */
export function gymLabel(row) {
  return Number(row.show_gym) === 1 && row.org_type === 'gym' ? (row.org_name || null) : null;
}

// ---------------- events (low level) ----------------

/**
 * Idempotent on (community_id, dedupe_key): a repeated share returns the
 * event that already exists instead of creating a second one.
 */
export async function insertEvent(db, {
  communityId, clientId, type, workoutId = null, dedupeKey, payload = {}, createdAt = now(),
}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`unknown community event type: ${type}`);
  const eventId = id('cev');
  const res = await db.run(
    `INSERT INTO community_events (id, community_id, client_id, type, workout_id, dedupe_key, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (community_id, dedupe_key) DO NOTHING`,
    [eventId, communityId, clientId, type, workoutId, dedupeKey, JSON.stringify(payload), createdAt]);
  if (res.changes === 1) return { id: eventId, created: true };
  const existing = await db.q1(
    'SELECT id FROM community_events WHERE community_id = ? AND dedupe_key = ?', [communityId, dedupeKey]);
  return { id: existing?.id || null, created: false };
}

// ---------------- notifications ----------------

async function recipient(db, clientId) {
  return db.q1(
    `SELECT c.org_id, c.user_id FROM clients c JOIN users u ON u.id = c.user_id
      WHERE c.id = ? AND u.active = 1`,
    [clientId]);
}

/** In-app notification to any client (e.g. someone being invited). Best
 *  effort, like every notify() call: a notification failing to write must
 *  never fail the action that caused it. Never call inside db.tx() -- the
 *  row carries the RECIPIENT's org, which RLS would refuse there. */
export async function notifyClient(db, clientId, { type, title, body = null, data = null }) {
  try {
    const to = await recipient(db, clientId);
    if (!to) return;
    await notify(db, { orgId: to.org_id, userId: to.user_id, type, title, body, data });
  } catch { /* best effort */ }
}

/** Notification to a MEMBER, honouring their per-community mute. */
export async function notifyMember(db, communityId, clientId, message) {
  const m = await activeMembership(db, communityId, clientId);
  if (!m || Number(m.muted) === 1) return;
  await notifyClient(db, clientId, message);
}

export async function clientName(db, clientId) {
  const r = await db.q1(
    'SELECT u.name FROM clients c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [clientId]);
  return r?.name || 'A member';
}

// ---------------- create / list ----------------

export async function createCommunity(db, { client, name, description, theme, mark }) {
  const cleanNameValue = cleanName(name);
  const cleanDescriptionValue = cleanDescription(description);
  const cleanThemeValue = cleanTheme(theme);
  const cleanMarkValue = cleanMark(mark);

  const counts = await db.q1(
    `SELECT COALESCE(SUM(CASE WHEN role = 'owner' THEN 1 ELSE 0 END), 0) AS owned,
            COUNT(*) AS joined
       FROM community_memberships WHERE client_id = ? AND status = 'active'`,
    [client.id]);
  if (int(counts?.owned) >= LIMITS.maxOwned) {
    fail(409, 'owned_limit', `You can own up to ${LIMITS.maxOwned} communities`);
  }
  if (int(counts?.joined) >= LIMITS.maxJoined) {
    fail(409, 'joined_limit', `You can be in up to ${LIMITS.maxJoined} communities`);
  }
  // Different people may well both call their group "Morning Lifters"; one
  // person owning two of them is almost always a double-tapped Create.
  const dupe = await db.q1(
    `SELECT c.id FROM community_memberships m JOIN communities c ON c.id = m.community_id
      WHERE m.client_id = ? AND m.status = 'active' AND m.role = 'owner' AND LOWER(c.name) = LOWER(?)`,
    [client.id, cleanNameValue]);
  if (dupe) fail(409, 'duplicate_name', `You already have a community called ${cleanNameValue}`);

  const communityId = id('com');
  const ts = now();
  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO communities (id, type, name, description, theme, mark, privacy, created_by, created_at, updated_at)
       VALUES (?, 'friend', ?, ?, ?, ?, 'private', ?, ?, ?)`,
      [communityId, cleanNameValue, cleanDescriptionValue, cleanThemeValue, cleanMarkValue, client.id, ts, ts]);
    await tx.run(
      `INSERT INTO community_memberships
         (id, community_id, client_id, role, status, share_stats, show_gym, muted, joined_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', 1, 0, 0, ?, ?)`,
      [id('cmm'), communityId, client.id, ts, ts]);
    await insertEvent(tx, {
      communityId, clientId: client.id, type: 'created', dedupeKey: 'created',
      payload: { name: cleanNameValue }, createdAt: ts,
    });
  });
  return { id: communityId };
}

/**
 * The caller's communities for the Community home, each with the handful
 * of real figures its card shows. Batched: one query per figure for ALL
 * the caller's communities, never one per card.
 */
export async function listForClient(db, { clientId, tz }) {
  const rows = await db.q(
    `SELECT c.id, c.type, c.name, c.description, c.theme, c.mark, c.privacy, c.created_at,
            m.role, m.share_stats, m.show_gym, m.muted, m.joined_at, m.client_id
       FROM community_memberships m JOIN communities c ON c.id = m.community_id
      WHERE m.client_id = ? AND m.status = 'active'
      ORDER BY m.joined_at ASC, c.id ASC`,
    [clientId]);
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const week = periodRange('week', tz);
  const [counts, weekly, preview] = await Promise.all([
    db.q(
      `SELECT community_id, COUNT(*) AS n FROM community_memberships
        WHERE community_id IN (${ph}) AND status = 'active' GROUP BY community_id`,
      ids),
    db.q(
      `SELECT m.community_id, COUNT(*) AS n
         FROM community_memberships m
         JOIN workouts w ON w.client_id = m.client_id
        WHERE m.community_id IN (${ph}) AND ${friendCountedPredicate('m')}
          AND w.status = 'completed' AND w.scheduled_date >= ? AND w.scheduled_date <= ?
        GROUP BY m.community_id`,
      [...ids, week.start, week.end]),
    // First few members by join order, for the card's avatar stack. The
    // viewer is a member of every one of these, so the names are ones
    // they can already see inside the community.
    db.q(
      `SELECT community_id, client_id, name FROM (
         SELECT m.community_id, m.client_id, u.name,
                ROW_NUMBER() OVER (PARTITION BY m.community_id ORDER BY m.joined_at ASC, m.id ASC) AS rn
           FROM community_memberships m
           JOIN clients c ON c.id = m.client_id
           JOIN users u ON u.id = c.user_id
          WHERE m.community_id IN (${ph}) AND m.status = 'active'
       ) ranked
       WHERE rn <= 4
       ORDER BY community_id, rn`,
      ids),
  ]);

  const countBy = new Map(counts.map((r) => [r.community_id, int(r.n)]));
  const weekBy = new Map(weekly.map((r) => [r.community_id, int(r.n)]));
  const previewBy = new Map();
  for (const p of preview) {
    if (!previewBy.has(p.community_id)) previewBy.set(p.community_id, []);
    previewBy.get(p.community_id).push({ clientId: p.client_id, name: p.name || 'Member' });
  }

  return rows.map((r) => ({
    ...communityDTO({ ...r, member_count: countBy.get(r.id) || 0 }, r),
    workoutsThisWeek: weekBy.get(r.id) || 0,
    memberPreview: previewBy.get(r.id) || [],
  }));
}

/**
 * The gym community's card on the Community home. Mirrors routes/
 * community.js's own availability rules exactly (independent orgs have
 * no gym community; the platform flag and the gym's toggle both apply)
 * so the card never offers something the gym page would then refuse.
 */
export async function gymStatus(db, { client, orgId }) {
  if (!orgId || await isIndependentOrg(db, orgId)) return { available: false };
  const settings = await getCommunitySettings(db, orgId);
  if (!settings.community_enabled) return { available: false };
  const [org, membership] = await Promise.all([
    db.q1('SELECT name FROM organizations WHERE id = ?', [orgId]),
    getGymMembership(db, client.id),
  ]);
  return { available: true, type: 'gym', joined: !!Number(membership?.enabled), name: org?.name || 'Your gym' };
}

/** gymStatus plus the card's real weekly figures, once the member has
 *  joined -- a gym community they have not joined shows no numbers. */
export async function gymCard(db, { client, orgId, tz }) {
  const status = await gymStatus(db, { client, orgId });
  if (!status.available || !status.joined) return status;
  const pulse = await communityPulse(db, orgId, tz);
  return {
    ...status,
    memberCount: pulse.members,
    workoutsThisWeek: pulse.workoutsThisWeek,
    prsThisWeek: pulse.prsThisWeek,
  };
}

/**
 * One in-app notification per active, unmuted member (optionally skipping
 * the person who caused it). Recipients come from a single query rather
 * than a lookup per member. Best effort, and never inside db.tx().
 */
export async function notifyMembers(db, communityId, { excludeClientId = null } = {}, message) {
  try {
    const rows = await db.q(
      `SELECT c.org_id, c.user_id
         FROM community_memberships m
         JOIN clients c ON c.id = m.client_id
         JOIN users u ON u.id = c.user_id
        WHERE m.community_id = ? AND m.status = 'active' AND m.muted = 0 AND u.active = 1
          AND m.client_id <> ?`,
      [communityId, excludeClientId || '']);
    for (const r of rows) {
      await notify(db, { orgId: r.org_id, userId: r.user_id, ...message });
    }
  } catch { /* best effort */ }
}

// ---------------- manage ----------------

export async function updateCommunity(db, { community, membership, patch }) {
  requireCan(membership, 'edit', 'Only the owner can edit the community');
  const sets = [];
  const params = [];
  if (patch.name !== undefined) {
    const nextName = cleanName(patch.name);
    if (nextName.toLowerCase() !== String(community.name).toLowerCase()) {
      const dupe = await db.q1(
        `SELECT c.id FROM community_memberships m JOIN communities c ON c.id = m.community_id
          WHERE m.client_id = ? AND m.status = 'active' AND m.role = 'owner'
            AND LOWER(c.name) = LOWER(?) AND c.id <> ?`,
        [membership.client_id, nextName, community.id]);
      if (dupe) fail(409, 'duplicate_name', `You already have a community called ${nextName}`);
    }
    sets.push('name = ?'); params.push(nextName);
  }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(cleanDescription(patch.description)); }
  if (patch.theme !== undefined) { sets.push('theme = ?'); params.push(cleanTheme(patch.theme)); }
  if (patch.mark !== undefined) { sets.push('mark = ?'); params.push(cleanMark(patch.mark)); }
  if (!sets.length) fail(422, 'nothing_to_change', 'Nothing to change');
  sets.push('updated_at = ?'); params.push(now());
  params.push(community.id);
  await db.run(`UPDATE communities SET ${sets.join(', ')} WHERE id = ?`, params);
}

/**
 * Deletes the community and everything that exists only because of it --
 * memberships, invitations, shared events, reactions, comments, challenge
 * definitions -- through ON DELETE CASCADE. Workouts, personal records,
 * profiles and health data are separate rows that nothing here references
 * for deletion, so they cannot be touched by this.
 *
 * The typed-name confirmation is enforced HERE, not only in the dialog:
 * a stray DELETE request should not be able to end a group.
 */
export async function deleteCommunity(db, { community, membership, confirmName }) {
  requireCan(membership, 'delete', 'Only the owner can delete the community');
  const typed = String(confirmName ?? '').trim().toLowerCase();
  if (typed !== String(community.name).trim().toLowerCase()) {
    fail(422, 'confirm_mismatch', 'Type the community name exactly to confirm');
  }
  await db.run('DELETE FROM communities WHERE id = ?', [community.id]);
  return { deleted: true };
}

/**
 * What leaving takes with it, by policy: the member's own shared events in
 * THIS community (and so everyone's reactions and comments on them), plus
 * their reactions and comments on other people's events, plus any
 * invitation they created that is still open. Their workouts and records
 * are untouched -- only what they had published INTO the group goes, so
 * nothing they shared stays visible to people they no longer train with.
 */
async function purgeMemberContent(tx, communityId, clientId) {
  await tx.run(
    `DELETE FROM community_event_reactions
      WHERE client_id = ? AND event_id IN (SELECT id FROM community_events WHERE community_id = ?)`,
    [clientId, communityId]);
  await tx.run(
    `DELETE FROM community_event_comments
      WHERE client_id = ? AND event_id IN (SELECT id FROM community_events WHERE community_id = ?)`,
    [clientId, communityId]);
  await tx.run('DELETE FROM community_events WHERE community_id = ? AND client_id = ?', [communityId, clientId]);
  // A departing admin's live codes must stop working with them: a code is a
  // key to the group, and whoever held the right to hand keys out is gone.
  await tx.run(
    `UPDATE community_invites SET status = 'revoked', responded_at = ?
      WHERE community_id = ? AND created_by = ? AND status = 'pending'`,
    [now(), communityId, clientId]);
}

export async function leaveCommunity(db, { community, membership }) {
  if (membership.role === 'owner') {
    const others = await db.q1(
      `SELECT COUNT(*) AS n FROM community_memberships
        WHERE community_id = ? AND status = 'active' AND client_id <> ?`,
      [community.id, membership.client_id]);
    // With other members, walking away would leave them in a group nobody
    // can manage; the owner hands it over first. Alone, "leave" and
    // "delete" are the same act, so it is treated as delete.
    if (int(others?.n) > 0) {
      fail(409, 'transfer_required', 'Make another member the owner before you leave, or delete the community');
    }
    await db.run('DELETE FROM communities WHERE id = ?', [community.id]);
    return { left: true, deleted: true };
  }
  const ts = now();
  await db.tx(async (tx) => {
    await tx.run(
      `UPDATE community_memberships SET status = 'left', role = 'member', left_at = ?, updated_at = ?
        WHERE id = ?`,
      [ts, ts, membership.id]);
    await purgeMemberContent(tx, community.id, membership.client_id);
  });
  return { left: true, deleted: false };
}

export async function removeMember(db, { community, membership, targetClientId }) {
  requireCan(membership, 'removeMember', 'Only owners and admins can remove members');
  if (targetClientId === membership.client_id) {
    fail(422, 'self', 'Use Leave to remove yourself');
  }
  const target = await activeMembership(db, community.id, targetClientId);
  if (!target) fail(404, 'member_not_found', 'Member not found');
  // Strictly outranking the target: an admin cannot remove another admin
  // or the owner, which is what stops two admins removing each other.
  if (ROLE_RANK[membership.role] <= ROLE_RANK[target.role]) {
    fail(403, 'forbidden', 'You can only remove members below your own role');
  }
  const ts = now();
  await db.tx(async (tx) => {
    await tx.run(
      `UPDATE community_memberships SET status = 'removed', role = 'member', left_at = ?, updated_at = ?
        WHERE id = ?`,
      [ts, ts, target.id]);
    await purgeMemberContent(tx, community.id, targetClientId);
  });
  return { removed: true };
}

export async function setMemberRole(db, { community, membership, targetClientId, role }) {
  requireCan(membership, 'setRole', 'Only the owner can change roles');
  if (!['admin', 'member'].includes(role)) fail(422, 'bad_role', 'Role must be admin or member');
  if (targetClientId === membership.client_id) fail(422, 'self', 'Transfer ownership to change your own role');
  const target = await activeMembership(db, community.id, targetClientId);
  if (!target) fail(404, 'member_not_found', 'Member not found');
  await db.run(
    'UPDATE community_memberships SET role = ?, updated_at = ? WHERE id = ?',
    [role, now(), target.id]);
  return { role };
}

export async function transferOwnership(db, { community, membership, targetClientId }) {
  requireCan(membership, 'transfer', 'Only the owner can transfer ownership');
  if (targetClientId === membership.client_id) fail(422, 'self', 'You already own this community');
  const target = await activeMembership(db, community.id, targetClientId);
  if (!target) fail(404, 'member_not_found', 'Member not found');
  const ts = now();
  // Both rows in one transaction: there must never be a moment with two
  // owners, or with none.
  await db.tx(async (tx) => {
    await tx.run(`UPDATE community_memberships SET role = 'owner', updated_at = ? WHERE id = ?`, [ts, target.id]);
    await tx.run(`UPDATE community_memberships SET role = 'admin', updated_at = ? WHERE id = ?`, [ts, membership.id]);
  });
  return { ownerClientId: targetClientId };
}

export async function updateMySettings(db, { membership, patch }) {
  const sets = [];
  const params = [];
  for (const [key, col] of [['shareStats', 'share_stats'], ['showGym', 'show_gym'], ['muted', 'muted']]) {
    if (patch[key] === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(patch[key] ? 1 : 0);
  }
  if (!sets.length) fail(422, 'nothing_to_change', 'Nothing to change');
  sets.push('updated_at = ?'); params.push(now());
  params.push(membership.id);
  await db.run(`UPDATE community_memberships SET ${sets.join(', ')} WHERE id = ?`, params);
  return membershipDTO(await db.q1('SELECT * FROM community_memberships WHERE id = ?', [membership.id]));
}

/**
 * Makes a client an active member. Runs inside the caller's transaction
 * and reads only community_* rows, so it is safe under db.tx() (see the
 * header). `via` decides whether a previous removal is honoured: a code
 * cannot undo a removal; a direct invite from an owner or admin -- a
 * deliberate decision by the people who removed them -- can.
 */
export async function joinAsMember(tx, { communityId, clientId, via }) {
  const existing = await tx.q1(
    'SELECT * FROM community_memberships WHERE community_id = ? AND client_id = ?', [communityId, clientId]);
  if (existing?.status === 'active') return { membershipId: existing.id, already: true };
  if (existing?.status === 'removed' && via !== 'direct') {
    fail(403, 'removed', 'You were removed from this community. Ask an admin to invite you again.');
  }

  const counts = await tx.q1(
    `SELECT (SELECT COUNT(*) FROM community_memberships WHERE community_id = ? AND status = 'active') AS members,
            (SELECT COUNT(*) FROM community_memberships WHERE client_id = ? AND status = 'active') AS joined`,
    [communityId, clientId]);
  if (int(counts?.members) >= LIMITS.maxMembers) fail(409, 'full', 'This community is full');
  if (int(counts?.joined) >= LIMITS.maxJoined) {
    fail(409, 'joined_limit', `You can be in up to ${LIMITS.maxJoined} communities`);
  }

  const ts = now();
  let membershipId;
  if (existing) {
    // A returning member keeps the sharing choices they made last time.
    await tx.run(
      `UPDATE community_memberships SET status = 'active', role = 'member', joined_at = ?, left_at = NULL, updated_at = ?
        WHERE id = ?`,
      [ts, ts, existing.id]);
    membershipId = existing.id;
  } else {
    membershipId = id('cmm');
    await tx.run(
      `INSERT INTO community_memberships
         (id, community_id, client_id, role, status, share_stats, show_gym, muted, joined_at, updated_at)
       VALUES (?, ?, ?, 'member', 'active', 1, 0, 0, ?, ?)`,
      [membershipId, communityId, clientId, ts, ts]);
  }
  await insertEvent(tx, {
    communityId, clientId, type: 'joined', dedupeKey: `joined:${membershipId}:${ts}`, payload: {}, createdAt: ts,
  });
  return { membershipId, already: false };
}
