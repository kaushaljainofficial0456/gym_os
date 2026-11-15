// ============================================================
// SHARING — workouts and meals, by link or straight to a person.
//
// Both ways start from the same IMMUTABLE SNAPSHOT (shared_workouts /
// shared_meals): built from the sender's own rows on the server, never
// from client-supplied exercise or nutrition values, so a share can only
// ever carry what the sender actually has. A link hands that snapshot to
// anyone holding the URL (routes/me.js); an in-app share hands it to
// chosen people through app_shares (routes/shares.js), who get a popup
// and a bell notification and can add it or dismiss it.
//
// Who can be shared with in the app -- shareAudience() -- is only ever
// people the sender can already see in the app: members of their gym's
// community (both opted in), and members of friend communities they are
// both active in. Nobody is findable by name merely for having an account.
// ============================================================
import { id, now } from '../ids.js';
import { dayKey, plannerDay } from '../utils/time.js';
import { setClientWorkoutDays, scheduleSavedWorkoutToday, sessionInProgress } from './trainingProgram.js';

/* 30 days balances "long enough a recipient who doesn't open it right
   away can still use it" against "doesn't outlive its usefulness". */
export const SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_IMPORT_EXERCISES = 20;

const expired = (row) => !!(row?.expires_at && Date.parse(row.expires_at) <= Date.now());

/** The sender's display name, from their account. */
export async function senderName(db, client) {
  const u = await db.q1('SELECT name FROM users WHERE id = ?', [client.user_id]);
  return (u?.name || '').trim() || null;
}

/* ── workout snapshots ─────────────────────────────────────────────── */

/**
 * Build a workout snapshot from one of the sender's own workouts -- a
 * saved workout (client_workouts) or a session (workouts) -- optionally
 * only some of its exercises. Returns { payload } or { status, error }.
 */
export async function workoutPayload(db, client, { workoutId, exerciseIds }) {
  let workout = await db.q1('SELECT * FROM client_workouts WHERE id = ? AND client_id = ?', [workoutId, client.id]);
  let exercises = [];
  if (workout) {
    exercises = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ? ORDER BY position', [workout.id]);
  } else {
    workout = await db.q1('SELECT * FROM workouts WHERE id = ? AND client_id = ?', [workoutId, client.id]);
    if (workout) exercises = await db.q('SELECT * FROM workout_exercises WHERE workout_id = ? ORDER BY position', [workout.id]);
  }
  if (!workout) return { status: 404, error: 'Workout not found' };

  let selected = exercises;
  if (exerciseIds && exerciseIds.length > 0) {
    const want = new Set(exerciseIds);
    selected = exercises.filter((ex) => want.has(ex.id));
    if (!selected.length) return { status: 400, error: 'No matching exercises found in this workout' };
  }
  if (!selected.length) return { status: 400, error: 'This workout has no exercises to share' };

  return {
    payload: {
      type: 'workout',
      name: workout.name || 'Workout',
      notes: workout.notes || null,
      exercises: selected.map((ex, i) => ({
        exercise_id: ex.exercise_id || null,
        name: ex.name,
        sets: ex.sets,
        reps: ex.reps,
        weight: ex.weight,
        rest_sec: ex.rest_sec,
        tempo: ex.tempo || null,
        notes: ex.notes || null,
        superset_group: ex.superset_group || null,
        position: i,
      })),
    },
  };
}

