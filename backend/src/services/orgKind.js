// ============================================================
// "What KIND of organization is this?" -- one lookup, cached.
//
// Independent clients (Google sign-in, no gym) all share a single
// pseudo-organization with type='independent' -- see routes/auth.js's
// ensureIndependentOrg. Gym-only features must be off for them: there is
// no physical gym to have a live crowd, and no gym community to join.
//
// WHY A STRUCTURAL CHECK AND NOT JUST SETTINGS: the independent org's
// gym_settings row does set crowd_enabled=0, but it never set
// community_enabled, so that column fell back to its schema DEFAULT of 1
// and every independent client was offered a gym community to join.
// Settings are DATA -- they drift, they predate columns, and they are
// created once with ON CONFLICT DO NOTHING so a row written before a
// column existed is never corrected. The org's TYPE is structural and
// cannot drift, so gym-only features gate on that and are then
// additionally narrowable by settings for real gyms.
// ============================================================

const cache = new Map();          // orgId -> { type, at }
const TTL_MS = 5 * 60 * 1000;

export async function getOrgType(db, orgId) {
  if (!orgId) return null;
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.type;
  const row = await db.q1('SELECT type FROM organizations WHERE id = ?', [orgId]);
  const type = row?.type || null;
  cache.set(orgId, { type, at: Date.now() });
  return type;
}

/** True for the shared pseudo-org that independent (no-gym) clients live
 *  in. Gym-only features must be hidden -- not merely empty -- for these
 *  users: an empty "Gym crowd" card is worse than no card at all. */
export async function isIndependentOrg(db, orgId) {
  return (await getOrgType(db, orgId)) === 'independent';
}

/** Test/ops hook -- org type is effectively immutable in normal use, but
 *  a test that flips it needs the cache not to lie. */
export function invalidateOrgKindCache(orgId) {
  if (orgId) cache.delete(orgId); else cache.clear();
}
