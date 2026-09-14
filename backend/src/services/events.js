// Product analytics: append-only event log. Events feed future dashboards
// (retention, feature usage, trainer time saved). Call with a plain object.
// Accept both styles: track(db, 'type', orgId, userId, data) and track(db, { type, orgId, userId, data }).
export async function track(db, typeOrOpts, orgId = null, userId = null, data = {}) {
  let type = typeOrOpts;
  if (typeof typeOrOpts === 'object' && typeOrOpts !== null) {
    ({ type, orgId = null, userId = null, data = {} } = typeOrOpts);
  }
  try {
    await db.run(
      `INSERT INTO events (id, org_id, user_id, type, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['evt_' + Math.random().toString(36).slice(2, 12), orgId, userId, type || 'unknown',
       JSON.stringify(data), new Date().toISOString()]);
  } catch {
    /* analytics must never break the request */
  }
}

/**
 * A MILESTONE: recorded once per user, ever, the first time it becomes true.
 *
 * Activation -- did this member finish setup, log a meal, train? -- could not
 * be read off the per-action events. Finishing the onboarding wizard wrote
 * only 'client_profile_updated', the same event every later settings save
 * writes; a first workout or meal hid among several event types
 * (workout_completed, intel_workout_logged, cardio_logged, meal_logged,
 * intel_food_logged) and, when a trainer logged on a client's behalf, under
 * the trainer's id. So pass the MEMBER's user id.
 *
 * The check and the insert are not atomic: two simultaneous first actions
 * could both record. For analytics that is an acceptable edge, and like
 * track() this never throws into the request.
 */
export async function trackOnce(db, { type, orgId = null, userId, data = {} }) {
  if (!type || !userId) return;
  try {
    const seen = await db.q1('SELECT 1 AS seen FROM events WHERE type = ? AND user_id = ? LIMIT 1', [type, userId]);
    if (seen) return;
  } catch {
    return;
  }
  await track(db, { type, orgId, userId, data });
}
