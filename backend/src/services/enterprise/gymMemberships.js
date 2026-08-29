// ============================================================
// GYM MEMBERSHIPS (Phase 2 production hardening) -- multi-gym user
// identity. A user's single, primary org relationship stays exactly
// where every existing route already reads it (users.org_id, trainers,
// clients -- untouched). gym_memberships is the ADDITIVE layer on top:
// a row per (user, org) the user has ANY relationship with, so a
// trainer working two gyms (or a manager helping run a second
// location) never needs a second account.
//
// syncPrimaryMembership is called from the registration/join code
// paths (auth.js, enrollment.js) so every NEW signup gets a matching
// gym_memberships row going forward -- existing pre-Phase-2 users are
// NOT backfilled by this pass (see the final report); the primary
// users.org_id relationship they already have keeps working completely
// unchanged either way, since nothing existing reads gym_memberships.
// ============================================================
import { id, now } from '../../ids.js';

/** Idempotently records/updates a user's membership row for their
 *  PRIMARY org relationship -- safe to call on every login/registration
 *  without creating duplicates (UNIQUE(user_id, org_id) is the actual
 *  enforcement; this is just the friendly upsert on top of it). */
export async function syncPrimaryMembership(db, { userId, orgId, role, branchId = null }) {
  const existing = await db.q1('SELECT * FROM gym_memberships WHERE user_id = ? AND org_id = ?', [userId, orgId]);
  const nowIso = now();
  if (existing) {
    await db.run(
      `UPDATE gym_memberships SET role = ?, branch_id = COALESCE(?, branch_id), status = 'ACTIVE', updated_at = ? WHERE id = ?`,
      [role, branchId, nowIso, existing.id]);
    return db.q1('SELECT * FROM gym_memberships WHERE id = ?', [existing.id]);
  }
  const membershipId = id('gmem');
  await db.run(
    `INSERT INTO gym_memberships (id, user_id, org_id, branch_id, role, status, joined_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [membershipId, userId, orgId, branchId, role, nowIso, nowIso, nowIso]);
  return db.q1('SELECT * FROM gym_memberships WHERE id = ?', [membershipId]);
}

/** Every ACTIVE gym a user currently belongs to -- what a "Switch Gym"
 *  UI would list. Includes the org name for display. */
export async function listUserMemberships(db, userId) {
  return db.q(
    `SELECT m.*, o.name AS org_name, o.slug AS org_slug
       FROM gym_memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.status = 'ACTIVE'
      ORDER BY m.joined_at ASC`, [userId]);
}

/** Validates the user actually holds an ACTIVE membership at
 *  targetOrgId before a caller re-signs a token for it -- switching
 *  gyms must never be a bare client-supplied org id (see auth.js's
 *  own /switch-gym route, which is the only caller of this). Returns
 *  the membership row or null. */
export async function getActiveMembership(db, { userId, orgId }) {
  return db.q1(`SELECT * FROM gym_memberships WHERE user_id = ? AND org_id = ? AND status = 'ACTIVE'`, [userId, orgId]);
}

/** Grants (or reactivates) a membership for a user at an org they
 *  don't already belong to as their primary org -- the building block
 *  for a future "invite a manager/staff member to this gym" flow.
 *  Deliberately does NOT touch the invited user's users.org_id/role at
 *  all -- their primary identity is unaffected; this is purely an
 *  additional gym_memberships row. */
export async function addMembership(db, { userId, orgId, role, branchId = null, invitedBy = null }) {
  return syncPrimaryMembership(db, { userId, orgId, role, branchId });
}

export async function revokeMembership(db, { userId, orgId }) {
  const result = await db.run(
    `UPDATE gym_memberships SET status = 'CANCELLED', left_at = ?, updated_at = ? WHERE user_id = ? AND org_id = ? AND status = 'ACTIVE'`,
    [now(), now(), userId, orgId]);
  return result.changes === 1;
}
