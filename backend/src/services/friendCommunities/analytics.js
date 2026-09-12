// ============================================================
// FRIEND COMMUNITIES — the dashboard: pulse, position, boards, streaks,
// challenges, milestones, members.
//
// NOT A SECOND ANALYTICS ENGINE. Every figure here comes from the same
// functions the gym community uses -- communityPulse, activitySeries,
// memberPosition, weeklyRecap, computeBoards, computeStreaks,
// challengeProgress -- called with a friend scope instead of an orgId.
// The only thing this file adds is composition, and the few facts that
// exist only for an explicit community (milestones reached together, the
// member list with its roles).
//
// WHO IS COUNTED: active members with share_stats on (see
// communityScope.js). A member who turns sharing off drops out of every
// total, board and challenge at once, and is still listed as a member.
// ============================================================
import { id, now } from '../../ids.js';
import { dayKey, todayKey } from '../../utils/time.js';
import { friendScope } from '../communityScope.js';
import { periodRange, computeBoards, computeStreaks, resolveMembers } from '../community.js';
import {
  communityPulse, activitySeries, busiestWeekday, memberPosition, memberTrend, weeklyRecap,
} from '../communityIntel.js';
import { challengeProgress, challengeStandings } from '../communitySocial.js';
import {
  fail, int, LIMITS, ROLE_RANK, can, requireCan, gymLabel, likeTerm, cleanText, notifyMembers,
} from './core.js';

export const FRIEND_BOARDS = Object.freeze(['completedWorkouts', 'activeDays', 'volume', 'streak', 'prs']);

/** Shown under the board tabs. A ranking whose rule the reader has to
 *  guess is an opaque score by another name. */
export const METRIC_DEFINITIONS = Object.freeze({
  completedWorkouts: 'Completed workouts in the selected period.',
  activeDays: 'Days with at least one completed workout. Two sessions in a day still count once.',
  volume: 'Total kilograms lifted: reps × weight across completed sets.',
  streak: 'Consecutive days with a completed workout, ending today or yesterday.',
  prs: 'Personal records set in the period, detected from logged sets.',
});

const PERIODS = ['day', 'week', 'month'];
export const cleanPeriod = (p) => (PERIODS.includes(p) ? p : 'week');

/** YYYY-MM-DD shifted by whole days in the same calendar space the rest of
 *  the community code uses (noon UTC, so no DST edge moves the day). */
function addDays(key, days, tz) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return dayKey(d, tz);
}

// ---------------- overview ----------------

export async function friendOverview(db, { community, membership, period = 'week', tz }) {
  const scope = friendScope(community.id);
  const clientId = membership.client_id;
  const safePeriod = cleanPeriod(period);

  const [pulse, series, recap, position, trend, streaks, challenges, milestones, preview] = await Promise.all([
    communityPulse(db, scope, tz),
    activitySeries(db, scope, tz, 28),
    weeklyRecap(db, scope, tz),
    memberPosition(db, scope, clientId, safePeriod, tz),
    memberTrend(db, clientId, tz, 4),
    computeStreaks(db, scope, tz, { limit: LIMITS.maxMembers }),
    listGroupChallenges(db, { community, clientId, tz }),
    communityMilestones(db, { community }),
    // A few names for the header's avatar row. Every one of them is someone
    // the viewer already shares this community with.
    db.q(
      `SELECT m.client_id, u.name
         FROM community_memberships m
         JOIN clients c ON c.id = m.client_id
         JOIN users u ON u.id = c.user_id
        WHERE m.community_id = ? AND m.status = 'active'
        ORDER BY m.joined_at ASC, m.id ASC
        LIMIT 6`,
      [community.id]),
  ]);

  const active = streaks.filter((s) => s.value > 0);
  const names = await resolveMembers(db, active.slice(0, 5).map((s) => s.clientId));
  const topStreaks = active.slice(0, 5).map((s) => ({ ...s, name: names.get(s.clientId)?.name || 'Member' }));

  return {
    period: safePeriod,
    // The server's own day, so a phone in another timezone cannot pick a
    // challenge start date this server would reject as being in the past.
    today: todayKey(tz),
    memberPreview: preview.map((p) => ({ clientId: p.client_id, name: p.name || 'Member' })),
    pulse,
    activity: series,
    busiestWeekday: busiestWeekday(series),
    position,
    trend,
    recap: { ...recap, highestStreak: topStreaks[0] || null },
    streaks: topStreaks,
    yourStreak: streaks.find((s) => s.clientId === clientId)?.value || 0,
    challenges,
    milestones,
  };
}

