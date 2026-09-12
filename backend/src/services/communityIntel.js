// ============================================================
// COMMUNITY INTELLIGENCE — the aggregate view of a gym.
//
// Community answers a different question from Progress. Progress is
// "how am I doing"; Community is "what is happening around me, where do
// I stand, and who am I training with". This file computes the SECOND
// one, and only that one.
//
// THREE RULES THIS FILE EXISTS TO KEEP
//
// 1. NO SECOND SOURCE OF TRUTH. Workout counts come from `workouts`,
//    volume from `exercise_set_logs`, PRs from `personal_records`,
//    streaks from community.js's own computeStreaks. Nothing here
//    recomputes a number another part of the product already owns, and
//    nothing here caches one.
//
// 2. MEMBERS ONLY. Every query joins community_members with enabled = 1.
//    A client who never opted in, or who opted out, contributes to no
//    count, appears in no list, and is not discoverable. Opting out is
//    therefore a real privacy control, not a UI preference -- so these
//    aggregates deliberately describe "the community", never "the gym".
//
// 3. NO FABRICATION. Every figure returned here is computed from rows
//    that exist. Where there is nothing to report the caller gets a zero
//    or an empty array and is expected to render an honest empty state.
//    There is no sample data, no seeded activity, and no placeholder
//    member anywhere in this file.
//
// A NOTE ON COUNTING PRs. personal_records is UNIQUE(client, exercise,
// type) -- it stores the CURRENT best, not an event log, and a new best
// overwrites the old row. So "PRs this week" counts records whose `date`
// falls in the week, which UNDERCOUNTS anyone who beat the same lift
// twice in one week (only the latest row survives to be counted). That
// is the honest reading of the data we actually store; the alternative
// would be inventing a PR history table and backfilling it, which would
// be fabricating events that were never recorded.
// ============================================================
import { dayKey, todayKey } from '../utils/time.js';
import { now } from '../ids.js';
import { periodRange, getCommunitySettings } from './community.js';
import { toScope } from './communityScope.js';

/** Postgres returns COUNT/SUM as a STRING (bigint), SQLite as a number.
 *  Every aggregate read in this file goes through here -- a raw `+` on
 *  those strings concatenates instead of adding, which is invisible in
 *  SQLite tests and wrong in production. */
