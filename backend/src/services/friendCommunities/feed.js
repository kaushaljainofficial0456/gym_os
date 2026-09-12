// ============================================================
// FRIEND COMMUNITIES — the feed: explicit shares, reactions, comments.
//
// NOTHING REACHES A FRIEND COMMUNITY BY ITSELF. A workout or a set of
// personal records appears only when its owner picks this community and
// presses Share. There is no auto-publish, no "share everywhere", and a
// share into one community says nothing to any other community or to the
// member's gym.
//
// THE SERVER BUILDS EVERY NUMBER. A share request carries a workout id and
// a choice (the session, its records, or both). Name, duration, sets,
// volume and every record value are read from the member's own rows --
// the same rows the PR engine and the boards read -- and frozen into the
// event, so a feed card can never show a figure the member did not
// actually log.
//
// HEALTH DATA IS NEVER SELECTED. Calories, body weight, sleep, recovery,
// heart rate and nutrition are not in any query in this file, so no
// payload can carry them regardless of what a client asks for.
// ============================================================
import { id, now } from '../../ids.js';
import { REACTIONS, isValidReaction } from '../communitySocial.js';
import { copyExercisesToPlanner } from '../community.js';
import {
  fail, int, can, insertEvent, gymLabel, gymStatus, notifyMember, clientName, cleanText,
} from './core.js';

export const FEED_FILTERS = Object.freeze({
  all: null,
  workouts: ['workout'],
  prs: ['pr'],
  members: ['created', 'joined'],
});

export const FEED_PAGE_MAX = 30;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const maybeNum = (v) => (v == null ? null : num(v));

function safeJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // One malformed row degrades to an empty card; it must not fail the page.
    return {};
  }
}

// ---------------- cursor ----------------
//
// Keyset, not offset. created_at alone is not unique (two shares in the
// same millisecond), so the cursor carries (created_at, id) and the query
// orders by both: every event has exactly one position, a page boundary
// can never duplicate or skip a row, and a share posted while someone is
// scrolling does not shift the pages they have yet to load.

