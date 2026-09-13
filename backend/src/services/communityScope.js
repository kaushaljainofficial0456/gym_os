// ============================================================
// COMMUNITY SCOPE — the one thing that differs between a gym community
// and a friend community: who counts as a member.
//
// Every aggregate in community.js, communityIntel.js and
// communitySocial.js reads the same tables (workouts, exercise_set_logs,
// personal_records) with the same expressions. The only varying part is
// the JOIN that narrows those rows to "people in this community who
// agreed to be counted". Expressing that JOIN as a value -- instead of
// branching every query on the community type -- is what stops the gym
// and friend dashboards drifting into two implementations that disagree
// about what a workout, a kilogram or a streak is.
//
//   gymScope(orgId)           community_members: enabled = 1 AND org_id = ?
//   friendScope(communityId)  community_memberships: status = 'active'
//                             AND share_stats = 1
//
// AUTHORIZATION DOES NOT LIVE HERE. A scope decides who is COUNTED, not
// who may LOOK. Routes establish access first (gym: the JWT's org plus
// the viewer's opt-in; friend: the viewer's active membership) and only
// then build a scope.
// ============================================================

/**
 * @typedef {object} CommunityScope
 * @property {'gym'|'friend'} kind
 * @property {string} id
 * @property {(alias: string, clientCol: string, opts?: MemberOpts) => { sql: string, params: any[] }} member
 *
 * @typedef {object} MemberOpts
 * @property {boolean} [strict]  GYM: additionally require the client's
 *   CURRENT clients.org_id to be this org. Some gym queries always did this
 *   (they joined clients and filtered c.org_id) and others never did. That
 *   difference is preserved exactly rather than unified, because unifying it
 *   changes which multi-gym members appear on which board. No effect on a
 *   friend scope, whose members have no shared org by definition.
 * @property {string} [sinceJoinedCol]  FRIEND: a YYYY-MM-DD column that must
 *   fall on or after the day the member joined. For "together" totals, which
 *   must not count what someone did before they were part of the group. No
 *   effect on a gym scope, whose opt-in row carries no join date.
 */

/** @returns {CommunityScope} */
export function gymScope(orgId) {
  if (!orgId) throw new Error('gymScope requires an orgId');
  return Object.freeze({
    kind: 'gym',
    id: orgId,
    member(alias, clientCol, { strict = false } = {}) {
      let sql = `JOIN community_members ${alias} ON ${alias}.client_id = ${clientCol}`
        + ` AND ${alias}.enabled = 1 AND ${alias}.org_id = ?`;
      const params = [orgId];
      if (strict) {
        sql += ` JOIN clients ${alias}_c ON ${alias}_c.id = ${clientCol} AND ${alias}_c.org_id = ?`;
        params.push(orgId);
      }
      return { sql, params };
    },
  });
}

/**
 * Who a friend community COUNTS: active members who share their stats.
 * Exported so the few batched queries that span several communities at
 * once (the hub list) state the rule by reference rather than restating
 * it -- one definition, or the hub card and the dashboard it opens will
 * eventually disagree.
 */
export function friendCountedPredicate(alias) {
  return `${alias}.status = 'active' AND ${alias}.share_stats = 1`;
}

/** @returns {CommunityScope} */
export function friendScope(communityId) {
  if (!communityId) throw new Error('friendScope requires a communityId');
  return Object.freeze({
    kind: 'friend',
    id: communityId,
    member(alias, clientCol, { sinceJoinedCol = null } = {}) {
      let sql = `JOIN community_memberships ${alias} ON ${alias}.client_id = ${clientCol}`
        + ` AND ${alias}.community_id = ? AND ${friendCountedPredicate(alias)}`;
      // SUBSTR, not a date function: joined_at is an ISO timestamp and the
      // activity columns are YYYY-MM-DD keys, and SUBSTR behaves identically
      // on SQLite and PostgreSQL.
      if (sinceJoinedCol) sql += ` AND ${sinceJoinedCol} >= SUBSTR(${alias}.joined_at, 1, 10)`;
      return { sql, params: [communityId] };
    },
  });
}

/**
 * Accepts either a scope or a bare orgId. Every existing caller passes an
 * orgId string, and those call sites (and their tests) keep working
 * unchanged -- a string always means the gym community of that org.
 */
export function toScope(scopeOrOrgId) {
  if (typeof scopeOrOrgId === 'string') return gymScope(scopeOrOrgId);
  if (scopeOrOrgId && typeof scopeOrOrgId.member === 'function') return scopeOrOrgId;
  throw new Error('Expected a community scope or an orgId');
}