// ---------------- milestones ----------------

const WORKOUT_TIERS = Object.freeze([10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
const PR_TIERS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1000]);

function tierProgress(value, tiers) {
  const reached = [...tiers].reverse().find((t) => value >= t) || null;
  const next = tiers.find((t) => value < t) || null;
  return { value, reached, next, toNext: next ? next - value : 0 };
}

/**
 * What the group has done TOGETHER: completed workouts and records since
 * the community began, each counted only from the day its member joined.
 * A tier is "reached" only when the count genuinely crosses it -- there is
 * no rounding up and no milestone for a group that has not earned one.
 */
export async function communityMilestones(db, { community }) {
  const scope = friendScope(community.id);
  const since = String(community.created_at).slice(0, 10);
  const mw = scope.member('cm', 'w.client_id', { sinceJoinedCol: 'w.scheduled_date' });
  const mp = scope.member('cm', 'pr.client_id', { sinceJoinedCol: 'pr.date' });
  const [w, p] = await Promise.all([
    db.q1(
      `SELECT COUNT(*) AS n FROM workouts w ${mw.sql}
        WHERE w.status = 'completed' AND w.scheduled_date >= ?`,
      [...mw.params, since]),
    db.q1(
      `SELECT COUNT(*) AS n FROM personal_records pr ${mp.sql} WHERE pr.date >= ?`,
      [...mp.params, since]),
  ]);
  return {
    since,
    workouts: tierProgress(int(w?.n), WORKOUT_TIERS),
    prs: tierProgress(int(p?.n), PR_TIERS),
  };
}

// ---------------- leaderboards ----------------

export async function friendLeaderboards(db, { community, period, tz }) {
  const { period: window, leaderboards } = await computeBoards(
    db, friendScope(community.id), cleanPeriod(period), tz, { metrics: FRIEND_BOARDS, limit: LIMITS.maxMembers });

  const ids = new Set();
  for (const board of Object.values(leaderboards)) for (const entry of board) ids.add(entry.clientId);
  const names = await resolveMembers(db, [...ids]);
  const enrich = (board) => board.map((entry) => ({ ...entry, name: names.get(entry.clientId)?.name || 'Member' }));

  return {
    period: window,
    leaderboards: Object.fromEntries(Object.entries(leaderboards).map(([key, board]) => [key, enrich(board)])),
    definitions: METRIC_DEFINITIONS,
  };
}

// ---------------- members ----------------

/** Month-to-date and lifetime training facts for a set of members. The
 *  caller passes ONLY members who share stats. */
async function memberStats(db, clientIds, tz) {
  const out = new Map();
  if (!clientIds.length) return out;
  const month = periodRange('month', tz);
  const ph = clientIds.map(() => '?').join(',');
  const [monthWorkouts, monthPRs, lifetime, lifetimePRs] = await Promise.all([
    db.q(
      `SELECT client_id, COUNT(*) AS n FROM workouts
        WHERE client_id IN (${ph}) AND status = 'completed' AND scheduled_date >= ? AND scheduled_date <= ?
        GROUP BY client_id`,
      [...clientIds, month.start, month.end]),
    db.q(
      `SELECT client_id, COUNT(*) AS n FROM personal_records
        WHERE client_id IN (${ph}) AND date >= ? AND date <= ?
        GROUP BY client_id`,
      [...clientIds, month.start, month.end]),
    db.q(
      `SELECT client_id, COUNT(*) AS n, MAX(scheduled_date) AS last_active FROM workouts
        WHERE client_id IN (${ph}) AND status = 'completed'
        GROUP BY client_id`,
      clientIds),
    db.q(
      `SELECT client_id, COUNT(*) AS n FROM personal_records WHERE client_id IN (${ph}) GROUP BY client_id`,
      clientIds),
  ]);
  for (const cid of clientIds) {
    out.set(cid, { workoutsThisMonth: 0, prsThisMonth: 0, totalWorkouts: 0, totalPRs: 0, lastActive: null });
  }
  for (const r of monthWorkouts) out.get(r.client_id).workoutsThisMonth = int(r.n);
  for (const r of monthPRs) out.get(r.client_id).prsThisMonth = int(r.n);
  for (const r of lifetime) {
    const s = out.get(r.client_id);
    s.totalWorkouts = int(r.n);
    s.lastActive = r.last_active || null;
  }
  for (const r of lifetimePRs) out.get(r.client_id).totalPRs = int(r.n);
  return out;
}