const int = (v) => {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const num = (v) => {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Shift a YYYY-MM-DD key by whole days, staying in the same calendar
 *  space the rest of the app uses (noon UTC avoids DST edges). */
function shiftDay(key, days, tz) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return dayKey(d, tz);
}

/** The previous period of the same length, for "vs last week" style
 *  comparisons. Returned as the same {start,end} shape. */
export function previousRange({ start, end }, tz) {
  const len = Math.round(
    (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000) + 1;
  return { start: shiftDay(start, -len, tz), end: shiftDay(end, -len, tz) };
}

// ---- how many people opted in ----

/** Scope-aware: a bare orgId is that org's gym community; a friend scope
 *  counts active members who share their stats (see communityScope.js). */
export async function memberCount(db, scopeOrOrgId) {
  const scope = toScope(scopeOrOrgId);
  // Driven from clients so the join shape is identical for both scopes;
  // strict keeps the gym's long-standing "client's current org must match".
  const m = scope.member('cm', 'cl.id', { strict: true });
  const r = await db.q1(`SELECT COUNT(*) AS n FROM clients cl ${m.sql}`, m.params);
  return int(r?.n);
}

// ---- COMMUNITY PULSE ----

/**
 * The headline numbers. Each one is a separate, independently true
 * statement -- they are deliberately NOT combined into a single opaque
 * "community score" (see the fairness rule: a member must be able to see
 * why a number is what it is).
 */
export async function communityPulse(db, scopeOrOrgId, tz) {
  const scope = toScope(scopeOrOrgId);
  const today = todayKey(tz);
  const week = periodRange('week', tz);
  const mw = scope.member('cm', 'w.client_id');
  const mp = scope.member('cm', 'pr.client_id');

  const [members, activeToday, weekWorkouts, weekPRs, activeThisWeek] = await Promise.all([
    memberCount(db, scope),
    db.q1(
      `SELECT COUNT(DISTINCT w.client_id) AS n
         FROM workouts w
         ${mw.sql}
        WHERE w.scheduled_date = ? AND w.status = 'completed'`,
      [...mw.params, today]),
    db.q1(
      `SELECT COUNT(*) AS n
         FROM workouts w
         ${mw.sql}
        WHERE w.scheduled_date >= ? AND w.scheduled_date <= ?
          AND w.status = 'completed'`,
      [...mw.params, week.start, week.end]),
    db.q1(
      `SELECT COUNT(*) AS n
         FROM personal_records pr
         ${mp.sql}
        WHERE pr.date >= ? AND pr.date <= ?`,
      [...mp.params, week.start, week.end]),
    db.q1(
      `SELECT COUNT(DISTINCT w.client_id) AS n
         FROM workouts w
         ${mw.sql}
        WHERE w.scheduled_date >= ? AND w.scheduled_date <= ?
          AND w.status = 'completed'`,
      [...mw.params, week.start, week.end]),
  ]);

  const active = int(activeThisWeek?.n);
  return {
    members,
    activeToday: int(activeToday?.n),
    workoutsThisWeek: int(weekWorkouts?.n),
    prsThisWeek: int(weekPRs?.n),
    activeThisWeek: active,
    // Share of members who trained at all this week. Null rather than 0
    // when nobody has joined: "0% participation" reads as a failing gym,
    // when the truth is there is nothing to measure yet.
    participation: members > 0 ? Math.round((active / members) * 100) : null,
    week,
  };
}

// ---- ACTIVITY OVER TIME ----

/**
 * Completed workouts per day across the community, oldest first, with
 * every day present (a day nobody trained is a real 0, not a gap). Feeds
 * both the trend chart and the heatmap -- one query, not two.
 */
export async function activitySeries(db, scopeOrOrgId, tz, days = 28) {
  const scope = toScope(scopeOrOrgId);
  const today = todayKey(tz);
  const start = shiftDay(today, -(days - 1), tz);
  const mw = scope.member('cm', 'w.client_id');
  const mp = scope.member('cm', 'pr.client_id');

  const rows = await db.q(
    `SELECT w.scheduled_date AS d,
            COUNT(*) AS workouts,
            COUNT(DISTINCT w.client_id) AS members
       FROM workouts w
       ${mw.sql}
      WHERE w.scheduled_date >= ? AND w.scheduled_date <= ?
        AND w.status = 'completed'
      GROUP BY w.scheduled_date`,
    [...mw.params, start, today]);

  const prRows = await db.q(
    `SELECT pr.date AS d, COUNT(*) AS prs
       FROM personal_records pr
       ${mp.sql}
      WHERE pr.date >= ? AND pr.date <= ?
      GROUP BY pr.date`,
    [...mp.params, start, today]);

  const byDay = new Map(rows.map((r) => [r.d, r]));
  const prByDay = new Map(prRows.map((r) => [r.d, int(r.prs)]));

  const series = [];
  for (let i = 0; i < days; i += 1) {
    const d = shiftDay(start, i, tz);
    const hit = byDay.get(d);
    series.push({
      date: d,
      workouts: int(hit?.workouts),
      members: int(hit?.members),
      prs: prByDay.get(d) || 0,
    });
  }
  return series;
}

/**
 * Which weekday the community actually trains on, from the same series.
 * Returned only when there is enough spread to mean anything -- naming a
 * "most active day" off three workouts is noise presented as insight.
 */
export function busiestWeekday(series) {
  const total = series.reduce((s, d) => s + d.workouts, 0);
  if (total < 10) return null;
  const byDow = new Map();
  for (const d of series) {
    const dow = new Date(`${d.date}T12:00:00Z`).getUTCDay();
    byDow.set(dow, (byDow.get(dow) || 0) + d.workouts);
  }
  let best = null;
  for (const [dow, n] of byDow) if (!best || n > best.workouts) best = { dow, workouts: n };
  // A "peak" that is not actually a peak is not worth saying.
  const avg = total / byDow.size;
  if (!best || best.workouts < avg * 1.25) return null;
  return best;
}

// ---- WHERE THE MEMBER STANDS ----

/**
 * One member's own numbers and rank, plus the same figures for the
 * previous period so movement can be shown when -- and only when -- there
 * is a previous period to compare against.
 *
 * Rank is computed over the SAME member set the leaderboard uses, so the
 * "#8 of 128" a member sees here always agrees with the list below it.
 */
export async function memberPosition(db, scopeOrOrgId, clientId, period, tz) {
  const scope = toScope(scopeOrOrgId);
  const range = periodRange(period, tz);
  const prev = previousRange(range, tz);

  const countsFor = async ({ start, end }) => {
    const m = scope.member('cm', 'w.client_id');
    const rows = await db.q(
      `SELECT w.client_id, COUNT(*) AS n
         FROM workouts w
         ${m.sql}
        WHERE w.scheduled_date >= ? AND w.scheduled_date <= ?
          AND w.status = 'completed'
        GROUP BY w.client_id`,
      [...m.params, start, end]);
    return rows.map((r) => ({ clientId: r.client_id, n: int(r.n) }));
  };

  const rankIn = (rows, cid) => {
    // MUST match the ordering community.js's computeCompleted uses for the
    // board this number sits above: value descending, client id as the
    // tiebreaker, position = index + 1.
    //
    // Shared ranks would be the fairer convention in isolation, but the
    // board assigns every member a distinct rank (community.test.js
    // asserts it), and two different rank conventions on one screen means
    // a member tied on 32 workouts reads "#2 of 26" directly above their
    // own row sitting at #4. One rule, computed once, or the page
    // contradicts itself.
    const sorted = [...rows].sort((a, b) => b.n - a.n || a.clientId.localeCompare(b.clientId));
    const idx = sorted.findIndex((r) => r.clientId === cid);
    return idx === -1 ? null : idx + 1;
  };

  const [thisRows, prevRows, volumeRow, prRow, members] = await Promise.all([
    countsFor(range),
    countsFor(prev),
    db.q1(
      `SELECT COALESCE(SUM(CASE WHEN esl.actual_reps > 0 AND esl.actual_weight >= 0
                                THEN esl.actual_reps * esl.actual_weight ELSE 0 END), 0) AS volume
         FROM exercise_set_logs esl
         JOIN workout_logs wl ON wl.id = esl.workout_log_id
        WHERE wl.client_id = ? AND wl.date >= ? AND wl.date <= ? AND esl.completed = 1`,
      [clientId, range.start, range.end]),
    db.q1(
      `SELECT COUNT(*) AS n FROM personal_records
        WHERE client_id = ? AND date >= ? AND date <= ?`,
      [clientId, range.start, range.end]),
    memberCount(db, scope),
  ]);

  const mine = thisRows.find((r) => r.clientId === clientId);
  const rank = rankIn(thisRows, clientId);
  const prevRank = rankIn(prevRows, clientId);
  const prevMine = prevRows.find((r) => r.clientId === clientId);

  return {
    period: { type: period, ...range },
    rank,
    // Only a real comparison, never a fabricated "up 0". A member with no
    // previous period simply has no movement to show.
    rankDelta: rank != null && prevRank != null ? prevRank - rank : null,
    members,
    workouts: mine?.n || 0,
    previousWorkouts: prevMine?.n ?? null,
    volume: Math.round(num(volumeRow?.volume)),
    prs: int(prRow?.n),
  };
}

/**
 * The member's own last N weeks -- the "you vs you" view that keeps
 * Community from being only about other people. Pure personal data, so
 * it needs no membership join.
 */
export async function memberTrend(db, clientId, tz, weeks = 4) {
  const thisWeek = periodRange('week', tz);
  const out = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = shiftDay(thisWeek.start, -7 * i, tz);
    const end = shiftDay(start, 6, tz);
    /* eslint-disable no-await-in-loop */
    const [w, p] = await Promise.all([
      db.q1(
        `SELECT COUNT(*) AS n FROM workouts
          WHERE client_id = ? AND scheduled_date >= ? AND scheduled_date <= ? AND status = 'completed'`,
        [clientId, start, end]),
      db.q1(
        `SELECT COUNT(*) AS n FROM personal_records
          WHERE client_id = ? AND date >= ? AND date <= ?`,
        [clientId, start, end]),
    ]);
    /* eslint-enable no-await-in-loop */
    out.push({ start, end, workouts: int(w?.n), prs: int(p?.n) });
  }
  return out;
}

// ---- PR EVENTS ----

/**
 * Recent personal records across the community, newest first, already
 * joined to exercise and member names.
 *
 * These come from the canonical PR engine's own table. Nothing here
 * decides what counts as a PR -- services/personalRecords.js owns that,
 * and a second opinion on it is exactly the duplicate-business-logic
 * failure this design forbids.
 */
export async function recentPRs(db, orgId, { limit = 20, since = null, viewerClientId = null, scope = 'all' } = {}) {
  const params = [orgId];
  let dateFilter = '';
  if (since) { dateFilter = 'AND pr.date >= ?'; params.push(since); }

  // Over-fetch rows, because the grouping below collapses many rows into
  // far fewer cards: `limit` is a number of CARDS, and asking the database
  // for `limit` rows would return a couple of sessions' worth. Capped so a
  // pathological day cannot pull an unbounded result set.
  const rowBudget = Math.min(limit * 12, 400);
  params.push(rowBudget);

  const rows = await db.q(
    `SELECT pr.id, pr.client_id, pr.type, pr.value, pr.weight, pr.reps, pr.date, pr.created_at,
            el.name AS exercise_name, u.name AS member_name,
            cm.pr_visibility AS visibility
       FROM personal_records pr
       JOIN community_members cm ON cm.client_id = pr.client_id AND cm.enabled = 1
       JOIN clients c ON c.id = pr.client_id
       JOIN users u ON u.id = c.user_id
       JOIN exercise_library el ON el.id = pr.exercise_id
      WHERE cm.org_id = ? ${dateFilter}
      ORDER BY pr.date DESC, pr.created_at DESC, pr.id DESC
      LIMIT ?`,
    params);

  // Who the viewer follows -- needed both for 'followers' visibility and
  // for a 'following' scope. One query, not one per row.
  let following = new Set();
  if (viewerClientId) {
    const f = await db.q(
      'SELECT following_id FROM community_follows WHERE follower_id = ?', [viewerClientId]);
    following = new Set(f.map((r) => r.following_id));
  }

  const canSee = (r) => {
    if (viewerClientId && r.client_id === viewerClientId) return true; // always your own
    const v = r.visibility || 'everyone';
    if (v === 'nobody') return false;
    if (v === 'followers') return following.has(r.client_id);
    return true;
  };
  const inScope = (r) => {
    if (scope !== 'following') return true;
    if (!viewerClientId) return true;
    return r.client_id === viewerClientId || following.has(r.client_id);
  };

  const visible = rows.filter((r) => canSee(r) && inScope(r));

  /* ---- GROUPING ----
     This is the fix for the real complaint. personal_records stores FOUR
     record TYPES per exercise (heaviest weight, most reps, estimated 1RM,
     best volume), so a single good set on a single exercise writes up to
     four rows -- and the feed rendered each as its own card. One person's
     leg session produced eight cards; a 200-member gym would produce
     roughly 1,600 in a day, which is not a feed, it is a wall.

     One card per PERSON PER DAY, with the records nested inside it. That
     is also how a human would say it out loud: "Sambhav set four records
     today", not four separate announcements. */
  const byDay = new Map();
  for (const r of visible) {
    const key = `${r.client_id}:${r.date}`;
    if (!byDay.has(key)) {
      byDay.set(key, {
        id: `prg_${r.client_id}_${r.date}`,
        clientId: r.client_id,
        memberName: r.member_name,
        date: r.date,
        createdAt: r.created_at,
        records: [],
      });
    }
    const g = byDay.get(key);
    // The newest row in the group is the group's timestamp, so a session
    // finished at 9pm does not sort by whichever record happened to be
    // written first.
    if (r.created_at && r.created_at > g.createdAt) g.createdAt = r.created_at;
    g.records.push({
      id: r.id,
      exercise: r.exercise_name,
      type: r.type,
      value: num(r.value),
      weight: r.weight == null ? null : num(r.weight),
      reps: r.reps == null ? null : num(r.reps),
    });
  }

  const groups = [...byDay.values()].sort((a, b) => {
    const d = String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date));
    return d !== 0 ? d : String(b.id).localeCompare(String(a.id));
  });

  return groups.slice(0, limit).map((g) => ({
    ...g,
    // Distinct exercises reads better than "8 records" when four of those
    // records are the same lift measured four ways.
    exerciseCount: new Set(g.records.map((r) => r.exercise)).size,
    recordCount: g.records.length,
  }));
}