export async function storeWorkoutSnapshot(db, client, payload) {
  const shareId = id('shr');
  const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_MS).toISOString();
  await db.run(
    `INSERT INTO shared_workouts (id, org_id, client_id, shared_by_name, workout_name, payload_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [shareId, client.org_id, client.id, await senderName(db, client), payload.name, JSON.stringify(payload), now(), expiresAt]);
  return { id: shareId, expires_at: expiresAt };
}

/** A workout snapshot that still exists and has not expired, or null. */
export async function loadWorkoutSnapshot(db, shareId) {
  const share = await db.q1('SELECT * FROM shared_workouts WHERE id = ?', [shareId]);
  if (!share || expired(share)) return null;
  let payload = {};
  try { payload = JSON.parse(share.payload_json) || {}; } catch { payload = {}; }
  return { share, payload };
}

/**
 * Match a snapshot's exercises to the RECIPIENT's library: by id when
 * that exercise is global or their gym's own, otherwise by name. Two
 * queries in total, whatever the length.
 */
export async function resolveExercises(db, orgId, list) {
  const capped = list.slice(0, MAX_IMPORT_EXERCISES);
  const ids = [...new Set(capped.map((ex) => ex.exercise_id).filter(Boolean))];
  const byId = new Map();
  if (ids.length) {
    const rows = await db.q(
      `SELECT id, name FROM exercise_library WHERE id IN (${ids.map(() => '?').join(',')}) AND (is_global = 1 OR org_id = ?)`,
      [...ids, orgId]);
    for (const row of rows) byId.set(row.id, row);
  }
  const names = [...new Set(capped.filter((ex) => !(ex.exercise_id && byId.has(ex.exercise_id)) && ex.name).map((ex) => ex.name.toLowerCase()))];
  const byName = new Map();
  if (names.length) {
    const rows = await db.q(
      `SELECT id, name FROM exercise_library WHERE lower(name) IN (${names.map(() => '?').join(',')}) AND (is_global = 1 OR org_id = ?)`,
      [...names, orgId]);
    for (const row of rows) { const k = row.name.toLowerCase(); if (!byName.has(k)) byName.set(k, row); }
  }
  return capped.map((ex) => {
    const lib = (ex.exercise_id && byId.get(ex.exercise_id)) || (ex.name && byName.get(ex.name.toLowerCase()));
    return {
      exercise_id: lib ? lib.id : null,
      name: lib ? lib.name : (ex.name || 'Exercise'),
      sets: Math.max(1, Math.min(12, parseInt(ex.sets, 10) || 3)),
      reps: String(ex.reps ?? 10).slice(0, 12),
      weight: String(ex.weight ?? 'BW').slice(0, 12),
      rest_sec: Math.max(15, Math.min(600, parseInt(ex.rest_sec, 10) || 90)),
      tempo: ex.tempo || null,
      notes: ex.notes || null,
      superset_group: ex.superset_group ? String(ex.superset_group).slice(0, 20) : null,
    };
  });
}

async function uniqueSavedName(db, clientId, raw) {
  const taken = async (n) => !!(await db.q1('SELECT id FROM client_workouts WHERE client_id = ? AND lower(name) = lower(?)', [clientId, n]));
  if (!(await taken(raw))) return raw;
  if (!(await taken(`${raw} (shared)`))) return `${raw} (shared)`;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${raw} (shared ${n})`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${raw} (shared)`;
}

/**
 * Add a shared workout to the recipient's own plan.
 *
 *   'today'        today's session only (replaces an untouched build of
 *                  theirs for today, never a session already under way)
 *   'planner'      a saved workout, no days
 *   'planner_day'  a saved workout on one weekday (the link page's option)
 *   'days'         a saved workout repeating on several weekdays; today
 *                  among them makes it today's session too
 *
 * Callers check planner permission (prescribed gyms) before saving.
 * Throws { status, error } for a refusal the recipient can act on.
 */
export async function importWorkout(db, client, payload, { destination, dayOfWeek, days, exerciseIndexes, name, tz }) {
  const all = payload.exercises || [];
  if (!all.length) throw { status: 400, error: 'This shared workout has no exercises' };
  const indexes = (exerciseIndexes && exerciseIndexes.length) ? exerciseIndexes : all.map((_, i) => i);
  const picked = indexes.filter((i) => i >= 0 && i < all.length).map((i) => all[i]);
  if (!picked.length) throw { status: 400, error: 'No valid exercises selected' };
  const exercises = await resolveExercises(db, client.org_id, picked);
  const rawName = (name || payload.name || 'Shared Workout').trim().slice(0, 80) || 'Shared Workout';
  const today = dayKey(new Date(), tz || 'Asia/Kolkata');

  if (destination === 'today') {
    if (await sessionInProgress(db, client.id, today)) {
      throw { status: 409, error: 'Finish the session you have started first, or save this one for later' };
    }
    const clash = await db.q1(
      `SELECT id FROM workouts WHERE client_id = ? AND lower(name) = lower(?) AND scheduled_date = ? AND source IN ('client_custom', 'program')`,
      [client.id, rawName, today]);
    const finalName = clash ? `${rawName} (shared)` : rawName;
    return db.tx(async (tx) => {
      const wId = id('wko');
      await tx.run(
        `INSERT INTO workouts (id, org_id, client_id, name, day_label, scheduled_date, status, source, notes, created_at)
         VALUES (?,?,?,?,?,?,'assigned', 'client_custom', ?, ?)`,
        [wId, client.org_id, client.id, finalName, finalName.slice(0, 40), today, payload.notes || null, now()]);
      for (const [i, ex] of exercises.entries()) {
        await tx.run(
          `INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes, superset_group)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id('wxe'), wId, ex.exercise_id, i, ex.name, ex.sets, ex.reps, ex.weight, ex.rest_sec, ex.tempo, ex.notes, ex.superset_group]);
      }
      // Replace any untouched build of theirs for today.
      await tx.run(
        `DELETE FROM workouts WHERE client_id = ? AND source = 'client_custom' AND status = 'assigned' AND scheduled_date = ? AND id != ?
           AND started_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM workout_logs wl WHERE wl.workout_id = workouts.id)`,
        [client.id, today, wId]);
      return { id: wId, destination: 'today', name: finalName };
    });
  }

  const finalName = await uniqueSavedName(db, client.id, rawName);
  const repeat = destination === 'planner_day' ? [parseInt(dayOfWeek, 10)]
    : destination === 'days' ? [...new Set((days || []).map(Number))].filter((d) => d >= 0 && d <= 6) : [];
  const result = await db.tx(async (tx) => {
    const cwId = id('cw');
    await tx.run('INSERT INTO client_workouts (id, org_id, client_id, name, notes, created_at) VALUES (?,?,?,?,?,?)',
      [cwId, client.org_id, client.id, finalName, payload.notes || null, now()]);
    for (const [i, ex] of exercises.entries()) {
      await tx.run(
        `INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes, superset_group)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id('cwe'), cwId, ex.exercise_id, i, ex.name, ex.sets, ex.reps, ex.weight, ex.rest_sec, ex.tempo, ex.notes, ex.superset_group]);
    }
    if (repeat.length) await setClientWorkoutDays(tx, client.id, cwId, repeat);
    return {
      id: cwId, destination, name: finalName,
      day_of_week: destination === 'planner_day' ? repeat[0] : undefined,
      days: destination === 'days' ? repeat.sort((a, b) => a - b) : undefined,
    };
  });
  // Repeat days that include today: today's session now, not next week.
  if (destination === 'days' && repeat.includes(plannerDay(today))) {
    Object.assign(result, await scheduleSavedWorkoutToday(db, client, result.id, tz));
  }
  return result;
}

/* ── meal snapshots ────────────────────────────────────────────────── */

/** The sender's own saved meals and foods as snapshot items. */
export async function mealItems(db, client, { mealIds = [], foodIds = [] }) {
  const items = [];
  for (const mealId of mealIds) {
    const meal = await db.q1('SELECT * FROM client_meal_templates WHERE id = ? AND client_id = ?', [mealId, client.id]);
    if (!meal) continue; // a stale selection is skipped, not an error for the whole share
    const parts = await db.q('SELECT * FROM meal_items WHERE meal_template_id = ? ORDER BY position', [meal.id]);
    items.push({
      type: 'meal', name: meal.name, quantity: 1, unit: 'serving',
      calories: meal.calories, protein: meal.protein, carbs: meal.carbs, fat: meal.fat,
      components: parts.map((it) => ({
        name: it.name, quantity: it.quantity, unit: it.unit || 'serving',
        calories: it.calories, protein: it.protein, carbs: it.carbs, fat: it.fat,
      })),
    });
  }
  for (const foodId of foodIds) {
    const food = await db.q1('SELECT * FROM foods WHERE id = ? AND client_id = ?', [foodId, client.id]);
    if (!food) continue;
    items.push({
      // foods.serving is the food's OWN description of one unit ("100 g",
      // "1 bowl"), so quantity 1 x that is exactly what the macros mean.
      type: 'food', name: food.name, quantity: 1, unit: food.serving || food.unit || 'serving',
      calories: food.calories || 0, protein: food.protein || 0, carbs: food.carbs || 0, fat: food.fat || 0,
      components: null,
    });
  }
  return items;
}

export async function storeMealSnapshot(db, client, items) {
  const shareId = id('shr');
  const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_MS).toISOString();
  await db.run(
    `INSERT INTO shared_meals (id, org_id, client_id, shared_by_name, items_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [shareId, client.org_id, client.id, await senderName(db, client), JSON.stringify(items), now(), expiresAt]);
  return { id: shareId, expires_at: expiresAt };
}

export async function loadMealSnapshot(db, shareId) {
  const share = await db.q1('SELECT * FROM shared_meals WHERE id = ?', [shareId]);
  if (!share || expired(share)) return null;
  let items = [];
  try { items = JSON.parse(share.items_json) || []; } catch { items = []; }
  return { share, items };
}

/**
 * Save one shared meal or food into the recipient's own saved list. Never
 * overwrites one of theirs with the same name: the shared one is saved
 * beside it as "<name> (shared)".
 */
export async function saveMealItem(db, client, item) {
  if (item.type === 'meal') {
    const existing = await db.q1('SELECT id FROM client_meal_templates WHERE client_id = ? AND lower(name) = ?', [client.id, String(item.name).toLowerCase()]);
    const savedName = existing ? `${item.name} (shared)` : item.name;
    const mealId = id('cmt');
    await db.run(
      `INSERT INTO client_meal_templates (id, org_id, client_id, slot, name, calories, protein, carbs, fat, position)
       VALUES (?,?,?,?,?,?,?,?,?, COALESCE((SELECT MAX(position)+1 FROM client_meal_templates WHERE client_id = ?), 0))`,
      [mealId, client.org_id, client.id, 'Meal', String(savedName).slice(0, 80), item.calories || 0, item.protein || 0, item.carbs || 0, item.fat || 0, client.id]);
    for (const [i, comp] of (item.components || []).entries()) {
      await db.run(
        `INSERT INTO meal_items (id, meal_template_id, name, quantity, unit, calories, protein, carbs, fat, position)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id('mi'), mealId, String(comp.name || 'Item').slice(0, 80), Number(comp.quantity) || 1, comp.unit || null,
          comp.calories || 0, comp.protein || 0, comp.carbs || 0, comp.fat || 0, i]);
    }
    return { type: 'meal', id: mealId, saved_as: savedName, duplicate: !!existing };
  }
  const existing = await db.q1('SELECT id FROM foods WHERE client_id = ? AND lower(name) = ?', [client.id, String(item.name).toLowerCase()]);
  const savedName = existing ? `${item.name} (shared)` : item.name;
  const foodId = id('food');
  await db.run(
    `INSERT INTO foods (id, org_id, client_id, name, serving, calories, protein, carbs, fat, source, is_global)
     VALUES (?,?,?,?,?,?,?,?,?,'USER_ENTERED',0)`,
    [foodId, client.org_id, client.id, String(savedName).slice(0, 80), item.unit || '100 g',
      item.calories || 0, item.protein || 0, item.carbs || 0, item.fat || 0]);
  return { type: 'food', id: foodId, saved_as: savedName, duplicate: !!existing };
}

/* ── who can be shared with in the app ─────────────────────────────── */

const like = (q) => `%${String(q).toLowerCase().replace(/[%_]/g, '')}%`;

/**
 * People the sender can share with, best first: people they have shared
 * with before, people they follow, friend-community members, then the rest
 * of their gym's community. Each says how they are connected.
 */
export async function shareAudience(db, client, { q = '', limit = 40 } = {}) {
  const search = String(q || '').trim().slice(0, 60);
  const nameClause = search ? 'AND lower(u.name) LIKE ?' : '';
  const nameParam = search ? [like(search)] : [];
  const me = await db.q1('SELECT enabled FROM community_members WHERE client_id = ?', [client.id]);
  const gymOn = Number(me?.enabled) === 1;

  const [gym, friends, follows, recent] = await Promise.all([
    gymOn ? db.q(
      `SELECT c.id AS client_id, u.name, u.avatar
         FROM community_members cm
         JOIN clients c ON c.id = cm.client_id
         JOIN users u ON u.id = c.user_id
        WHERE cm.org_id = ? AND cm.enabled = 1 AND c.org_id = ? AND c.id != ? AND u.active = 1 ${nameClause}
        ORDER BY u.name LIMIT 300`,
      [client.org_id, client.org_id, client.id, ...nameParam]) : [],
    db.q(
      `SELECT c.id AS client_id, u.name, u.avatar, co.name AS community
         FROM community_memberships mine
         JOIN community_memberships them ON them.community_id = mine.community_id AND them.status = 'active'
         JOIN communities co ON co.id = mine.community_id
         JOIN clients c ON c.id = them.client_id
         JOIN users u ON u.id = c.user_id
        WHERE mine.client_id = ? AND mine.status = 'active' AND them.client_id != ? AND u.active = 1 ${nameClause}
        LIMIT 300`,
      [client.id, client.id, ...nameParam]),
    db.q('SELECT following_id FROM community_follows WHERE follower_id = ?', [client.id]),
    db.q(
      `SELECT recipient_client_id AS client_id, MAX(created_at) AS at FROM app_shares
        WHERE sender_client_id = ? GROUP BY recipient_client_id ORDER BY at DESC LIMIT 12`,
      [client.id]),
  ]);

  const byId = new Map();
  const add = (row, patch) => {
    const cur = byId.get(row.client_id) || { client_id: row.client_id, name: row.name || 'Member', avatar: row.avatar || null, gym: false, following: false, communities: [] };
    Object.assign(cur, patch);
    byId.set(row.client_id, cur);
    return cur;
  };
  for (const row of gym) add(row, { gym: true });
  for (const row of friends) {
    const cur = add(row, {});
    if (row.community && !cur.communities.includes(row.community)) cur.communities.push(row.community);
  }
  const followed = new Set(follows.map((f) => f.following_id));
  const recentAt = new Map(recent.map((r) => [r.client_id, r.at]));
  const people = [...byId.values()].map((p) => ({ ...p, following: followed.has(p.client_id), recent: recentAt.has(p.client_id) }));
  const rank = (p) => (p.recent ? 0 : p.following ? 1 : p.communities.length ? 2 : 3);
  people.sort((a, b) => rank(a) - rank(b)
    || String(recentAt.get(b.client_id) || '').localeCompare(String(recentAt.get(a.client_id) || ''))
    || a.name.localeCompare(b.name));
  return { people: people.slice(0, limit), gym_community: gymOn };
}

/** Of `ids`, the ones the sender may share with (same rules as above). */
export async function allowedRecipients(db, client, ids) {
  const want = [...new Set(ids)].filter((x) => x && x !== client.id);
  if (!want.length) return new Set();
  const ph = want.map(() => '?').join(',');
  const me = await db.q1('SELECT enabled FROM community_members WHERE client_id = ?', [client.id]);
  const [gym, friends] = await Promise.all([
    Number(me?.enabled) === 1 ? db.q(
      `SELECT c.id FROM community_members cm JOIN clients c ON c.id = cm.client_id
        WHERE cm.client_id IN (${ph}) AND cm.enabled = 1 AND cm.org_id = ? AND c.org_id = ?`,
      [...want, client.org_id, client.org_id]) : [],
    db.q(
      `SELECT DISTINCT them.client_id AS id FROM community_memberships mine
         JOIN community_memberships them ON them.community_id = mine.community_id AND them.status = 'active'
        WHERE mine.client_id = ? AND mine.status = 'active' AND them.client_id IN (${ph})`,
      [client.id, ...want]),
  ]);
  return new Set([...gym, ...friends].map((r) => r.id));
}
