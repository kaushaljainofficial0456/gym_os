// ============================================================
// FRIEND COMMUNITIES — invitations.
//
// Two ways in, and nothing else. There is no public listing, no search
// that returns strangers, and no way to join a community you were not
// invited to.
//
//   DIRECT  An owner or admin invites one person they already share a
//           context with (their gym community, or another community).
//           That person accepts or declines. Nobody is added without
//           consent.
//
//   CODE    An owner or admin generates a short code -- the same secret
//           travels as a link and a QR -- for friends anywhere, including
//           people in other gyms or no gym. Codes expire, have a use cap,
//           and can be revoked; several can be live at once so handing a
//           new one to a late friend never kills the one sent earlier.
//
// CODE STORAGE follows the enrollment-token precedent (services/
// enterprise/enrollmentToken.js): the raw code exists only in the
// response that created it. What is stored is an HMAC keyed with the
// server secret -- a plain SHA-256 would not be enough for an 8-character
// code, which is short enough to brute-force offline from a leaked hash,
// whereas without the server key the hash is useless.
//
// Guessing online is bounded by the rate limits on the join routes:
// 31^8 is about 8.5e11 codes, so at ten guesses a minute the expected time
// to hit any one live code is on the order of a hundred thousand years.
// ============================================================
import crypto from 'node:crypto';
import { id, now } from '../../ids.js';
import { config } from '../../config.js';
import {
  fail, int, LIMITS, requireCan, activeMembership, joinAsMember,
  notifyClient, notifyMember, clientName, likeTerm,
} from './core.js';

// No 0/O or 1/I/L: a code gets read aloud, typed from a screenshot, and
// copied by hand, and every ambiguous pair is a failed join.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;
export const CODE_EXPIRY_DAYS = Object.freeze([1, 7, 30]);
export const CODE_MAX_USES = Object.freeze([1, 5, 10, 25, 50]);
const DIRECT_TTL_DAYS = 14;
const DAY_MS = 86_400_000;

