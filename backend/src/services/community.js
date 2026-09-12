// ============================================================
// GYM COMMUNITY SERVICE — leaderboards, workout sharing, membership
// All queries are org-scoped. Privacy is enforced server-side.
// ============================================================
import { id, now } from '../ids.js';
import { dayKey, todayKey } from '../utils/time.js';
import { track } from './events.js';
import { isFeatureEnabled } from './platform/featureFlags.js';
import { toScope, gymScope } from './communityScope.js';

// A share's payload is written by shareWorkout() as JSON.stringify(exercises),
// so it is well-formed for every row this codebase creates. It is still parsed
// defensively: a single malformed row (hand-edited, a partial write, a future
// migration) must not take down the WHOLE feed with a 500 -- the feed degrades
// to an empty exercise list for that one share instead.
function safePayload(raw) {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

// ---- Membership ----

export async function getMembership(db, clientId) {
  return db.q1('SELECT * FROM community_members WHERE client_id = ?', [clientId]);
}

export async function setMembership(db, clientId, orgId, enabled) {
  const ts = now();
  await db.run(
    `INSERT INTO community_members (client_id, org_id, enabled, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    [clientId, orgId, enabled ? 1 : 0, ts]);
  // When disabling community: remove all active workout shares
  if (!enabled) {
    await db.run('DELETE FROM community_workout_shares WHERE client_id = ?', [clientId]);
  }
}

// ---- Gym settings helpers ----

// Two independent layers, both must allow it: the PLATFORM's own
// 'community' rollout flag (SK OS deciding which gyms see the feature
// at all -- global off / percentage rollout / a specific-gym allow-
// list, via the Admin Console's Feature Flags page) AND the gym
// owner's own community_enabled toggle in gym_settings (their
// preference, once the platform has made it available to them at
// all). This is feature-flag adoption's first real call site --
// isFeatureEnabled() existed and was tested since Phase 3c but nothing
// actually called it until now. A 'community' flag row is seeded by
// init-db.js at enabled=100% so this introduces ZERO behavior change
// for any existing gym on deploy -- it only starts to matter the
// moment a platform operator actually dials the rollout down for some
// orgs, which is the entire point.
export async function getCommunitySettings(db, orgId) {
  const platformEnabled = await isFeatureEnabled(db, 'community', { orgId });
  if (!platformEnabled) return { community_enabled: false, leaderboard_enabled: false };
  const s = await db.q1(
    'SELECT community_enabled, community_leaderboard_enabled FROM gym_settings WHERE org_id = ?',
    [orgId]);
  return {
    community_enabled: s ? (s.community_enabled !== 0 && s.community_enabled !== false) : true,
    leaderboard_enabled: s ? (s.community_leaderboard_enabled !== 0 && s.community_leaderboard_enabled !== false) : true,
  };
}

// ---- Period helpers ----

export function periodRange(period, tz) {
  const today = todayKey(tz);
  if (period === 'day') {
    return { start: today, end: today };
  }
  if (period === 'week') {
    // Monday-start week
    const d = new Date(today + 'T12:00:00Z');
    const jsDow = d.getUTCDay(); // 0=Sun..6=Sat
    const mondayOffset = jsDow === 0 ? 6 : jsDow - 1;
    const start = new Date(d);
    start.setUTCDate(start.getUTCDate() - mondayOffset);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return {
      start: dayKey(start, tz),
      end: dayKey(end, tz),
    };
  }
  if (period === 'month') {
    const parts = today.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const start = `${today.slice(0, 7)}-01`;
    // Last day of month
    const endDt = new Date(Date.UTC(y, m, 0));
    const end = dayKey(endDt, tz);
    return { start, end };
  }
  // 'all' — use a very early start
  return { start: '1970-01-01', end: today };
}

// ---- Streak computation ----
// Current streak = consecutive days ending today or yesterday with completed workouts

//
// Every board below is scope-aware (see communityScope.js): a gym
// community and a friend community run the SAME query with a different
// membership join, so "12 day streak" or "18.4k kg" means one thing
// everywhere in the product. A bare orgId still means that org's gym
// community, which is what every pre-existing caller passes.

export async function computeStreaks(db, scopeOrOrgId, tz, { limit = 50 } = {}) {
  const scope = toScope(scopeOrOrgId);
  const today = todayKey(tz);
  // Look back 365 days — enough for any realistic streak
  const lookback = new Date(today + 'T12:00:00Z');
  lookback.setUTCDate(lookback.getUTCDate() - 365);
  const since = dayKey(lookback, tz);

  // Fetch the completed workout DATES for community members.
  //
  // DISTINCT is load-bearing, not cosmetic: a streak only cares whether a
  // member trained on a given day, and the grouping below drops the row into
  // a Set anyway -- so a member who logs three workouts on the same day was
  // costing three rows over the wire and three Set writes to produce one
  // date. On a large gym (1k members x ~150 completed workouts a year) that
  // is the difference between transferring every workout row in the org and
  // transferring one row per member per active day. Served by
  // idx_workouts_client_status_date (client_id, status, scheduled_date).
  const m = scope.member('cm', 'w.client_id');
  const rows = await db.q(
    `SELECT DISTINCT w.client_id, w.scheduled_date AS d
       FROM workouts w
       ${m.sql}
     WHERE w.status = 'completed' AND w.scheduled_date >= ?
     ORDER BY w.client_id, d DESC`,
    [...m.params, since]);

  // Group by client
  const byClient = new Map();
  for (const r of rows) {
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, new Set());
    byClient.get(r.client_id).add(r.d);
  }

  const results = [];
  for (const [clientId, dates] of byClient) {
    const sorted = [...dates].sort().reverse(); // newest first
    const dateSet = new Set(sorted); // O(1) lookups for streak walk
    // Streak ends today or yesterday
    let streak = 0;
    let currentDate = new Date(today + 'T12:00:00Z');
    let curKey = dayKey(currentDate, tz);

    if (!dateSet.has(curKey)) {
      // Check yesterday
      currentDate.setUTCDate(currentDate.getUTCDate() - 1);
      curKey = dayKey(currentDate, tz);
      if (!dateSet.has(curKey)) {
        streak = 0;
        results.push({ client_id: clientId, streak: 0, last_workout: sorted[0] || null });
        continue;
      }
    }

    // Count backwards from today/yesterday
    streak = 0;
    currentDate = new Date(today + 'T12:00:00Z');
    if (!dateSet.has(dayKey(currentDate, tz))) {
      currentDate.setUTCDate(currentDate.getUTCDate() - 1);
    }
    while (dateSet.has(dayKey(currentDate, tz))) {
      streak++;
      currentDate.setUTCDate(currentDate.getUTCDate() - 1);
    }

    results.push({ client_id: clientId, streak, last_workout: sorted[0] || null });
  }

  // Rank: streak desc, then last_workout desc (recent activity), then client_id asc
  results.sort((a, b) =>
    b.streak - a.streak ||
    (b.last_workout || '').localeCompare(a.last_workout || '') ||
    a.client_id.localeCompare(b.client_id)
  );

  return results.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    clientId: r.client_id,
    value: r.streak,
  }));
}

// ---- Volume computation ----
// Volume = SUM(actual_reps * actual_weight) over completed exercise_set_logs

export async function computeVolume(db, scopeOrOrgId, start, end, { limit = 50 } = {}) {
  const scope = toScope(scopeOrOrgId);
  // strict: this board always required the client's current org to match,
  // unlike the streak board above -- preserved, not unified.
  const m = scope.member('cm', 'wl.client_id', { strict: true });
  const rows = await db.q(
    `SELECT wl.client_id,
            COALESCE(SUM(CASE WHEN esl.actual_reps > 0 AND esl.actual_weight >= 0
                              THEN esl.actual_reps * esl.actual_weight ELSE 0 END), 0) AS volume
       FROM exercise_set_logs esl
       JOIN workout_logs wl ON wl.id = esl.workout_log_id
       ${m.sql}
     WHERE wl.date >= ? AND wl.date <= ? AND esl.completed = 1
     GROUP BY wl.client_id`,
    [...m.params, start, end]);

  rows.sort((a, b) =>
    b.volume - a.volume ||
    a.client_id.localeCompare(b.client_id)
  );

  return rows.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    clientId: r.client_id,
    value: Math.round(r.volume),
  }));
}

// ---- Completed workouts computation ----

export async function computeCompleted(db, scopeOrOrgId, start, end, { limit = 50 } = {}) {
  const scope = toScope(scopeOrOrgId);
  const m = scope.member('cm', 'w.client_id', { strict: true });
  const rows = await db.q(
    `SELECT w.client_id, COUNT(*) AS n
       FROM workouts w
       ${m.sql}
     WHERE w.scheduled_date >= ? AND w.scheduled_date <= ? AND w.status = 'completed'
     GROUP BY w.client_id`,
    [...m.params, start, end]);

  rows.sort((a, b) =>
    b.n - a.n ||
    a.client_id.localeCompare(b.client_id)
  );

  return rows.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    clientId: r.client_id,
    // Number(): PostgreSQL returns COUNT as a bigint string, and a "1"
    // would never equal 1 in the frontend's singular/plural check.
    value: Number(r.n),
  }));
}

// ---- Active days (consistency) ----
// Days with at least one completed workout. Distinct from the workout
// count on purpose: two sessions in one day is more work, not more
// consistency, and a board that rewards showing up should not be won by
// doubling up.

export async function computeActiveDays(db, scopeOrOrgId, start, end, { limit = 50 } = {}) {
  const scope = toScope(scopeOrOrgId);
  const m = scope.member('cm', 'w.client_id', { strict: true });
  const rows = await db.q(
    `SELECT w.client_id, COUNT(DISTINCT w.scheduled_date) AS n
       FROM workouts w
       ${m.sql}
     WHERE w.scheduled_date >= ? AND w.scheduled_date <= ? AND w.status = 'completed'
     GROUP BY w.client_id`,
    [...m.params, start, end]);

  rows.sort((a, b) => b.n - a.n || a.client_id.localeCompare(b.client_id));
  return rows.slice(0, limit).map((r, i) => ({ rank: i + 1, clientId: r.client_id, value: Number(r.n) }));
}

// ---- Personal records set in the period ----
// Counts rows from the canonical PR engine's own table (see the note on
// counting PRs at the top of communityIntel.js) -- nothing here decides
// what a record is.

export async function computePRCount(db, scopeOrOrgId, start, end, { limit = 50 } = {}) {
  const scope = toScope(scopeOrOrgId);
  const m = scope.member('cm', 'pr.client_id', { strict: true });
  const rows = await db.q(
    `SELECT pr.client_id, COUNT(*) AS n
       FROM personal_records pr
       ${m.sql}
     WHERE pr.date >= ? AND pr.date <= ?
     GROUP BY pr.client_id`,
    [...m.params, start, end]);

  rows.sort((a, b) => b.n - a.n || a.client_id.localeCompare(b.client_id));
  return rows.slice(0, limit).map((r, i) => ({ rank: i + 1, clientId: r.client_id, value: Number(r.n) }));
}

// ---- Boards, for any scope ----

const BOARD_COMPUTERS = {
  streak: (db, scope, range, tz, opts) => computeStreaks(db, scope, tz, opts),
  volume: (db, scope, range, tz, opts) => computeVolume(db, scope, range.start, range.end, opts),
  completedWorkouts: (db, scope, range, tz, opts) => computeCompleted(db, scope, range.start, range.end, opts),
  activeDays: (db, scope, range, tz, opts) => computeActiveDays(db, scope, range.start, range.end, opts),
  prs: (db, scope, range, tz, opts) => computePRCount(db, scope, range.start, range.end, opts),
};

export const BOARD_METRICS = Object.freeze(Object.keys(BOARD_COMPUTERS));

/**
 * The requested boards for one period, with no settings gate -- callers
 * that have one (the gym's own community toggles) apply it first. Each
 * metric is a separate, named ranking: there is deliberately no way to
 * ask this for a blended score.
 */
export async function computeBoards(db, scopeOrOrgId, period, tz, {
  metrics = ['streak', 'volume', 'completedWorkouts'], limit = 50,
} = {}) {
  const scope = toScope(scopeOrOrgId);
  const range = periodRange(period, tz);
  const names = metrics.filter((name) => BOARD_COMPUTERS[name]);
  const boards = await Promise.all(names.map((name) => BOARD_COMPUTERS[name](db, scope, range, tz, { limit })));
  return {
    period: { type: period, start: range.start, end: range.end },
    leaderboards: Object.fromEntries(names.map((name, i) => [name, boards[i]])),
  };
}

// ---- Full leaderboards (gym community) ----

export async function leaderboards(db, orgId, period, tz) {
  const { start, end } = periodRange(period, tz);
  const settings = await getCommunitySettings(db, orgId);

  if (!settings.community_enabled || !settings.leaderboard_enabled) {
    return { settings, period: { type: period, start, end }, leaderboards: { streak: [], volume: [], completedWorkouts: [] } };
  }

  const { leaderboards: boards } = await computeBoards(db, gymScope(orgId), period, tz, {
    metrics: ['streak', 'volume', 'completedWorkouts'],
  });

  return {
    settings,
    period: { type: period, start, end },
    leaderboards: {
      streak: boards.streak,
      volume: boards.volume,
      completedWorkouts: boards.completedWorkouts,
    },
  };
}

// ---- Resolve member names/avatars for boards ----

export async function resolveMembers(db, clientIds) {
  if (!clientIds.length) return new Map();
  const rows = await db.q(
    `SELECT c.id AS client_id, u.name, u.avatar
       FROM clients c JOIN users u ON u.id = c.user_id
     WHERE c.id IN (${clientIds.map(() => '?').join(',')})`,
    clientIds);
  return new Map(rows.map(r => [r.client_id, { name: r.name, avatar: r.avatar }]));
}

// ---- Feed ----

export async function feed(db, orgId, { limit = 30, offset = 0, viewerClientId = null, scope = 'all' } = {}) {
  const settings = await getCommunitySettings(db, orgId);
  if (!settings.community_enabled) {
    return { settings, shares: [], hasMore: false, limit, offset };
  }

  // Two things make this page correctly rather than approximately:
  //
  // 1. The tiebreaker. created_at is an ISO string written by now(), so two
  //    shares created in the same millisecond compare EQUAL. "ORDER BY
  //    created_at DESC" alone leaves their relative order up to the planner,
  //    which can differ between the page-1 and page-2 queries -- the classic
  //    offset-pagination failure where one row is returned twice and another
  //    is never returned at all. Adding id DESC makes the sort total, so a
  //    row has exactly one position across every page request.
  //    idx_cws_org_feed (org_id, created_at) still serves the filter+order;
  //    the id tiebreaker only ever sorts within an identical timestamp, so no
  //    additional index is warranted.
  //
  // 2. hasMore. Ask for one row MORE than the caller wants: if it comes back,
  //    another page exists. That avoids a second COUNT(*) query per page and
  //    can't disagree with the rows actually returned.
  /* Audience and scope are applied IN SQL, not after the fact, so a
     followers-only share never travels to someone who would merely hide
     it -- and so LIMIT/OFFSET still count the rows the viewer can
     actually see. Filtering a fetched page in JS would silently shorten
     pages and eventually skip rows entirely.

       visibility 'everyone'            -> anyone in the community
       visibility 'followers'           -> only people who follow the author
       author is the viewer             -> always visible
       scope 'following'                -> viewer's own extra narrowing

     COALESCE covers rows written before the column existed. */
  const following = scope === 'following';
  const rows = await db.q(
    `SELECT cws.*, u.name AS author_name, u.avatar AS author_avatar
       FROM community_workout_shares cws
       JOIN clients c ON c.id = cws.client_id
       JOIN users u ON u.id = c.user_id
       JOIN community_members cm ON cm.client_id = cws.client_id AND cm.enabled = 1
     WHERE cws.org_id = ?
       AND (
         COALESCE(cws.visibility, 'everyone') = 'everyone'
         OR cws.client_id = ?
         OR EXISTS (SELECT 1 FROM community_follows cf
                     WHERE cf.follower_id = ? AND cf.following_id = cws.client_id)
       )
       AND (
         ? = 0
         OR cws.client_id = ?
         OR EXISTS (SELECT 1 FROM community_follows cf2
                     WHERE cf2.follower_id = ? AND cf2.following_id = cws.client_id)
       )
     ORDER BY cws.created_at DESC, cws.id DESC
     LIMIT ? OFFSET ?`,
    [orgId, viewerClientId, viewerClientId,
     following ? 1 : 0, viewerClientId, viewerClientId,
     limit + 1, offset]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    settings,
    hasMore,
    limit,
    offset,
    shares: page.map(r => ({
      id: r.id,
      clientId: r.client_id,
      authorName: r.author_name,
      authorAvatar: r.author_avatar,
      workoutId: r.workout_id,
      workoutName: r.workout_name,
      payload: safePayload(r.payload),
      visibility: r.visibility || 'everyone',
      createdAt: r.created_at,
    })),
  };
}

// ---- Share a completed workout ----

export async function shareWorkout(db, { clientId, orgId, workoutId, visibility = 'everyone' }) {
  // Fetch workout + exercises
  const workout = await db.q1(
    'SELECT * FROM workouts WHERE id = ? AND client_id = ? AND status = ?',
    [workoutId, clientId, 'completed']);
  if (!workout) return null;

  const exercises = await db.q(
    'SELECT name, sets, reps, weight, rest_sec FROM workout_exercises WHERE workout_id = ? ORDER BY position',
    [workoutId]);

  const payload = JSON.stringify(exercises);

  // Remove existing share of same workout if any
  await db.run('DELETE FROM community_workout_shares WHERE client_id = ? AND workout_id = ?',
    [clientId, workoutId]);

  const shareId = id('cs');
  await db.run(
    `INSERT INTO community_workout_shares (id, org_id, client_id, workout_id, workout_name, payload, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [shareId, orgId, clientId, workoutId, workout.name, payload,
     visibility === 'followers' ? 'followers' : 'everyone', now()]);

  await track(db, { orgId, userId: null, type: 'workout_shared', data: { clientId, shareId, workoutId } });

  return { id: shareId, workoutName: workout.name, payload: exercises };
}

// ---- Unshare (delete) ----

export async function unshareWorkout(db, { clientId, shareId }) {
  const share = await db.q1(
    'SELECT * FROM community_workout_shares WHERE id = ? AND client_id = ?',
    [shareId, clientId]);
  if (!share) return false;
  await db.run('DELETE FROM community_workout_shares WHERE id = ?', [shareId]);
  return true;
}

// ---- Get share detail (for copy) ----

export async function getShare(db, orgId, shareId) {
  const share = await db.q1(
    'SELECT * FROM community_workout_shares WHERE id = ? AND org_id = ?',
    [shareId, orgId]);
  if (!share) return null;
  return {
    ...share,
    payload: safePayload(share.payload),
  };
}

// ---- Copy a shared workout into the copier's planner ----

export async function copyWorkout(db, { shareId, clientId, orgId, overrides = {} }) {
  const share = await getShare(db, orgId, shareId);
  if (!share) return null;

  const result = await copyExercisesToPlanner(db, {
    clientId,
    orgId,
    name: overrides.name || share.workout_name,
    exercises: overrides.exercises || share.payload,
  });
  if (!result) return null;

  await track(db, { orgId, userId: null, type: 'workout_copied', data: { clientId, shareId, newWorkoutId: result.id } });
  return result;
}

/**
 * Put a list of exercises into a client's own planner as a new workout.
 *
 * Extracted from copyWorkout so friend communities copy a shared session
 * through exactly the same path: the same library validation, the same
 * clamping of sets/reps/rest, the same single transaction. A second
 * implementation would eventually disagree about which exercises a client is
 * allowed to copy.
 */
export async function copyExercisesToPlanner(db, { clientId, orgId, name, exercises, note = 'Copied from community share' }) {
  // Validate exercises against library (global or same-org only)
  const exerciseIds = exercises.map(e => e.exercise_id).filter(Boolean);
  let validIds = new Set();
  if (exerciseIds.length) {
    const lib = await db.q(
      `SELECT id FROM exercise_library WHERE id IN (${exerciseIds.map(() => '?').join(',')})
        AND (is_global = 1 OR org_id = ?)`,
      [...exerciseIds, orgId]);
    validIds = new Set(lib.map(r => r.id));
  }

  // Filter to valid exercises
  const valid = exercises.filter(e => !e.exercise_id || validIds.has(e.exercise_id));
  if (!valid.length) return null;

  // Resolve client's org
  const client = await db.q1('SELECT org_id FROM clients WHERE id = ?', [clientId]);
  if (!client) return null;

  const wId = id('cw');
  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO client_workouts (id, org_id, client_id, name, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [wId, client.org_id, clientId, String(name).trim().slice(0, 80),
       note, now()]);

    for (let i = 0; i < valid.length; i++) {
      const ex = valid[i];
      const exId = ex.exercise_id || null;
      await tx.run(
        `INSERT INTO client_workout_exercises
           (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id('cwe'), wId, exId, i,
         String(ex.name || '').slice(0, 80),
         Math.max(1, Math.min(12, parseInt(ex.sets, 10) || 3)),
         String(ex.reps ?? 10).slice(0, 12),
         String(ex.weight ?? 'BW').slice(0, 12),
         Math.max(15, Math.min(600, parseInt(ex.rest_sec, 10) || 90)),
         ex.tempo ? String(ex.tempo).slice(0, 20) : null,
         ex.notes ? String(ex.notes).slice(0, 200) : null]);
    }
  });

  return { id: wId, name: String(name).trim().slice(0, 80), exerciseCount: valid.length };
}
