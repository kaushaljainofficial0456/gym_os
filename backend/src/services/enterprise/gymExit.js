/**
 * LEAVING A GYM WITHOUT LOSING YOUR TRAINING.
 *
 * A gym can end its relationship with someone. What it cannot end is the
 * person's own record of what they did -- six months of workouts, meals,
 * measurements and records that existed before the gym and belong to
 * them, not to it. A tracker that wiped your history because a gym
 * cancelled your membership would be holding your data hostage.
 *
 * So leaving moves exactly ONE column. The client row keeps its id, and
 * the forty-five tables that hang off it never notice; only clients.org_id
 * changes, from the gym back to the shared independent org.
 *
 * WHAT ACTUALLY STOPS is the live gym half -- crowd, the gym's community,
 * a coach, assigned programmes. Those gate on the org being a real gym
 * (see orgKind.js), so they switch off by consequence of the move rather
 * than needing to be revoked one by one, which is what stops one being
 * forgotten.
 *
 * WHAT STAYS WITH THE GYM is history that happened there: past workouts,
 * payments and subscriptions keep the org they were performed under. The
 * gym's revenue and attendance records are not rewritten by someone
 * leaving, and the client's own list of sessions still shows them.
 */
import { id, now } from '../../ids.js';
import { notify } from './notifications.js';
import { track } from '../events.js';

export const INDEPENDENT_ORG_SLUG = 'independent';

/** The shared pseudo-org independent clients live in, created on demand. */
export async function ensureIndependentOrgId(db) {
  const existing = await db.q1('SELECT id FROM organizations WHERE slug = ?', [INDEPENDENT_ORG_SLUG]);
  if (existing) return existing.id;
  const orgId = id('org');
  await db.run(
    `INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, 'independent', ?)
     ON CONFLICT (slug) DO NOTHING`,
    [orgId, 'Independent Clients', INDEPENDENT_ORG_SLUG, now()]);
  const row = await db.q1('SELECT id FROM organizations WHERE slug = ?', [INDEPENDENT_ORG_SLUG]);
  await db.run(
    `INSERT INTO gym_settings (org_id, brand_name, tagline, crowd_capacity, crowd_enabled, community_enabled, community_leaderboard_enabled, workout_mode_default, allow_substitute, allow_add_exercise, allow_edit_targets, updated_at)
     VALUES (?, 'Barbell', 'Your own coach, in your pocket.', 150, 0, 0, 0, 'custom', 1, 1, 1, ?)
     ON CONFLICT (org_id) DO NOTHING`,
    [row.id, now()]);
  return row.id;
}

/**
 * End a client's gym membership and return them to the independent org.
 *
 * @param reason 'revoked' when the gym ended it, 'left' when they did.
 * @param endedBy the user id who performed it, for the audit trail.
 */
export async function endGymMembership(db, { clientId, reason = 'revoked', endedBy = null }) {
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', [clientId]);
  if (!client) return { ok: false, reason: 'client_not_found' };

  const independentOrgId = await ensureIndependentOrgId(db);
  if (client.org_id === independentOrgId) return { ok: false, reason: 'not_in_a_gym' };

  const gymId = client.org_id;
  const nowIso = now();

  // The client row MOVES; it is never deleted and never re-created. That
  // single fact is what preserves every workout, meal and measurement.
  await db.run('UPDATE clients SET org_id = ?, trainer_id = NULL WHERE id = ?', [independentOrgId, clientId]);
  await db.run('UPDATE users SET org_id = ? WHERE id = ?', [independentOrgId, client.user_id]);

  // Close the open period rather than deleting it: "was a member here
  // from March to September" is true, and useful to both sides.
  await db.run(
    `UPDATE client_gym_periods SET left_at = ?, end_reason = ?, ended_by = ?
      WHERE client_id = ? AND org_id = ? AND left_at IS NULL`,
    [nowIso, reason, endedBy, clientId, gymId]);

  // The gym's community is a gym feature: membership of it ends with the
  // membership. Their own shared posts are left alone -- deleting what
  // someone wrote is a different act from ending their access.
  await db.run('DELETE FROM community_members WHERE client_id = ? AND org_id = ?', [clientId, gymId]);

  /* Active subscriptions stop. The payment history does not: those
     charges happened, and the gym's revenue view must keep showing them.
     `status` is in the base schema; `lifecycle_status` arrives by
     migration, so it is set separately and its absence is survivable --
     a revoke must not fail on a database that has not migrated yet. */
  await db.run(
    `UPDATE subscriptions SET status = 'cancelled'
      WHERE client_id = ? AND org_id = ? AND status = 'active'`,
    [clientId, gymId]);
  try {
    await db.run(
      `UPDATE subscriptions SET lifecycle_status = 'CANCELLED'
        WHERE client_id = ? AND org_id = ? AND lifecycle_status = 'ACTIVE'`,
      [clientId, gymId]);
  } catch { /* pre-migration database: `status` above already reflects it */ }

  // Anything the gym scheduled for them from here on is no longer theirs
  // to prescribe. Completed sessions are untouched -- those happened.
  await db.run(
    `DELETE FROM workouts WHERE client_id = ? AND org_id = ? AND status = 'assigned' AND scheduled_date >= ?`,
    [clientId, gymId, nowIso.slice(0, 10)]);

  // Back to the free plan, which is where someone with no gym paying for
  // them sits. Only set when they are not already on a paid app plan of
  // their own: a Pro subscription they bought is theirs, not the gym's,
  // and losing a gym must not cancel something they pay us for.
  try {
    await db.run(
      `UPDATE client_profiles SET plan_tier = 'free' WHERE client_id = ? AND plan_tier <> 'pro'`,
      [clientId]);
  } catch { /* column arrives by migration; free is already the default */ }

  const gym = await db.q1('SELECT name FROM organizations WHERE id = ?', [gymId]);
  await notify(db, {
    orgId: independentOrgId,
    userId: client.user_id,
    type: 'gym_membership_ended',
    title: reason === 'revoked'
      ? `Your membership at ${gym?.name || 'your gym'} has ended`
      : `You've left ${gym?.name || 'your gym'}`,
    body: 'Everything you have logged stays with you. Gym features are switched off, and you are on the free plan.',
    data: { orgId: gymId, reason },
  }).catch(() => {});

  await track(db, {
    type: 'gym_membership_ended',
    orgId: gymId,
    userId: endedBy,
    data: { clientId, reason },
  }).catch(() => {});

  return { ok: true, clientId, previousOrgId: gymId, independentOrgId };
}
