// ============================================================
// COMMUNITY SOCIAL — reactions, comments, and challenges.
//
// Two independent ideas live here because they share one rule: the
// database stores what people DID, and everything else is derived at read
// time.
//
//   Reactions/comments  are stored -- they are facts about human action
//                       and exist nowhere else.
//
//   Challenge progress  is NOT stored. It is recomputed from workouts and
//                       personal_records on every read. A stored counter
//                       would be a second source of truth that drifts the
//                       first time a workout is deleted, edited, or
//                       logged retroactively -- and a challenge showing
//                       4/4 when the member has 3 workouts is exactly the
//                       "faked progress" this design forbids.
//
// AUTHORIZATION IS NOT OPTIONAL HERE. Every function takes an orgId and
// filters by it, and every write checks community membership. Frontend
// visibility flags are advisory; these functions are the boundary.
// ============================================================
import { id, now } from '../ids.js';
import { periodRange } from './community.js';
import { gymScope, toScope } from './communityScope.js';

const int = (v) => {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

// The whole palette. Deliberately four: a reaction should be one tap with
// an obvious meaning, and a long emoji menu turns a gesture of support
// into a decision. Anything outside this set is rejected rather than
// stored, so the feed can render counts without sanitising arbitrary text.
export const REACTIONS = ['like', 'fire', 'clap', 'strong'];
const TARGET_TYPES = ['share', 'pr'];

export function isValidReaction(emoji) { return REACTIONS.includes(emoji); }
export function isValidTarget(type) { return TARGET_TYPES.includes(type); }

/**
 * Confirm a target actually exists in this org before anything is
 * attached to it. Without this a member could react to an arbitrary id --
 * including one from another gym -- and create a row that leaks the
 * existence of another org's data through its reaction count.
 */
export async function targetExists(db, orgId, targetType, targetId) {
  if (targetType === 'share') {
    const r = await db.q1(
      'SELECT id FROM community_workout_shares WHERE id = ? AND org_id = ?', [targetId, orgId]);
    return !!r;
  }
  if (targetType === 'pr') {
    // A PR is only a community target while its owner is still an opted-in
    // member of THIS org -- leaving the community must take your records
    // out of it.
    const r = await db.q1(
      `SELECT pr.id FROM personal_records pr
         JOIN community_members cm ON cm.client_id = pr.client_id AND cm.enabled = 1
        WHERE pr.id = ? AND cm.org_id = ?`, [targetId, orgId]);
    return !!r;
  }
  return false;
}

// ---- REACTIONS ----

/** Toggle: react if absent, remove if present. Returns the new state so
 *  the caller never has to re-query to know what happened. */
export async function toggleReaction(db, { orgId, clientId, targetType, targetId, emoji }) {
  const existing = await db.q1(
    `SELECT id FROM community_reactions
      WHERE target_type = ? AND target_id = ? AND client_id = ? AND emoji = ?`,
    [targetType, targetId, clientId, emoji]);

  if (existing) {
    await db.run('DELETE FROM community_reactions WHERE id = ?', [existing.id]);
    return { reacted: false };
  }
  await db.run(
    `INSERT INTO community_reactions (id, org_id, target_type, target_id, client_id, emoji, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [id('crx'), orgId, targetType, targetId, clientId, emoji, now()]);
  return { reacted: true };
}

/**
 * Reaction counts for many targets at once, plus which ones the viewer
 * reacted to.
 *
 * Batched deliberately: a feed of 30 cards asking for its own counts is
 * 30 round trips that grow with the page, and the N+1 only shows up once
 * a gym has real activity -- exactly when it hurts.
 */
export async function reactionsFor(db, { orgId, clientId, targets }) {
  if (!targets.length) return new Map();
  const keys = targets.map((t) => `${t.type}:${t.id}`);
  const ids = targets.map((t) => t.id);
  const placeholders = ids.map(() => '?').join(',');

  const [counts, mine] = await Promise.all([
    db.q(
      `SELECT target_type, target_id, emoji, COUNT(*) AS n
         FROM community_reactions
        WHERE org_id = ? AND target_id IN (${placeholders})
        GROUP BY target_type, target_id, emoji`,
      [orgId, ...ids]),
    clientId ? db.q(
      `SELECT target_type, target_id, emoji FROM community_reactions
        WHERE org_id = ? AND client_id = ? AND target_id IN (${placeholders})`,
      [orgId, clientId, ...ids]) : Promise.resolve([]),
  ]);

  const out = new Map();
  for (const k of keys) out.set(k, { counts: {}, mine: [], total: 0 });
  for (const r of counts) {
    const k = `${r.target_type}:${r.target_id}`;
    const entry = out.get(k);
    if (!entry) continue;
    entry.counts[r.emoji] = int(r.n);
    entry.total += int(r.n);
  }
  for (const r of mine) {
    const entry = out.get(`${r.target_type}:${r.target_id}`);
    if (entry) entry.mine.push(r.emoji);
  }
  return out;
}

// ---- COMMENTS ----

export async function addComment(db, { orgId, clientId, targetType, targetId, body }) {
  const cid = id('cmc');
  await db.run(
    `INSERT INTO community_comments (id, org_id, target_type, target_id, client_id, body, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [cid, orgId, targetType, targetId, clientId, String(body).trim().slice(0, 500), now()]);
  return { id: cid };
}

export async function listComments(db, { orgId, targetType, targetId, limit = 50 }) {
  const rows = await db.q(
    `SELECT cc.id, cc.client_id, cc.body, cc.created_at, u.name AS author_name
       FROM community_comments cc
       JOIN clients c ON c.id = cc.client_id
       JOIN users u ON u.id = c.user_id
       JOIN community_members cm ON cm.client_id = cc.client_id AND cm.enabled = 1
      WHERE cc.org_id = ? AND cc.target_type = ? AND cc.target_id = ?
      ORDER BY cc.created_at ASC, cc.id ASC
      LIMIT ?`,
    [orgId, targetType, targetId, limit]);
  return rows.map((r) => ({
    id: r.id, clientId: r.client_id, authorName: r.author_name || 'Member',
    body: r.body, createdAt: r.created_at,
  }));
}

/** Only the author may delete, and only within their own org. Checked in
 *  the DELETE itself so there is no read-then-write gap to race. */
export async function deleteComment(db, { orgId, clientId, commentId }) {
  const res = await db.run(
    'DELETE FROM community_comments WHERE id = ? AND client_id = ? AND org_id = ?',
    [commentId, clientId, orgId]);
  return res.changes > 0;
}

/** Comment counts for a page of feed targets -- same N+1 reasoning as
 *  reactionsFor. */
export async function commentCountsFor(db, { orgId, targets }) {
  if (!targets.length) return new Map();
  const ids = targets.map((t) => t.id);
  const rows = await db.q(
    `SELECT target_type, target_id, COUNT(*) AS n FROM community_comments
      WHERE org_id = ? AND target_id IN (${ids.map(() => '?').join(',')})
      GROUP BY target_type, target_id`,
    [orgId, ...ids]);
  const out = new Map();
  for (const r of rows) out.set(`${r.target_type}:${r.target_id}`, int(r.n));
  return out;
}

// ---- CHALLENGES ----

/**
 * Active challenges with progress computed live.
 *
 * `metric` is constrained by the schema to the three things this codebase
 * can actually measure from existing tables. That constraint is the
 * feature: it makes it impossible to create a challenge whose progress
 * would have to be invented, because there is no code path that could
 * report one.
 */
export async function activeChallenges(db, { orgId, clientId, today }) {
  const rows = await db.q(
    `SELECT * FROM community_challenges
      WHERE org_id = ? AND start_date <= ? AND end_date >= ?
      ORDER BY end_date ASC, id ASC`,
    [orgId, today, today]);
  if (!rows.length) return [];

  const scope = gymScope(orgId);
  return Promise.all(rows.map((ch) => challengeProgress(db, { scope, challenge: ch, clientId })));
}

/**
 * Live progress for ONE challenge definition, in any community scope. The
 * gym's activeChallenges above and friend communities both come through
 * here, so a challenge reads the same way wherever it lives.
 *
 * `challenge` is a raw row (community_challenges or
 * community_group_challenges -- they share every column this reads).
 */
export async function challengeProgress(db, { scope: scopeOrOrgId, challenge: ch, clientId }) {
  const scope = toScope(scopeOrOrgId);
  const window = { start: ch.start_date, end: ch.end_date };
  const [mine, community, participants] = await Promise.all([
    clientId ? measure(db, { scope, clientId, metric: ch.metric, ...window }) : Promise.resolve(0),
    ch.scope === 'community' ? measure(db, { scope, metric: ch.metric, ...window }) : Promise.resolve(null),
    participantCount(db, { scope, metric: ch.metric, goal: ch.goal, ...window }),
  ]);

  const target = Number(ch.goal);
  const value = ch.scope === 'community' ? community : mine;
  return {
    id: ch.id,
    name: ch.name,
    description: ch.description,
    metric: ch.metric,
    scope: ch.scope,
    goal: target,
    startDate: ch.start_date,
    endDate: ch.end_date,
    value,
    // Capped for the BAR only. `value` stays raw so a member who beat
    // the goal sees that they beat it rather than a flat 100%.
    percent: target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0,
    complete: value >= target,
    yourValue: mine,
    yourPercent: target > 0 ? Math.min(100, Math.round((mine / target) * 100)) : 0,
    membersCompleted: participants.completed,
    membersParticipating: participants.participating,
  };
}

/**
 * Every counted member's value for one challenge, ranked -- the challenge's
 * own leaderboard. Only members of the scope contribute, so someone who
 * left the community (or stopped sharing stats) drops out of the standings
 * and out of the community total at the same moment.
 */
export async function challengeStandings(db, { scope: scopeOrOrgId, challenge: ch }) {
  const scope = toScope(scopeOrOrgId);
  const rows = await perMemberValues(db, {
    scope, metric: ch.metric, start: ch.start_date, end: ch.end_date,
  });
  const goal = Number(ch.goal);
  return rows
    .map((r) => ({ clientId: r.cid, value: Math.round(Number(r.v) || 0) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.clientId.localeCompare(b.clientId))
    .map((r, i) => ({ ...r, rank: i + 1, complete: r.value >= goal }));
}

/** Run one challenge metric over a window, for a single member or for the
 *  whole community. Reuses the SAME expressions the leaderboards use --
 *  a challenge and the board it sits next to must never disagree about
 *  what a workout or a kilogram is. */
async function measure(db, { scope, clientId, metric, start, end }) {
  if (metric === 'workouts' || metric === 'active_days') {
    const m = scope.member('cm', 'w.client_id');
    // active_days counts (member, day) pairs, so a community total is the
    // sum of each member's own training days rather than the number of
    // calendar days anyone at all trained. || concatenates on both engines.
    const count = metric === 'active_days'
      ? "COUNT(DISTINCT w.client_id || ':' || w.scheduled_date)"
      : 'COUNT(*)';
    const r = await db.q1(
      `SELECT ${count} AS n FROM workouts w
         ${m.sql}
        WHERE w.status = 'completed'
          AND w.scheduled_date >= ? AND w.scheduled_date <= ?
          ${clientId ? 'AND w.client_id = ?' : ''}`,
      clientId ? [...m.params, start, end, clientId] : [...m.params, start, end]);
    return int(r?.n);
  }
  if (metric === 'prs') {
    const m = scope.member('cm', 'pr.client_id');
    const r = await db.q1(
      `SELECT COUNT(*) AS n FROM personal_records pr
         ${m.sql}
        WHERE pr.date >= ? AND pr.date <= ?
          ${clientId ? 'AND pr.client_id = ?' : ''}`,
      clientId ? [...m.params, start, end, clientId] : [...m.params, start, end]);
    return int(r?.n);
  }
  // volume
  const m = scope.member('cm', 'wl.client_id');
  const r = await db.q1(
    `SELECT COALESCE(SUM(CASE WHEN esl.actual_reps > 0 AND esl.actual_weight >= 0
                              THEN esl.actual_reps * esl.actual_weight ELSE 0 END), 0) AS v
       FROM exercise_set_logs esl
       JOIN workout_logs wl ON wl.id = esl.workout_log_id
       ${m.sql}
      WHERE wl.date >= ? AND wl.date <= ? AND esl.completed = 1
        ${clientId ? 'AND wl.client_id = ?' : ''}`,
    clientId ? [...m.params, start, end, clientId] : [...m.params, start, end]);
  return Math.round(Number(r?.v) || 0);
}

/** One row per counted member with their value for the metric. Shared by
 *  the participant count and the standings so the two can never disagree
 *  about who is taking part. */
async function perMemberValues(db, { scope, metric, start, end }) {
  if (metric === 'prs') {
    const m = scope.member('cm', 'pr.client_id');
    return db.q(
      `SELECT pr.client_id AS cid, COUNT(*) AS v FROM personal_records pr
         ${m.sql}
        WHERE pr.date >= ? AND pr.date <= ? GROUP BY pr.client_id`,
      [...m.params, start, end]);
  }
  if (metric === 'workouts' || metric === 'active_days') {
    const m = scope.member('cm', 'w.client_id');
    const count = metric === 'active_days' ? 'COUNT(DISTINCT w.scheduled_date)' : 'COUNT(*)';
    return db.q(
      `SELECT w.client_id AS cid, ${count} AS v FROM workouts w
         ${m.sql}
        WHERE w.status = 'completed'
          AND w.scheduled_date >= ? AND w.scheduled_date <= ? GROUP BY w.client_id`,
      [...m.params, start, end]);
  }
  const m = scope.member('cm', 'wl.client_id');
  return db.q(
    `SELECT wl.client_id AS cid,
            COALESCE(SUM(CASE WHEN esl.actual_reps > 0 AND esl.actual_weight >= 0
                              THEN esl.actual_reps * esl.actual_weight ELSE 0 END), 0) AS v
       FROM exercise_set_logs esl
       JOIN workout_logs wl ON wl.id = esl.workout_log_id
       ${m.sql}
      WHERE wl.date >= ? AND wl.date <= ? AND esl.completed = 1
      GROUP BY wl.client_id`,
    [...m.params, start, end]);
}

/** How many members are taking part, and how many have finished. Drives
 *  the honest "42 / 60 members" line -- both halves counted, never
 *  estimated from one. */
async function participantCount(db, { scope, metric, goal, start, end }) {
  const rows = await perMemberValues(db, { scope, metric, start, end });
  const target = Number(goal);
  return {
    participating: rows.length,
    completed: rows.filter((r) => Number(r.v) >= target).length,
  };
}

export async function createChallenge(db, { orgId, name, description, metric, goal, scope, startDate, endDate, createdBy }) {
  const cid = id('chal');
  await db.run(
    `INSERT INTO community_challenges (id, org_id, name, description, metric, goal, scope, start_date, end_date, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, orgId, String(name).trim().slice(0, 80), description ? String(description).slice(0, 300) : null,
     metric, Number(goal), scope || 'member', startDate, endDate, createdBy || null, now()]);
  return { id: cid };
}

export async function deleteChallenge(db, { orgId, challengeId }) {
  const res = await db.run('DELETE FROM community_challenges WHERE id = ? AND org_id = ?', [challengeId, orgId]);
  return res.changes > 0;
}

/** The current week's window, so a caller creating a "this week" challenge
 *  uses the same week boundary the leaderboards do. */
export function thisWeekWindow(tz) { return periodRange('week', tz); }