// ---- FOLLOWS ----

/** Follow is idempotent: the pair is the primary key, so a double tap
 *  cannot inflate a follower count. Self-follows are rejected outright --
 *  they would make "people you follow" include you twice, since your own
 *  activity is always included regardless. */
export async function followMember(db, { orgId, followerId, followingId }) {
  if (followerId === followingId) return { ok: false, reason: 'self' };
  const target = await db.q1(
    `SELECT cm.client_id FROM community_members cm
      WHERE cm.client_id = ? AND cm.org_id = ? AND cm.enabled = 1`,
    [followingId, orgId]);
  // Following someone who is not a member of this community would create
  // an edge that survives them never joining -- and leaks that the id is
  // real. Refused the same way an unknown id is.
  if (!target) return { ok: false, reason: 'not_found' };
  try {
    await db.run(
      `INSERT INTO community_follows (follower_id, following_id, org_id, created_at)
       VALUES (?,?,?,?)`,
      [followerId, followingId, orgId, now()]);
  } catch {
    /* already following -- the PK did its job */
  }
  return { ok: true, following: true };
}

export async function unfollowMember(db, { followerId, followingId }) {
  await db.run(
    'DELETE FROM community_follows WHERE follower_id = ? AND following_id = ?',
    [followerId, followingId]);
  return { ok: true, following: false };
}

