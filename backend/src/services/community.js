// ============================================================
// GYM COMMUNITY SERVICE — leaderboards, workout sharing, membership
// All queries are org-scoped. Privacy is enforced server-side.
// ============================================================
import { id, now } from '../ids.js';
import { dayKey, todayKey } from '../utils/time.js';
import { track } from './events.js';
import { isFeatureEnabled } from './platform/featureFlags.js';

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

async function computeStreaks(db, orgId, tz) {
  const today = todayKey(tz);
  // Look back 365 days — enough for any realistic streak
  const lookback = new Date(today + 'T12:00:00Z');
  lookback.setUTCDate(lookback.getUTCDate() - 365);
  const since = dayKey(lookback, tz);

  // Fetch all completed workout dates for community members in this org
  const rows = await db.q(
    `SELECT cm.client_id, w.scheduled_date AS d
       FROM community_members cm
       JOIN clients c ON c.id = cm.client_id
       JOIN workouts w ON w.client_id = c.id
     WHERE cm.org_id = ? AND cm.enabled = 1
       AND w.status = 'completed' AND w.scheduled_date >= ?
     ORDER BY cm.client_id, w.scheduled_date DESC`,
    [orgId, since]);

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

  return results.slice(0, 50).map((r, i) => ({
    rank: i + 1,
    clientId: r.client_id,
    value: r.streak,
  }));
}

// ---- Volume computation ----
// Volume = SUM(actual_reps * actual_weight) over completed exercise_set_logs

async function computeVolume(db, orgId, start, end) {
  const rows = await db.q(
    `SELECT wl.client_id,
            COALESCE(SUM(CASE WHEN esl.actual_reps > 0 AND esl.actual_weight >= 0
                              THEN esl.actual_reps * esl.actual_weight ELSE 0 END), 0) AS volume
       FROM exercise_set_logs esl
       JOIN workout_logs wl ON wl.id = esl.workout_log_id
       JOIN clients c ON c.id = wl.client_id
       JOIN community_members cm ON cm.client_id = c.id AND cm.enabled = 1 AND cm.org_id = c.org_id
     WHERE c.org_id = ? AND wl.date >= ? AND wl.date <= ? AND esl.completed = 1
     GROUP BY wl.client_id`,
    [orgId, start, end]);

  rows.sort((a, b) =>
    b.volume - a.volume ||
    a.client_id.localeCompare(b.client_id)
  );

  return rows.slice(0, 50).map((r, i) => ({
    rank: i + 1,
    clientId: r.client_id,
    value: Math.round(r.volume),
  }));
}

// ---- Completed workouts computation ----

async function computeCompleted(db, orgId, start, end) {
  const rows = await db.q(
    `SELECT w.client_id, COUNT(*) AS n
       FROM workouts w
       JOIN clients c ON c.id = w.client_id
       JOIN community_members cm ON cm.client_id = w.client_id AND cm.enabled = 1 AND cm.org_id = c.org_id
     WHERE c.org_id = ? AND w.scheduled_date >= ? AND w.scheduled_date <= ? AND w.status = 'completed'
     GROUP BY w.client_id`,
    [orgId, start, end]);

  rows.sort((a, b) =>
    b.n - a.n ||
    a.client_id.localeCompare(b.client_id)
  );

  return rows.slice(0, 50).map((r, i) => ({
    rank: i + 1,
    clientId: r.client_id,
    value: r.n,
  }));
}

// ---- Full leaderboards ----

export async function leaderboards(db, orgId, period, tz) {
  const { start, end } = periodRange(period, tz);
  const settings = await getCommunitySettings(db, orgId);

  if (!settings.community_enabled || !settings.leaderboard_enabled) {
    return { settings, period: { type: period, start, end }, leaderboards: { streak: [], volume: [], completedWorkouts: [] } };
  }

  const [streakBoard, volumeBoard, completedBoard] = await Promise.all([
    computeStreaks(db, orgId, tz),
    computeVolume(db, orgId, start, end),
    computeCompleted(db, orgId, start, end),
  ]);

  return {
    settings,
    period: { type: period, start, end },
    leaderboards: {
      streak: streakBoard,
      volume: volumeBoard,
      completedWorkouts: completedBoard,
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

export async function feed(db, orgId, { limit = 30, offset = 0 } = {}) {
  const settings = await getCommunitySettings(db, orgId);
  if (!settings.community_enabled) {
    return { settings, shares: [] };
  }

  const rows = await db.q(
    `SELECT cws.*, u.name AS author_name, u.avatar AS author_avatar
       FROM community_workout_shares cws
       JOIN clients c ON c.id = cws.client_id
       JOIN users u ON u.id = c.user_id
       JOIN community_members cm ON cm.client_id = cws.client_id AND cm.enabled = 1
     WHERE cws.org_id = ?
     ORDER BY cws.created_at DESC
     LIMIT ? OFFSET ?`,
    [orgId, limit, offset]);

  return {
    settings,
    shares: rows.map(r => ({
      id: r.id,
      clientId: r.client_id,
      authorName: r.author_name,
      authorAvatar: r.author_avatar,
      workoutId: r.workout_id,
      workoutName: r.workout_name,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at,
    })),
  };
}

// ---- Share a completed workout ----

export async function shareWorkout(db, { clientId, orgId, workoutId }) {
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
    `INSERT INTO community_workout_shares (id, org_id, client_id, workout_id, workout_name, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [shareId, orgId, clientId, workoutId, workout.name, payload, now()]);

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
    payload: JSON.parse(share.payload),
  };
}

// ---- Copy a shared workout into the copier's planner ----

export async function copyWorkout(db, { shareId, clientId, orgId, overrides = {} }) {
  const share = await getShare(db, orgId, shareId);
  if (!share) return null;

  const name = overrides.name || share.workout_name;
  const exercises = overrides.exercises || share.payload;

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
       `Copied from community share`, now()]);

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

  await track(db, { orgId, userId: null, type: 'workout_copied', data: { clientId, shareId, newWorkoutId: wId } });

  return { id: wId, name: String(name).trim().slice(0, 80), exerciseCount: valid.length };
}