const ROLE_ORDER_SQL = "CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END";

/**
 * Everyone in the community. Members who do not share stats are listed by
 * name and role only -- no zeros standing in for numbers they chose not to
 * share, which would read as "did nothing" rather than "keeps it private".
 */
export async function friendMembers(db, { community, membership, tz, search = null }) {
  const params = [community.id];
  let filter = '';
  const term = String(search || '').trim();
  if (term) {
    filter = "AND LOWER(u.name) LIKE ? ESCAPE '\\'";
    params.push(likeTerm(term.slice(0, 60)));
  }
  const rows = await db.q(
    `SELECT m.client_id, m.role, m.joined_at, m.share_stats, m.show_gym,
            u.name, o.name AS org_name, o.type AS org_type
       FROM community_memberships m
       JOIN clients c ON c.id = m.client_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN organizations o ON o.id = c.org_id
      WHERE m.community_id = ? AND m.status = 'active' ${filter}
      ORDER BY ${ROLE_ORDER_SQL}, LOWER(u.name) ASC, m.client_id ASC
      LIMIT ${LIMITS.maxMembers}`,
    params);

  const sharing = rows.filter((r) => Number(r.share_stats) === 1).map((r) => r.client_id);
  const [stats, streaks] = await Promise.all([
    memberStats(db, sharing, tz),
    sharing.length ? computeStreaks(db, friendScope(community.id), tz, { limit: LIMITS.maxMembers }) : [],
  ]);
  const streakBy = new Map(streaks.map((s) => [s.clientId, s.value]));

  return rows.map((r) => {
    const shares = Number(r.share_stats) === 1;
    const s = stats.get(r.client_id);
    return {
      clientId: r.client_id,
      name: r.name || 'Member',
      role: r.role,
      joinedAt: r.joined_at,
      gym: gymLabel(r),
      isYou: r.client_id === membership.client_id,
      sharesStats: shares,
      stats: shares
        ? {
          workoutsThisMonth: s?.workoutsThisMonth || 0,
          prsThisMonth: s?.prsThisMonth || 0,
          lastActive: s?.lastActive || null,
          streak: streakBy.get(r.client_id) || 0,
        }
        : null,
    };
  });
}

const PERSONAL_WORKOUT_TIERS = Object.freeze([10, 25, 50, 100, 250, 500, 1000]);

/** Training milestones read straight off real counts. There is no badge
 *  store behind this and nothing is awarded -- a milestone is simply a
 *  threshold the member's own logged history has already crossed. */
function personalMilestones(s) {
  if (!s) return [];
  const out = [];
  const reached = [...PERSONAL_WORKOUT_TIERS].reverse().find((t) => s.totalWorkouts >= t);
  if (reached) out.push({ key: `workouts_${reached}`, label: `${reached} workouts logged`, kind: 'workouts' });
  if (s.totalPRs > 0) out.push({ key: 'first_pr', label: 'First personal record', kind: 'prs' });
  return out;
}