/** Everyone this client follows, plus counts for both directions. */
export async function followState(db, { orgId, clientId }) {
  const [following, followers] = await Promise.all([
    db.q(`SELECT cf.following_id FROM community_follows cf
            JOIN community_members cm ON cm.client_id = cf.following_id AND cm.enabled = 1
           WHERE cf.follower_id = ? AND cf.org_id = ?`, [clientId, orgId]),
    db.q1(`SELECT COUNT(*) AS n FROM community_follows cf
             JOIN community_members cm ON cm.client_id = cf.follower_id AND cm.enabled = 1
            WHERE cf.following_id = ? AND cf.org_id = ?`, [clientId, orgId]),
  ]);
  return {
    following: following.map((r) => r.following_id),
    followingCount: following.length,
    followerCount: int(followers?.n),
  };
}

/** The viewer's own community preferences, with defaults for a row that
 *  predates these columns. */
export async function getPreferences(db, clientId) {
  const r = await db.q1(
    'SELECT pr_visibility, feed_scope FROM community_members WHERE client_id = ?', [clientId]);
  return {
    prVisibility: r?.pr_visibility || 'everyone',
    feedScope: r?.feed_scope || 'all',
  };
}

export async function setPreferences(db, clientId, { prVisibility, feedScope }) {
  const sets = []; const params = [];
  if (prVisibility) { sets.push('pr_visibility = ?'); params.push(prVisibility); }
  if (feedScope) { sets.push('feed_scope = ?'); params.push(feedScope); }
  if (!sets.length) return getPreferences(db, clientId);
  sets.push('updated_at = ?'); params.push(now());
  params.push(clientId);
  await db.run(`UPDATE community_members SET ${sets.join(', ')} WHERE client_id = ?`, params);
  return getPreferences(db, clientId);
}