function generateRawCode() {
  // randomInt is uniform over the alphabet; a byte % 31 would bias the
  // first characters of the alphabet.
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Accepts what people actually type: lowercase, spaces, the dash. */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export const formatCode = (normalized) => `${normalized.slice(0, 4)}-${normalized.slice(4)}`;

function hashCode(normalized) {
  // Domain-separated so this HMAC can never collide with any other use of
  // the same server secret.
  return crypto.createHmac('sha256', config.jwtSecret).update(`community-invite:${normalized}`).digest('hex');
}

/** Where a code stands right now. Expiry is evaluated against the clock,
 *  not only the stored status, so an unswept row can never admit anyone. */
function codeState(row, at = Date.now()) {
  if (!row) return 'invalid';
  if (row.status === 'revoked') return 'revoked';
  if (row.status !== 'pending') return 'invalid';
  if (Date.parse(row.expires_at) <= at) return 'expired';
  if (int(row.use_count) >= int(row.max_uses)) return 'used_up';
  return 'valid';
}

const STATE_MESSAGE = {
  invalid: 'That invite code is not valid. Check it and try again.',
  revoked: 'That invite code was turned off. Ask for a new one.',
  expired: 'That invite code has expired. Ask for a new one.',
  used_up: 'That invite code has been used the maximum number of times. Ask for a new one.',
};

const STATE_STATUS = { invalid: 404, revoked: 410, expired: 410, used_up: 409 };

// ---------------- codes ----------------

export async function generateCode(db, { community, membership, expiresInDays = 7, maxUses = 25 }) {
  requireCan(membership, 'invite', 'Only owners and admins can create invite codes');
  if (!CODE_EXPIRY_DAYS.includes(expiresInDays)) fail(422, 'bad_expiry', 'Choose 1, 7 or 30 days');
  if (!CODE_MAX_USES.includes(maxUses)) fail(422, 'bad_max_uses', 'Choose a supported number of uses');

  const live = await db.q1(
    `SELECT COUNT(*) AS n FROM community_invites
      WHERE community_id = ? AND kind = 'code' AND status = 'pending'
        AND expires_at > ? AND use_count < max_uses`,
    [community.id, now()]);
  if (int(live?.n) >= LIMITS.maxActiveCodes) {
    fail(409, 'code_limit', `A community can have up to ${LIMITS.maxActiveCodes} live codes. Turn one off first.`);
  }

  const expiresAt = new Date(Date.now() + expiresInDays * DAY_MS).toISOString();
  // A collision on the UNIQUE hash is astronomically unlikely; retried
  // rather than assumed impossible.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = generateRawCode();
    const inviteId = id('cinv');
    try {
      await db.run(
        `INSERT INTO community_invites
           (id, community_id, kind, created_by, code_hash, status, max_uses, use_count, expires_at, created_at)
         VALUES (?, ?, 'code', ?, ?, 'pending', ?, 0, ?, ?)`,
        [inviteId, community.id, membership.client_id, hashCode(raw), maxUses, expiresAt, now()]);
      return { id: inviteId, code: formatCode(raw), expiresAt, maxUses };
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
  return null;
}

/** Codes and open direct invitations, for the invite sheet. Never returns
 *  a code itself -- only when it was made, by whom, and how it is used. */
export async function listInvites(db, { community, membership }) {
  requireCan(membership, 'invite', 'Only owners and admins can see invitations');
  const [codes, direct] = await Promise.all([
    db.q(
      `SELECT i.id, i.status, i.max_uses, i.use_count, i.expires_at, i.created_at, i.created_by, u.name AS created_by_name
         FROM community_invites i
         LEFT JOIN clients c ON c.id = i.created_by
         LEFT JOIN users u ON u.id = c.user_id
        WHERE i.community_id = ? AND i.kind = 'code' AND i.status = 'pending'
        ORDER BY i.created_at DESC, i.id DESC`,
      [community.id]),
    db.q(
      `SELECT i.id, i.expires_at, i.created_at, i.invitee_client_id, u.name AS invitee_name
         FROM community_invites i
         JOIN clients c ON c.id = i.invitee_client_id
         JOIN users u ON u.id = c.user_id
        WHERE i.community_id = ? AND i.kind = 'direct' AND i.status = 'pending' AND i.expires_at > ?
        ORDER BY i.created_at DESC, i.id DESC`,
      [community.id, now()]),
  ]);
  const at = Date.now();
  return {
    codes: codes
      .map((r) => ({
        id: r.id,
        state: codeState(r, at),
        maxUses: int(r.max_uses),
        useCount: int(r.use_count),
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        createdBy: r.created_by_name || null,
        yours: r.created_by === membership.client_id,
      }))
      // Only codes that can still admit someone are worth showing; the rest
      // are history, and listing them invites "why doesn't this work".
      .filter((c) => c.state === 'valid'),
    direct: direct.map((r) => ({
      id: r.id,
      clientId: r.invitee_client_id,
      name: r.invitee_name || 'Member',
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    })),
    limits: {
      maxActiveCodes: LIMITS.maxActiveCodes,
      expiryDays: CODE_EXPIRY_DAYS,
      maxUses: CODE_MAX_USES,
    },
  };
}

export async function revokeInvite(db, { community, membership, inviteId }) {
  requireCan(membership, 'invite', 'Only owners and admins can turn off invitations');
  const res = await db.run(
    `UPDATE community_invites SET status = 'revoked', responded_at = ?
      WHERE id = ? AND community_id = ? AND status = 'pending'`,
    [now(), inviteId, community.id]);
  if (res.changes !== 1) fail(404, 'invite_not_found', 'Invitation not found');
  return { revoked: true };
}

/**
 * What a code leads to, for the invitation screen.
 *
 * Without a viewer (the public preview) this is deliberately thin: the
 * community's name, colour, mark and size -- enough for the invitation
 * card -- and never a member's name, the inviter, or a description. The
 * holder of a working code is the invited person; everyone else gets
 * "invalid" for the price of a rate-limited guess.
 */
export async function previewCode(db, rawCode, { clientId = null } = {}) {
  const normalized = normalizeCode(rawCode);
  if (!normalized) return { state: 'invalid' };
  const row = await db.q1(
    `SELECT i.*, c.name, c.theme, c.mark,
            (SELECT COUNT(*) FROM community_memberships m
              WHERE m.community_id = c.id AND m.status = 'active') AS member_count
       FROM community_invites i
       JOIN communities c ON c.id = i.community_id
      WHERE i.code_hash = ? AND i.kind = 'code'`,
    [hashCode(normalized)]);
  const state = codeState(row);
  if (state === 'invalid') return { state };

  const out = {
    state,
    code: formatCode(normalized),
    community: { name: row.name, theme: row.theme, mark: row.mark || null, memberCount: int(row.member_count) },
  };
  if (clientId) {
    const mine = await db.q1(
      'SELECT status FROM community_memberships WHERE community_id = ? AND client_id = ?',
      [row.community_id, clientId]);
    out.alreadyMember = mine?.status === 'active';
    out.removed = mine?.status === 'removed';
    // The id is only useful -- and only revealed -- to someone who can
    // already open the community.
    if (out.alreadyMember) out.communityId = row.community_id;
  }
  return out;
}

export async function redeemCode(db, { rawCode, client }) {
  const normalized = normalizeCode(rawCode);
  if (!normalized) fail(404, 'invalid', STATE_MESSAGE.invalid);
  const row = await db.q1(
    `SELECT * FROM community_invites WHERE code_hash = ? AND kind = 'code'`, [hashCode(normalized)]);
  const state = codeState(row);
  if (state !== 'valid') fail(STATE_STATUS[state], state, STATE_MESSAGE[state]);

  // Already in: say so and leave the code's use count alone -- opening an
  // invite link twice must not burn a friend's seat.
  const existing = await activeMembership(db, row.community_id, client.id);
  if (existing) return { communityId: row.community_id, already: true };

  const at = now();
  await db.tx(async (tx) => {
    // The conditional UPDATE is the race guard: two people redeeming the
    // last use at once can only both succeed if both UPDATEs match, and
    // the use_count < max_uses predicate lets exactly one of them.
    const took = await tx.run(
      `UPDATE community_invites SET use_count = use_count + 1
        WHERE id = ? AND status = 'pending' AND use_count < max_uses AND expires_at > ?`,
      [row.id, at]);
    if (took.changes !== 1) fail(409, 'used_up', STATE_MESSAGE.used_up);
    await joinAsMember(tx, { communityId: row.community_id, clientId: client.id, via: 'code' });
  });

  if (row.created_by && row.created_by !== client.id) {
    const [who, community] = await Promise.all([
      clientName(db, client.id),
      db.q1('SELECT name FROM communities WHERE id = ?', [row.community_id]),
    ]);
    await notifyMember(db, row.community_id, row.created_by, {
      type: 'community_joined',
      title: `${who} joined ${community?.name || 'your community'}`,
      body: 'They used your invite code.',
      data: { link: `/app/client/community/c/${row.community_id}`, communityId: row.community_id },
    });
  }
  return { communityId: row.community_id, already: false };
}

// ---------------- people you know ----------------

/**
 * The only people search in this feature, and it cannot find strangers.
 *
 * The pool is people the inviter can ALREADY see: opted-in members of
 * their own gym community (only if the inviter has opted in too -- the
 * same rule the gym's own member list applies) and active members of the
 * inviter's other friend communities. Anyone else is invited with a code.
 * That keeps "search SK OS users" from becoming a directory of every
 * account on the platform.
 */
async function candidatePool(db, { actorClientId, orgId, excludeCommunityId, term = null, targetClientId = null }) {
  const nameFilter = term ? "AND LOWER(u.name) LIKE ? ESCAPE '\\'" : '';
  const idFilter = targetClientId ? 'AND c.id = ?' : '';
  const extra = [];
  if (term) extra.push(likeTerm(term));
  if (targetClientId) extra.push(targetClientId);

  const actorGym = orgId
    ? await db.q1('SELECT enabled FROM community_members WHERE client_id = ? AND org_id = ?', [actorClientId, orgId])
    : null;

  const [gymRows, circleRows, formerRows] = await Promise.all([
    Number(actorGym?.enabled) === 1
      ? db.q(
        `SELECT c.id AS client_id, u.name, NULL AS via
           FROM community_members cm
           JOIN clients c ON c.id = cm.client_id
           JOIN users u ON u.id = c.user_id
          WHERE cm.org_id = ? AND cm.enabled = 1 AND c.org_id = ? AND c.id <> ? AND u.active = 1
            ${nameFilter} ${idFilter}
          ORDER BY u.name ASC
          LIMIT 25`,
        [orgId, orgId, actorClientId, ...extra])
      : Promise.resolve([]),
    db.q(
      `SELECT c.id AS client_id, u.name, co.name AS via
         FROM community_memberships mine
         JOIN community_memberships other
           ON other.community_id = mine.community_id AND other.status = 'active'
         JOIN communities co ON co.id = mine.community_id
         JOIN clients c ON c.id = other.client_id
         JOIN users u ON u.id = c.user_id
        WHERE mine.client_id = ? AND mine.status = 'active' AND mine.community_id <> ?
          AND c.id <> ? AND u.active = 1
          ${nameFilter} ${idFilter}
        ORDER BY u.name ASC
        LIMIT 50`,
      [actorClientId, excludeCommunityId, actorClientId, ...extra]),
    // People who were in THIS community before. Without them a removal is
    // irreversible for anyone from another gym: their only shared context
    // WAS this community, so the moment they leave it they vanish from the
    // search and no admin can ever invite them back. An admin can already
    // see this community's own membership history, so this reveals nothing
    // new -- it just makes "remove" undoable by the people who did it.
    db.q(
      `SELECT c.id AS client_id, u.name, 'Previously a member' AS via
         FROM community_memberships past
         JOIN clients c ON c.id = past.client_id
         JOIN users u ON u.id = c.user_id
        WHERE past.community_id = ? AND past.status IN ('left', 'removed') AND u.active = 1
          ${nameFilter} ${idFilter}
        ORDER BY u.name ASC
        LIMIT 25`,
      [excludeCommunityId, ...extra]),
  ]);

  const byId = new Map();
  for (const r of gymRows) byId.set(r.client_id, { clientId: r.client_id, name: r.name || 'Member', via: 'Your gym' });
  for (const r of [...circleRows, ...formerRows]) {
    if (!byId.has(r.client_id)) byId.set(r.client_id, { clientId: r.client_id, name: r.name || 'Member', via: r.via });
  }
  return [...byId.values()];
}

export async function inviteCandidates(db, { community, membership, orgId, q }) {
  requireCan(membership, 'invite', 'Only owners and admins can invite people');
  const term = String(q || '').trim();
  if ([...term].length < 2) return [];
  const pool = await candidatePool(db, {
    actorClientId: membership.client_id, orgId, excludeCommunityId: community.id, term: term.slice(0, 60),
  });
  if (!pool.length) return [];

  const ids = pool.map((p) => p.clientId);
  const ph = ids.map(() => '?').join(',');
  const [members, pending] = await Promise.all([
    db.q(
      `SELECT client_id FROM community_memberships
        WHERE community_id = ? AND status = 'active' AND client_id IN (${ph})`,
      [community.id, ...ids]),
    db.q(
      `SELECT invitee_client_id FROM community_invites
        WHERE community_id = ? AND kind = 'direct' AND status = 'pending' AND expires_at > ?
          AND invitee_client_id IN (${ph})`,
      [community.id, now(), ...ids]),
  ]);
  const memberSet = new Set(members.map((r) => r.client_id));
  const pendingSet = new Set(pending.map((r) => r.invitee_client_id));
  return pool
    .filter((p) => !memberSet.has(p.clientId))
    .slice(0, 10)
    .map((p) => ({ ...p, invited: pendingSet.has(p.clientId) }));
}

export async function createDirectInvite(db, { community, membership, orgId, inviteeClientId }) {
  requireCan(membership, 'invite', 'Only owners and admins can invite people');
  if (inviteeClientId === membership.client_id) fail(422, 'self', 'You are already in this community');

  // Same pool the search draws from. An id that did not come from that
  // search -- guessed, scraped, or copied from elsewhere -- is refused the
  // same way a nonexistent one is, so this route cannot be used to probe
  // which client ids exist.
  const [eligible] = await candidatePool(db, {
    actorClientId: membership.client_id, orgId, excludeCommunityId: community.id, targetClientId: inviteeClientId,
  });
  if (!eligible) fail(404, 'member_not_found', 'We could not find that person. Share an invite code instead.');

  if (await activeMembership(db, community.id, inviteeClientId)) {
    fail(409, 'already_member', `${eligible.name} is already in this community`);
  }
  const open = await db.q1(
    `SELECT COUNT(*) AS n FROM community_invites
      WHERE community_id = ? AND kind = 'direct' AND status = 'pending' AND expires_at > ?`,
    [community.id, now()]);
  if (int(open?.n) >= LIMITS.maxPendingDirect) {
    fail(409, 'invite_limit', 'Too many open invitations. Wait for some replies first.');
  }

  // A stale pending row past its expiry would hold the partial unique index
  // and block a fresh invitation forever. Sweep it before inserting.
  await db.run(
    `UPDATE community_invites SET status = 'expired'
      WHERE community_id = ? AND invitee_client_id = ? AND kind = 'direct' AND status = 'pending' AND expires_at <= ?`,
    [community.id, inviteeClientId, now()]);

  const inviteId = id('cinv');
  const expiresAt = new Date(Date.now() + DIRECT_TTL_DAYS * DAY_MS).toISOString();
  try {
    await db.run(
      `INSERT INTO community_invites
         (id, community_id, kind, created_by, invitee_client_id, status, expires_at, created_at)
       VALUES (?, ?, 'direct', ?, ?, 'pending', ?, ?)`,
      [inviteId, community.id, membership.client_id, inviteeClientId, expiresAt, now()]);
  } catch {
    // idx_cinv_direct_pending: an open invitation already exists. Reported
    // plainly rather than as a second notification to the same person.
    fail(409, 'already_invited', `${eligible.name} already has an invitation`);
  }

  const inviter = await clientName(db, membership.client_id);
  await notifyClient(db, inviteeClientId, {
    type: 'community_invite',
    title: `${inviter} invited you to ${community.name}`,
    body: 'Open Community to accept or decline.',
    data: { link: `/app/client/community?invite=${inviteId}`, communityId: community.id, inviteId },
  });
  return { id: inviteId, expiresAt, name: eligible.name };
}

/** Open invitations addressed to this client, newest first. */
export async function listMyInvites(db, { clientId }) {
  const rows = await db.q(
    `SELECT i.id, i.community_id, i.expires_at, i.created_at,
            c.name, c.theme, c.mark, c.description,
            u.name AS inviter_name,
            (SELECT COUNT(*) FROM community_memberships m
              WHERE m.community_id = c.id AND m.status = 'active') AS member_count
       FROM community_invites i
       JOIN communities c ON c.id = i.community_id
       LEFT JOIN clients ic ON ic.id = i.created_by
       LEFT JOIN users u ON u.id = ic.user_id
      WHERE i.invitee_client_id = ? AND i.kind = 'direct' AND i.status = 'pending' AND i.expires_at > ?
      ORDER BY i.created_at DESC, i.id DESC`,
    [clientId, now()]);
  return rows.map((r) => ({
    id: r.id,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    inviterName: r.inviter_name || 'A member',
    community: {
      id: r.community_id,
      name: r.name,
      theme: r.theme,
      mark: r.mark || null,
      description: r.description || null,
      memberCount: int(r.member_count),
    },
  }));
}

export async function respondToInvite(db, { inviteId, client, accept }) {
  const row = await db.q1(
    `SELECT i.*, c.name AS community_name FROM community_invites i
       JOIN communities c ON c.id = i.community_id
      WHERE i.id = ? AND i.kind = 'direct'`,
    [inviteId]);
  // Somebody else's invitation is "not found", never "forbidden": the
  // difference would confirm the invitation exists.
  if (!row || row.invitee_client_id !== client.id) fail(404, 'invite_not_found', 'Invitation not found');
  if (row.status !== 'pending') {
    fail(409, `already_${row.status}`, row.status === 'revoked'
      ? 'This invitation was withdrawn'
      : `You already ${row.status === 'accepted' ? 'accepted' : 'responded to'} this invitation`);
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    await db.run(`UPDATE community_invites SET status = 'expired' WHERE id = ? AND status = 'pending'`, [row.id]);
    fail(410, 'expired', 'This invitation has expired. Ask for a new one.');
  }

  const at = now();
  if (!accept) {
    await db.run(
      `UPDATE community_invites SET status = 'declined', responded_at = ? WHERE id = ? AND status = 'pending'`,
      [at, row.id]);
    // Declining is quiet on purpose. Telling the inviter "Sambhav declined"
    // turns a private no into a small public rejection.
    return { declined: true };
  }

  let already = false;
  await db.tx(async (tx) => {
    const took = await tx.run(
      `UPDATE community_invites SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'`,
      [at, row.id]);
    if (took.changes !== 1) fail(409, 'already_responded', 'You already responded to this invitation');
    ({ already } = await joinAsMember(tx, { communityId: row.community_id, clientId: client.id, via: 'direct' }));
  });

  if (!already && row.created_by && row.created_by !== client.id) {
    const who = await clientName(db, client.id);
    await notifyMember(db, row.community_id, row.created_by, {
      type: 'community_invite_accepted',
      title: `${who} joined ${row.community_name}`,
      body: 'They accepted your invitation.',
      data: { link: `/app/client/community/c/${row.community_id}`, communityId: row.community_id },
    });
  }
  return { communityId: row.community_id, already };
}