export function encodeCursor(row) {
  return Buffer.from(`${row.created_at}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  try {
    const s = Buffer.from(raw, 'base64url').toString('utf8');
    const i = s.lastIndexOf('|');
    if (i <= 0) return null;
    const at = s.slice(0, i);
    const eventId = s.slice(i + 1);
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) || !/^[\w-]{1,64}$/.test(eventId)) return null;
    return { at, id: eventId };
  } catch {
    return null;
  }
}

// ---------------- read ----------------

function eventDTO(r, viewerClientId) {
  return {
    id: r.id,
    type: r.type,
    clientId: r.client_id,
    authorName: r.author_name || 'Member',
    gym: gymLabel(r),
    isYou: r.client_id === viewerClientId,
    createdAt: r.created_at,
    payload: safeJson(r.payload),
  };
}

/**
 * One page of the feed, newest first. Only events whose author is STILL
 * an active member are returned; leaving also deletes a member's events
 * (see core.js purgeMemberContent), and the join is the second lock on
 * that door rather than the only one.
 */
export async function listEvents(db, { community, viewerClientId, cursor = null, limit = 15, filter = 'all' }) {
  const types = Object.prototype.hasOwnProperty.call(FEED_FILTERS, filter) ? FEED_FILTERS[filter] : null;
  const pageSize = Math.max(1, Math.min(Number(limit) || 15, FEED_PAGE_MAX));
  const after = cursor ? decodeCursor(cursor) : null;
  if (cursor && !after) fail(422, 'bad_cursor', 'That page is no longer available. Refresh the feed.');

  const params = [community.id];
  let where = 'e.community_id = ?';
  if (types) {
    where += ` AND e.type IN (${types.map(() => '?').join(',')})`;
    params.push(...types);
  }
  if (after) {
    where += ' AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))';
    params.push(after.at, after.at, after.id);
  }
  params.push(pageSize + 1);

  const rows = await db.q(
    `SELECT e.id, e.client_id, e.type, e.payload, e.created_at,
            u.name AS author_name, m.show_gym, o.name AS org_name, o.type AS org_type
       FROM community_events e
       JOIN community_memberships m
         ON m.community_id = e.community_id AND m.client_id = e.client_id AND m.status = 'active'
       JOIN clients cl ON cl.id = e.client_id
       JOIN users u ON u.id = cl.user_id
       LEFT JOIN organizations o ON o.id = cl.org_id
      WHERE ${where}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?`,
    params);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  return {
    events: page.map((r) => eventDTO(r, viewerClientId)),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

/** An event in this community whose author is still an active member --
 *  the only kind anyone can react to or comment on. */
async function visibleEvent(db, communityId, eventId) {
  if (typeof eventId !== 'string' || !eventId || eventId.length > 64) return null;
  return db.q1(
    `SELECT e.id, e.client_id, e.type FROM community_events e
       JOIN community_memberships m
         ON m.community_id = e.community_id AND m.client_id = e.client_id AND m.status = 'active'
      WHERE e.id = ? AND e.community_id = ?`,
    [eventId, communityId]);
}

// ---------------- share ----------------

/**
 * Everything a share could publish about ONE of the member's completed
 * sessions, read from their own rows. Returns null for a workout that is
 * not theirs or not completed -- the same answer either way.
 */
export async function sessionSnapshot(db, { clientId, workoutId }) {
  if (typeof workoutId !== 'string' || !workoutId) return null;
  const w = await db.q1(
    `SELECT id, name, scheduled_date, completed_at, duration_min
       FROM workouts WHERE id = ? AND client_id = ? AND status = 'completed'`,
    [workoutId, clientId]);
  if (!w) return null;

  const [exercises, totals, records] = await Promise.all([
    // exercise_id and rest_sec travel with the snapshot so another member can
    // take the session into their own planner through the SAME copy engine
    // the gym community uses (community.js copyExercisesToPlanner), which
    // re-validates every id against what that member is allowed to see.
    db.q(
      `SELECT exercise_id, name, sets, reps, weight, rest_sec
         FROM workout_exercises WHERE workout_id = ? ORDER BY position ASC, id ASC`,
      [workoutId]),
    // The boards' own volume expression, over this one session.
    db.q1(
      `SELECT COUNT(*) AS sets,
              COALESCE(SUM(CASE WHEN esl.actual_reps > 0 AND esl.actual_weight >= 0
                                THEN esl.actual_reps * esl.actual_weight ELSE 0 END), 0) AS volume
         FROM exercise_set_logs esl
         JOIN workout_logs wl ON wl.id = esl.workout_log_id
        WHERE wl.workout_id = ? AND wl.client_id = ? AND esl.completed = 1`,
      [workoutId, clientId]),
    // Records the PR engine attributed to this session: the session's logs
    // flagged is_pr, matched to the record rows written for the same
    // exercise on the same day. Nothing here decides what a record is.
    db.q(
      `SELECT DISTINCT pr.id, pr.type, pr.value, pr.weight, pr.reps,
              pr.previous_value, pr.previous_weight, pr.previous_reps, el.name AS exercise
         FROM workout_logs wl
         JOIN personal_records pr
           ON pr.client_id = wl.client_id AND pr.exercise_id = wl.exercise_id AND pr.date = wl.date
         JOIN exercise_library el ON el.id = pr.exercise_id
        WHERE wl.workout_id = ? AND wl.client_id = ? AND wl.is_pr = 1
        ORDER BY exercise ASC, type ASC`,
      [workoutId, clientId]),
  ]);

  const recordList = records.map((r) => ({
    exercise: r.exercise,
    type: r.type,
    value: num(r.value),
    weight: maybeNum(r.weight),
    reps: maybeNum(r.reps),
    previousValue: maybeNum(r.previous_value),
    previousWeight: maybeNum(r.previous_weight),
    previousReps: maybeNum(r.previous_reps),
  }));

  return {
    workout: {
      name: w.name,
      date: w.scheduled_date,
      completedAt: w.completed_at || null,
      durationMin: w.duration_min == null ? null : Math.round(num(w.duration_min)),
      exerciseCount: exercises.length,
      setCount: int(totals?.sets),
      volume: Math.round(num(totals?.volume)),
      // Capped so one enormous session cannot bloat every feed page; the
      // card shows the first few and says how many more there were.
      exercises: exercises.slice(0, 20).map((e) => ({
        exercise_id: e.exercise_id || null,
        name: e.name,
        sets: int(e.sets),
        reps: String(e.reps ?? ''),
        weight: String(e.weight ?? ''),
        rest_sec: e.rest_sec == null ? null : int(e.rest_sec),
      })),
      prCount: recordList.length,
    },
    prs: {
      workoutName: w.name,
      date: w.scheduled_date,
      records: recordList,
      recordCount: recordList.length,
      exerciseCount: new Set(recordList.map((r) => r.exercise)).size,
    },
  };
}

/**
 * The member's recent completed sessions, for the picker inside a community.
 *
 * Reads `workouts` directly rather than /me/workouts: that endpoint powers
 * the planner and deliberately lists only sessions the client authored
 * (source client_custom / manual_retroactive), so a member whose training
 * comes from a coach's program would open the share picker and be told they
 * have nothing to share -- while sitting on thirty logged sessions.
 */
export async function shareableWorkouts(db, { community, client, limit = 30 }) {
  const rows = await db.q(
    `SELECT w.id, w.name, w.scheduled_date, w.duration_min,
            (SELECT COUNT(*) FROM workout_exercises we WHERE we.workout_id = w.id) AS exercise_count,
            EXISTS (SELECT 1 FROM community_events e
                     WHERE e.community_id = ? AND e.dedupe_key = 'workout:' || w.id) AS shared_here
       FROM workouts w
      WHERE w.client_id = ? AND w.status = 'completed'
      ORDER BY w.scheduled_date DESC, w.id DESC
      LIMIT ?`,
    [community.id, client.id, Math.max(1, Math.min(Number(limit) || 30, 60))]);

  return rows.map((r) => ({
    id: r.id,
    name: r.name || 'Workout',
    date: r.scheduled_date,
    durationMin: r.duration_min == null ? null : Math.round(num(r.duration_min)),
    exerciseCount: int(r.exercise_count),
    // EXISTS is a boolean on PostgreSQL and 0/1 on SQLite.
    sharedHere: !!Number(r.shared_here),
  }));
}

export async function shareToCommunity(db, { community, membership, workoutId, includeWorkout = true, includePrs = false }) {
  if (!includeWorkout && !includePrs) {
    fail(422, 'nothing_to_share', 'Choose the workout, its personal records, or both');
  }
  const clientId = membership.client_id;
  const snap = await sessionSnapshot(db, { clientId, workoutId });
  if (!snap) fail(404, 'workout_not_found', 'Completed workout not found');
  if (includePrs && !snap.prs.recordCount && !includeWorkout) {
    fail(422, 'no_prs', 'This workout did not set any personal records');
  }

  const out = { workout: null, prs: null };
  if (includeWorkout) {
    out.workout = await insertEvent(db, {
      communityId: community.id, clientId, type: 'workout', workoutId,
      dedupeKey: `workout:${workoutId}`, payload: snap.workout,
    });
  }
  if (includePrs && snap.prs.recordCount) {
    out.prs = await insertEvent(db, {
      communityId: community.id, clientId, type: 'pr', workoutId,
      dedupeKey: `pr:${workoutId}`, payload: snap.prs,
    });
  }
  return out;
}

/**
 * Where one completed workout could be shared, for the destination picker.
 * Lists the member's gym community (when their gym has one) and each of
 * their friend communities, with what is already there -- so the picker
 * can say "already shared" instead of letting someone post twice.
 */
export async function shareTargets(db, { client, orgId, workoutId }) {
  const snap = await sessionSnapshot(db, { clientId: client.id, workoutId });
  if (!snap) fail(404, 'workout_not_found', 'Completed workout not found');

  const [gym, communities] = await Promise.all([
    gymStatus(db, { client, orgId }),
    db.q(
      `SELECT c.id, c.name, c.theme, c.mark,
              EXISTS (SELECT 1 FROM community_events e
                       WHERE e.community_id = c.id AND e.dedupe_key = ?) AS shared_workout,
              EXISTS (SELECT 1 FROM community_events e
                       WHERE e.community_id = c.id AND e.dedupe_key = ?) AS shared_prs
         FROM community_memberships m
         JOIN communities c ON c.id = m.community_id
        WHERE m.client_id = ? AND m.status = 'active'
        ORDER BY m.joined_at ASC, c.id ASC`,
      [`workout:${workoutId}`, `pr:${workoutId}`, client.id]),
  ]);

  let gymShared = false;
  if (gym.available) {
    const row = await db.q1(
      'SELECT id FROM community_workout_shares WHERE client_id = ? AND workout_id = ?', [client.id, workoutId]);
    gymShared = !!row;
  }

  return {
    workout: { id: workoutId, name: snap.workout.name, date: snap.workout.date },
    prCount: snap.prs.recordCount,
    gym: gym.available ? { ...gym, shared: gymShared } : { available: false },
    communities: communities.map((c) => ({
      id: c.id,
      name: c.name,
      theme: c.theme,
      mark: c.mark || null,
      // EXISTS is a boolean on PostgreSQL and 0/1 on SQLite.
      sharedWorkout: !!Number(c.shared_workout),
      sharedPrs: !!Number(c.shared_prs),
    })),
  };
}

/**
 * Take a shared session into your own planner.
 *
 * Runs through community.js's copyExercisesToPlanner -- the same engine the
 * gym community's Copy button uses -- so the exercise library check is the
 * same one: a gym-specific exercise from someone ELSE's gym is dropped rather
 * than copied, and only global exercises (or your own gym's) come across.
 */
export async function copyEventWorkout(db, { community, client, eventId }) {
  const ev = await db.q1(
    `SELECT e.id, e.payload FROM community_events e
       JOIN community_memberships m
         ON m.community_id = e.community_id AND m.client_id = e.client_id AND m.status = 'active'
      WHERE e.id = ? AND e.community_id = ? AND e.type = 'workout'`,
    [eventId, community.id]);
  if (!ev) fail(404, 'event_not_found', 'That workout is no longer in this community');

  const payload = safeJson(ev.payload);
  const exercises = Array.isArray(payload.exercises) ? payload.exercises : [];
  if (!exercises.length) fail(422, 'nothing_to_copy', 'That post has no exercises to copy');

  const copied = await copyExercisesToPlanner(db, {
    clientId: client.id,
    orgId: client.org_id,
    name: payload.name || 'Shared workout',
    exercises,
    note: `Copied from ${community.name}`,
  });
  if (!copied) fail(422, 'nothing_to_copy', 'None of those exercises are available in your library');
  return copied;
}

export async function deleteEvent(db, { community, membership, eventId }) {
  const ev = await db.q1(
    'SELECT id, client_id FROM community_events WHERE id = ? AND community_id = ?', [eventId, community.id]);
  if (!ev) fail(404, 'event_not_found', 'That post no longer exists');
  const isAuthor = ev.client_id === membership.client_id;
  if (!isAuthor && !can(membership.role, 'moderate')) {
    fail(403, 'forbidden', 'Only the person who shared this, or an admin, can remove it');
  }
  // Reactions and comments go with it (ON DELETE CASCADE).
  await db.run('DELETE FROM community_events WHERE id = ?', [ev.id]);
  return { deleted: true };
}

// ---------------- reactions ----------------

const KIND_LABEL = { pr: 'personal record', workout: 'workout' };

export async function toggleEventReaction(db, { community, membership, eventId, emoji }) {
  if (!isValidReaction(emoji)) fail(422, 'bad_reaction', `Reaction must be one of: ${REACTIONS.join(', ')}`);
  const ev = await visibleEvent(db, community.id, eventId);
  if (!ev) fail(404, 'event_not_found', 'That post no longer exists');

  const clientId = membership.client_id;
  const existing = await db.q1(
    'SELECT id FROM community_event_reactions WHERE event_id = ? AND client_id = ? AND emoji = ?',
    [ev.id, clientId, emoji]);
  if (existing) {
    await db.run('DELETE FROM community_event_reactions WHERE id = ?', [existing.id]);
    return { reacted: false };
  }
  try {
    await db.run(
      'INSERT INTO community_event_reactions (id, event_id, client_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)',
      [id('cer'), ev.id, clientId, emoji, now()]);
  } catch {
    // UNIQUE(event, client, emoji): a concurrent double tap already added
    // it, which is the state the tap asked for.
    return { reacted: true };
  }
  if (ev.client_id !== clientId && KIND_LABEL[ev.type]) {
    await notifyReaction(db, { community, ev, reactorId: clientId });
  }
  return { reacted: true };
}

/**
 * At most ONE unread "reacted to your record" per post. Eight friends each
 * tapping two reactions is a celebration, not sixteen notifications; the
 * first one tells the owner to look, and the post itself shows the rest.
 */
async function notifyReaction(db, { community, ev, reactorId }) {
  try {
    const owner = await db.q1('SELECT user_id FROM clients WHERE id = ?', [ev.client_id]);
    if (!owner) return;
    const unread = await db.q1(
      `SELECT id FROM notifications
        WHERE user_id = ? AND type = 'community_reaction' AND read = 0 AND data_json LIKE ?`,
      [owner.user_id, `%"eventId":"${ev.id}"%`]);
    if (unread) return;
    const who = await clientName(db, reactorId);
    await notifyMember(db, community.id, ev.client_id, {
      type: 'community_reaction',
      title: `${who} reacted to your ${KIND_LABEL[ev.type]}`,
      body: community.name,
      data: { link: `/app/client/community/c/${community.id}?tab=activity`, communityId: community.id, eventId: ev.id },
    });
  } catch { /* best effort, like every notification */ }
}

/** Reaction counts, the viewer's own reactions and comment counts for a
 *  page of events, in three queries however long the page is. Only people
 *  who are still members are counted. */
export async function socialForEvents(db, { community, clientId, eventIds }) {
  const ids = [...new Set(eventIds || [])]
    .filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 64)
    .slice(0, 100);
  const out = {};
  for (const x of ids) out[x] = { counts: {}, mine: [], total: 0, comments: 0 };
  if (!ids.length) return out;

  const ph = ids.map(() => '?').join(',');
  const [counts, mine, comments] = await Promise.all([
    db.q(
      `SELECT r.event_id, r.emoji, COUNT(*) AS n
         FROM community_event_reactions r
         JOIN community_events e ON e.id = r.event_id AND e.community_id = ?
         JOIN community_memberships m
           ON m.community_id = e.community_id AND m.client_id = r.client_id AND m.status = 'active'
        WHERE r.event_id IN (${ph})
        GROUP BY r.event_id, r.emoji`,
      [community.id, ...ids]),
    db.q(
      `SELECT r.event_id, r.emoji
         FROM community_event_reactions r
         JOIN community_events e ON e.id = r.event_id AND e.community_id = ?
        WHERE r.client_id = ? AND r.event_id IN (${ph})`,
      [community.id, clientId, ...ids]),
    db.q(
      `SELECT cc.event_id, COUNT(*) AS n
         FROM community_event_comments cc
         JOIN community_events e ON e.id = cc.event_id AND e.community_id = ?
         JOIN community_memberships m
           ON m.community_id = e.community_id AND m.client_id = cc.client_id AND m.status = 'active'
        WHERE cc.event_id IN (${ph})
        GROUP BY cc.event_id`,
      [community.id, ...ids]),
  ]);

  for (const r of counts) {
    const entry = out[r.event_id];
    if (!entry) continue;
    entry.counts[r.emoji] = int(r.n);
    entry.total += int(r.n);
  }
  for (const r of mine) out[r.event_id]?.mine.push(r.emoji);
  for (const r of comments) if (out[r.event_id]) out[r.event_id].comments = int(r.n);
  return out;
}

// ---------------- comments ----------------

export async function listEventComments(db, { community, viewerClientId, eventId }) {
  const ev = await visibleEvent(db, community.id, eventId);
  if (!ev) fail(404, 'event_not_found', 'That post no longer exists');
  const rows = await db.q(
    `SELECT cc.id, cc.client_id, cc.body, cc.created_at, u.name AS author_name
       FROM community_event_comments cc
       JOIN community_memberships m
         ON m.community_id = ? AND m.client_id = cc.client_id AND m.status = 'active'
       JOIN clients c ON c.id = cc.client_id
       JOIN users u ON u.id = c.user_id
      WHERE cc.event_id = ?
      ORDER BY cc.created_at ASC, cc.id ASC
      LIMIT 200`,
    [community.id, ev.id]);
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    authorName: r.author_name || 'Member',
    body: r.body,
    createdAt: r.created_at,
    isYou: r.client_id === viewerClientId,
  }));
}

export async function addEventComment(db, { community, membership, eventId, body }) {
  const text = cleanText(body, { field: 'Comment', min: 1, max: 500 });
  const ev = await visibleEvent(db, community.id, eventId);
  if (!ev) fail(404, 'event_not_found', 'That post no longer exists');
  const commentId = id('cec');
  await db.run(
    'INSERT INTO community_event_comments (id, event_id, client_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
    [commentId, ev.id, membership.client_id, text, now()]);

  if (ev.client_id !== membership.client_id && KIND_LABEL[ev.type]) {
    const who = await clientName(db, membership.client_id);
    await notifyMember(db, community.id, ev.client_id, {
      type: 'community_comment',
      title: `${who} commented on your ${KIND_LABEL[ev.type]}`,
      body: text.length > 90 ? `${text.slice(0, 89)}…` : text,
      data: { link: `/app/client/community/c/${community.id}?tab=activity`, communityId: community.id, eventId: ev.id },
    });
  }
  return { id: commentId };
}

export async function deleteEventComment(db, { community, membership, commentId }) {
  const row = await db.q1(
    `SELECT cc.id, cc.client_id FROM community_event_comments cc
       JOIN community_events e ON e.id = cc.event_id
      WHERE cc.id = ? AND e.community_id = ?`,
    [commentId, community.id]);
  if (!row) fail(404, 'comment_not_found', 'Comment not found');
  if (row.client_id !== membership.client_id && !can(membership.role, 'moderate')) {
    fail(403, 'forbidden', 'Only the author or an admin can remove this comment');
  }
  await db.run('DELETE FROM community_event_comments WHERE id = ?', [row.id]);
  return { deleted: true };
}