// ---- WEEKLY RECAP ----

/**
 * What the week actually looked like, plus recognition across SEVERAL
 * dimensions rather than one.
 *
 * "Most improved" is here on purpose. A leaderboard that only ranks total
 * output always crowns the same person, and everyone else learns the
 * board is not about them. Improvement is the one category a returning
 * member can genuinely win, so it is computed against each member's own
 * previous week rather than against the top of the gym.
 */
export async function weeklyRecap(db, scopeOrOrgId, tz) {
  const scope = toScope(scopeOrOrgId);
  const week = periodRange('week', tz);
  const prev = previousRange(week, tz);

  const perMember = async ({ start, end }) => {
    const m = scope.member('cm', 'w.client_id');
    const rows = await db.q(
      `SELECT w.client_id, COUNT(*) AS n
         FROM workouts w
         ${m.sql}
        WHERE w.scheduled_date >= ? AND w.scheduled_date <= ?
          AND w.status = 'completed'
        GROUP BY w.client_id`,
      [...m.params, start, end]);
    return new Map(rows.map((r) => [r.client_id, int(r.n)]));
  };

  const [thisWeek, lastWeek, pulse] = await Promise.all([
    perMember(week), perMember(prev), communityPulse(db, scope, tz),
  ]);

  // Improvement is only meaningful for someone who was already here last
  // week. Counting a brand-new member's first 3 workouts as "+3 improved"
  // would hand the category to whoever joined most recently, every week.
  const improvements = [];
  for (const [clientId, n] of thisWeek) {
    if (!lastWeek.has(clientId)) continue;
    const delta = n - lastWeek.get(clientId);
    if (delta > 0) improvements.push({ clientId, delta, workouts: n });
  }
  improvements.sort((a, b) => b.delta - a.delta || b.workouts - a.workouts);

  const ids = improvements.slice(0, 3).map((i) => i.clientId);
  let names = new Map();
  if (ids.length) {
    const rows = await db.q(
      `SELECT c.id AS client_id, u.name FROM clients c JOIN users u ON u.id = c.user_id
        WHERE c.id IN (${ids.map(() => '?').join(',')})`, ids);
    names = new Map(rows.map((r) => [r.client_id, r.name]));
  }

  return {
    week,
    workouts: pulse.workoutsThisWeek,
    prs: pulse.prsThisWeek,
    activeMembers: pulse.activeThisWeek,
    participation: pulse.participation,
    mostImproved: improvements.slice(0, 3).map((i) => ({
      clientId: i.clientId,
      name: names.get(i.clientId) || 'Member',
      delta: i.delta,
      workouts: i.workouts,
    })),
  };
}