export async function memberProfile(db, { community, membership, targetClientId, tz }) {
  const row = await db.q1(
    `SELECT m.client_id, m.role, m.joined_at, m.share_stats, m.show_gym,
            u.name, o.name AS org_name, o.type AS org_type
       FROM community_memberships m
       JOIN clients c ON c.id = m.client_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN organizations o ON o.id = c.org_id
      WHERE m.community_id = ? AND m.client_id = ? AND m.status = 'active'`,
    [community.id, targetClientId]);
  if (!row) fail(404, 'member_not_found', 'Member not found');

  const shares = Number(row.share_stats) === 1;
  const [stats, streaks, recent] = await Promise.all([
    shares ? memberStats(db, [targetClientId], tz) : Promise.resolve(new Map()),
    shares ? computeStreaks(db, friendScope(community.id), tz, { limit: LIMITS.maxMembers }) : Promise.resolve([]),
    // Only what they shared into THIS community. A profile is a view of
    // the group's own feed, never a window into the member's history.
    db.q(
      `SELECT id, type, payload, created_at FROM community_events
        WHERE community_id = ? AND client_id = ? AND type IN ('workout', 'pr')
        ORDER BY created_at DESC, id DESC
        LIMIT 5`,
      [community.id, targetClientId]),
  ]);
  const s = stats.get(targetClientId);
  const isYou = targetClientId === membership.client_id;
  const outranks = ROLE_RANK[membership.role] > ROLE_RANK[row.role];

  return {
    clientId: row.client_id,
    name: row.name || 'Member',
    role: row.role,
    joinedAt: row.joined_at,
    gym: gymLabel(row),
    isYou,
    sharesStats: shares,
    stats: shares
      ? {
        workoutsThisMonth: s?.workoutsThisMonth || 0,
        prsThisMonth: s?.prsThisMonth || 0,
        totalWorkouts: s?.totalWorkouts || 0,
        lastActive: s?.lastActive || null,
        streak: streaks.find((x) => x.clientId === targetClientId)?.value || 0,
      }
      : null,
    milestones: shares ? personalMilestones(s) : [],
    recentShares: recent.map((e) => {
      let payload = {};
      try { payload = JSON.parse(e.payload) || {}; } catch { payload = {}; }
      return { id: e.id, type: e.type, createdAt: e.created_at, payload };
    }),
    // What the VIEWER may do to this member. Advisory for the UI; every
    // action re-checks server-side.
    actions: {
      remove: !isYou && can(membership.role, 'removeMember') && outranks,
      makeAdmin: !isYou && can(membership.role, 'setRole') && row.role === 'member',
      makeMember: !isYou && can(membership.role, 'setRole') && row.role === 'admin',
      transfer: !isYou && can(membership.role, 'transfer'),
    },
  };
}

// ---------------- challenges ----------------

export const CHALLENGE_METRICS = Object.freeze(['workouts', 'volume', 'prs', 'active_days']);
const MAX_CHALLENGE_DAYS = 92;
const MAX_LEAD_DAYS = 60;
const RECENTLY_ENDED_DAYS = 14;

function challengeDefinition(ch) {
  return {
    id: ch.id,
    name: ch.name,
    description: ch.description || null,
    metric: ch.metric,
    scope: ch.scope,
    goal: Number(ch.goal),
    startDate: ch.start_date,
    endDate: ch.end_date,
  };
}

/** Active challenges with live progress, upcoming ones as definitions, and
 *  ones that ended in the last two weeks with their final numbers -- so a
 *  finished challenge is celebrated rather than silently disappearing. */
export async function listGroupChallenges(db, { community, clientId, tz }) {
  const today = todayKey(tz);
  const rows = await db.q(
    `SELECT * FROM community_group_challenges
      WHERE community_id = ? AND end_date >= ?
      ORDER BY start_date ASC, end_date ASC, id ASC`,
    [community.id, addDays(today, -RECENTLY_ENDED_DAYS, tz)]);
  const scope = friendScope(community.id);
  const progress = await Promise.all(rows.map((ch) => (
    ch.start_date > today ? null : challengeProgress(db, { scope, challenge: ch, clientId }))));

  const active = [];
  const upcoming = [];
  const ended = [];
  rows.forEach((ch, i) => {
    if (ch.start_date > today) upcoming.push(challengeDefinition(ch));
    else if (ch.end_date < today) ended.push({ ...progress[i], status: 'ended' });
    else active.push({ ...progress[i], status: 'active' });
  });
  return { active, upcoming, ended };
}

