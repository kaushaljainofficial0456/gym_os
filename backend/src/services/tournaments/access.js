// ============================================================
// TOURNAMENTS: who can see and do what. One tournament can span gyms, so
// there is no org_id or RLS policy to lean on: every read goes through
// loadContext() here, and a tournament the caller may not see answers 404,
// identical to one that does not exist.
//
// Rules, server-side only (nothing in a request grants a permission):
//   * staff-only tournaments are invisible to clients
//   * gym-only tournaments are invisible outside the host's gym
//   * demo gyms are sealed: nobody outside sees them, and they see nobody
//   * only accepted hosts write scores; a pending co-host has no power yet
// ============================================================
import crypto from 'node:crypto';

export class TournamentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const fail = (status, code, message) => { throw new TournamentError(status, code, message); };

// No 0/O or 1/I/L: these get typed from a poster on a gym wall.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newCode(length = 7) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

export const hashGuestKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
export const newGuestKey = () => crypto.randomBytes(24).toString('base64url');

export const isTrue = (v) => v === 1 || v === true || v === '1';

export async function loadViewer(db, userId) {
  const u = await db.q1(
    `SELECT u.id, u.name, u.role, u.org_id, u.username, u.findable,
            o.name AS org_name, o.type AS org_type, o.is_demo
       FROM users u LEFT JOIN organizations o ON o.id = u.org_id
      WHERE u.id = ? AND u.active = 1`, [userId]);
  if (!u) fail(401, 'no_account', 'This account is no longer active');
  return {
    ...u,
    isStaff: ['TRAINER', 'GYM_OWNER', 'SUPER_ADMIN'].includes(u.role),
    independent: u.org_type === 'independent' || !u.org_id,
    isDemo: isTrue(u.is_demo),
  };
}

/** What a tournament shows as a person's gym. */
export const gymLabelOf = (viewer) => (viewer.independent ? 'Independent' : (viewer.org_name || 'Independent'));

/** Where the tournament is in its life, from the clock and the host's actions. */
export function phaseOf(t, at = new Date()) {
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'completed') return 'completed';
  if (t.status === 'live') return 'live';
  const ms = at.getTime();
  if (t.registration_opens_at && ms < Date.parse(t.registration_opens_at)) return 'soon';
  if (t.registration_closes_at && ms >= Date.parse(t.registration_closes_at)) return 'closed';
  return 'open';
}

export const canWithdrawNow = (t, at = new Date()) => (
  t.status === 'upcoming' && (!t.withdraw_closes_at || at.getTime() < Date.parse(t.withdraw_closes_at))
);

/** May this person see this tournament at all? viewer null: a signed-out visitor. */
export function canSee(t, viewer, { hostRow = null, entrant = null, viaCode = false } = {}) {
  if (hostRow && hostRow.status !== 'declined') return true;
  if (entrant && entrant.status !== 'declined') return true;
  const sameGym = !!viewer && !!t.host_org_id && viewer.org_id === t.host_org_id;
  if (isTrue(t.host_is_demo) && !sameGym) return false;
  if (viewer?.isDemo && !sameGym) return false;
  if (t.audience === 'staff' && !viewer?.isStaff) return false;
  // A QR is the host handing you the door, so it opens a gym-only event to
  // a visitor. It never opens a demo gym or a staff-only one.
  if (t.reach === 'gym' && !sameGym && !viaCode) return false;
  return true;
}

export const TOURNAMENT_SELECT = `
  SELECT t.*, o.is_demo AS host_is_demo, o.name AS host_org_name, u.name AS host_name
    FROM tournaments t
    LEFT JOIN organizations o ON o.id = t.host_org_id
    LEFT JOIN users u ON u.id = t.created_by`;

/** The tournament and this person's place in it. 404 if they may not see it. */
export async function loadContext(db, tournamentId, viewer, { viaCode = false } = {}) {
  const t = await db.q1(`${TOURNAMENT_SELECT} WHERE t.id = ?`, [tournamentId]);
  if (!t) fail(404, 'not_found', 'Tournament not found');
  const hostRow = await db.q1('SELECT * FROM tournament_hosts WHERE tournament_id = ? AND user_id = ?', [t.id, viewer.id]);
  const entrant = await db.q1('SELECT * FROM tournament_entrants WHERE tournament_id = ? AND user_id = ?', [t.id, viewer.id]);
  if (!canSee(t, viewer, { hostRow, entrant, viaCode })) fail(404, 'not_found', 'Tournament not found');
  const isHost = hostRow?.status === 'accepted';
  return { t, viewer, hostRow, entrant, isHost, isPrime: isHost && hostRow.role === 'prime' };
}

export function requireHost(ctx) {
  if (!ctx.isHost) fail(403, 'hosts_only', 'Only the hosts of this tournament can do that');
}
export function requirePrime(ctx) {
  if (!ctx.isPrime) fail(403, 'prime_only', 'Only the main host can do that');
}
export function requireNotFinished(t) {
  if (t.status === 'completed' || t.status === 'cancelled') fail(409, 'finished', 'This tournament is over');
}