// ---- MEMBER DIRECTORY ----

/**
 * Who is in the community, with the handful of public figures a member
 * card shows. Deliberately narrow: workouts, streak-eligible activity and
 * PR count are community facts, whereas body weight, nutrition, sleep and
 * recovery are health data and never appear here regardless of what the
 * caller asks for.
 */
export async function memberDirectory(db, orgId, tz, { limit = 100, search = null } = {}) {
  const month = periodRange('month', tz);
  // Bound placeholders in the exact order they appear in the SQL below --
  // the correlated subqueries each take their own date pair, so an array
  // assembled in any other order silently ranks members by the wrong
  // window rather than failing.
  const params = [
    month.start, month.end,   // workouts subquery
    month.start, month.end,   // prs subquery
    orgId, orgId,             // cm.org_id, c.org_id
  ];
  let searchFilter = '';
  if (search) {
    searchFilter = 'AND LOWER(u.name) LIKE ?';
    params.push(`%${String(search).toLowerCase()}%`);
  }
  params.push(limit);

  const rows = await db.q(
    `SELECT c.id AS client_id, u.name, u.avatar, cm.updated_at AS joined_at,
            (SELECT COUNT(*) FROM workouts w
               WHERE w.client_id = c.id AND w.status = 'completed'
                 AND w.scheduled_date >= ? AND w.scheduled_date <= ?) AS workouts,
            (SELECT COUNT(*) FROM personal_records pr
               WHERE pr.client_id = c.id AND pr.date >= ? AND pr.date <= ?) AS prs,
            (SELECT MAX(w2.scheduled_date) FROM workouts w2
               WHERE w2.client_id = c.id AND w2.status = 'completed') AS last_active
       FROM community_members cm
       JOIN clients c ON c.id = cm.client_id
       JOIN users u ON u.id = c.user_id
      WHERE cm.org_id = ? AND cm.enabled = 1 AND c.org_id = ? ${searchFilter}
      ORDER BY workouts DESC, u.name ASC
      LIMIT ?`,
    params);

  return rows.map((r) => ({
    clientId: r.client_id,
    name: r.name || 'Member',
    avatar: r.avatar || null,
    workoutsThisMonth: int(r.workouts),
    prsThisMonth: int(r.prs),
    lastActive: r.last_active || null,
    joinedAt: r.joined_at || null,
  }));
}

// ---- THE WHOLE OVERVIEW, IN ONE ROUND TRIP ----

/**
 * Community's home screen needs pulse + position + trend + PRs + recap
 * together. Fetching them as six requests would make the page's first
 * paint depend on the slowest of six round trips and would let the
 * sections disagree with each other (a pulse computed at 23:59:59 beside
 * a position computed at 00:00:01). One call, one consistent snapshot.
 */
export async function communityOverview(db, { orgId, clientId, period = 'week', tz }) {
  const settings = await getCommunitySettings(db, orgId);
  if (!settings.community_enabled) {
    return { settings, available: false };
  }

  // The viewer's saved feed scope decides whose records reach them, so
  // the overview and the Activity tab agree without the client having to
  // pass the preference back on every request.
  const prefs = clientId ? await getPreferences(db, clientId) : { feedScope: 'all' };

  const [pulse, series, prs, recap, position, trend] = await Promise.all([
    communityPulse(db, orgId, tz),
    activitySeries(db, orgId, tz, 28),
    recentPRs(db, orgId, { limit: 10, viewerClientId: clientId, scope: prefs.feedScope }),
    weeklyRecap(db, orgId, tz),
    clientId ? memberPosition(db, orgId, clientId, period, tz) : null,
    clientId ? memberTrend(db, clientId, tz, 4) : null,
  ]);

  return {
    settings,
    available: true,
    preferences: prefs,
    pulse,
    activity: series,
    busiestWeekday: busiestWeekday(series),
    recentPRs: prs,
    recap,
    position,
    trend,
  };
}