export async function challengeDetail(db, { community, membership, challengeId, tz }) {
  const ch = await db.q1(
    'SELECT * FROM community_group_challenges WHERE id = ? AND community_id = ?', [challengeId, community.id]);
  if (!ch) fail(404, 'challenge_not_found', 'Challenge not found');
  const scope = friendScope(community.id);
  const today = todayKey(tz);
  const [progress, standings] = await Promise.all([
    challengeProgress(db, { scope, challenge: ch, clientId: membership.client_id }),
    challengeStandings(db, { scope, challenge: ch }),
  ]);
  const names = await resolveMembers(db, standings.map((s) => s.clientId));
  const named = standings.map((s) => ({ ...s, name: names.get(s.clientId)?.name || 'Member' }));
  const top = named.slice(0, 10);
  const you = named.find((s) => s.clientId === membership.client_id) || null;
  return {
    challenge: {
      ...progress,
      status: ch.start_date > today ? 'upcoming' : ch.end_date < today ? 'ended' : 'active',
    },
    standings: top,
    you: you && !top.some((s) => s.clientId === you.clientId) ? you : null,
    participants: named.length,
  };
}

export async function createGroupChallenge(db, { community, membership, input, tz }) {
  requireCan(membership, 'manageChallenges', 'Only owners and admins can create challenges');
  const name = cleanText(input.name, { field: 'Challenge name', min: 2, max: 60 });
  const description = cleanText(input.description, { field: 'Description', min: 0, max: 200, optional: true });
  if (!CHALLENGE_METRICS.includes(input.metric)) fail(422, 'bad_metric', 'Choose what the challenge measures');
  const scope = input.scope === 'community' ? 'community' : 'member';

  const goal = Number(input.goal);
  const maxGoal = input.metric === 'volume' ? 10_000_000 : 10_000;
  if (!Number.isFinite(goal) || goal <= 0 || goal > maxGoal) fail(422, 'bad_goal', 'Set a goal greater than zero');
  // Counts are whole numbers. "Complete 4.5 workouts" is not a real goal.
  if (input.metric !== 'volume' && !Number.isInteger(goal)) fail(422, 'bad_goal', 'This goal must be a whole number');

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const { start_date: start, end_date: end } = input;
  if (!dateRe.test(String(start)) || !dateRe.test(String(end))) fail(422, 'bad_dates', 'Choose a start and end date');
  const today = todayKey(tz);
  if (start < today) fail(422, 'bad_dates', 'A challenge cannot start in the past');
  if (start > addDays(today, MAX_LEAD_DAYS, tz)) fail(422, 'bad_dates', `Start within the next ${MAX_LEAD_DAYS} days`);
  if (end < start) fail(422, 'bad_dates', 'The challenge cannot end before it starts');
  const days = Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_CHALLENGE_DAYS) fail(422, 'bad_dates', `A challenge can run for up to ${MAX_CHALLENGE_DAYS} days`);

  const challengeId = id('cgch');
  await db.run(
    `INSERT INTO community_group_challenges
       (id, community_id, name, description, metric, goal, scope, start_date, end_date, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [challengeId, community.id, name, description, input.metric, goal, scope, start, end, membership.client_id, now()]);

  // One notification per member for a new challenge -- a real event in the
  // group's life, and the only fan-out this feature does. Muted members and
  // the creator are skipped.
  await notifyMembers(db, community.id, { excludeClientId: membership.client_id }, {
    type: 'community_challenge',
    title: `New challenge in ${community.name}`,
    body: name,
    data: { link: `/app/client/community/c/${community.id}`, communityId: community.id, challengeId },
  });
  return { id: challengeId };
}

export async function deleteGroupChallenge(db, { community, membership, challengeId }) {
  requireCan(membership, 'manageChallenges', 'Only owners and admins can remove challenges');
  const res = await db.run(
    'DELETE FROM community_group_challenges WHERE id = ? AND community_id = ?', [challengeId, community.id]);
  if (res.changes !== 1) fail(404, 'challenge_not_found', 'Challenge not found');
  return { deleted: true };
}
