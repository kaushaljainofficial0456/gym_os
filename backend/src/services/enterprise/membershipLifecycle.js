// ============================================================
// CLIENT MEMBERSHIP LIFECYCLE — a real state machine on top of the
// existing (reused, unchanged) `subscriptions` table.
//
// subscriptions.status stays exactly what every existing route already
// reads ('active' | 'overdue' | 'expired' | 'cancelled') -- nothing
// that queries it needs to change. lifecycle_status (additive column,
// see init-db.js's migration) is the new, richer source of truth:
// PENDING_PAYMENT | ACTIVE | PAUSED | SUSPENDED | EXPIRED | CANCELLED |
// REFUND_PENDING | REFUNDED | TRANSFERRED. Every transition goes
// through transitionMembership() below, which (a) rejects a transition
// that isn't in the explicit graph, (b) keeps the coarse `status`
// column in sync via COARSE_STATUS_MAP so old code keeps working
// unchanged, and (c) writes an immutable membership_status_history row
// -- never just an UPDATE with no trace.
// ============================================================
import { id, now } from '../../ids.js';
import { track } from '../events.js';

// Explicit transition graph -- arbitrary status-hopping is rejected.
// A membership row that has no lifecycle_status yet (pre-migration-
// backfill edge case) is treated as ACTIVE for transition-validation
// purposes, matching the backfill's own default.
const TRANSITIONS = {
  PENDING_PAYMENT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'SUSPENDED', 'EXPIRED', 'CANCELLED', 'REFUND_PENDING', 'TRANSFERRED'],
  PAUSED: ['ACTIVE', 'CANCELLED'],
  SUSPENDED: ['ACTIVE', 'CANCELLED'],
  EXPIRED: ['ACTIVE'], // renewal reactivates a lapsed membership
  REFUND_PENDING: ['REFUNDED', 'ACTIVE'], // ACTIVE = refund request rejected/reversed
  CANCELLED: [],   // terminal
  REFUNDED: [],    // terminal
  TRANSFERRED: [], // terminal -- a NEW subscription row exists at the destination gym
};

// Coarse-status sync -- only the 4 values the rest of the app already
// understands. A lifecycle state with no entry here (PENDING_PAYMENT)
// leaves the coarse `status` column untouched.
const COARSE_STATUS_MAP = {
  ACTIVE: 'active', PAUSED: 'active', SUSPENDED: 'active', REFUND_PENDING: 'active',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled', REFUNDED: 'cancelled', TRANSFERRED: 'cancelled',
};

export function isValidTransition(fromStatus, toStatus) {
  const from = fromStatus || 'ACTIVE';
  return (TRANSITIONS[from] || []).includes(toStatus);
}

/**
 * Validates + applies one membership state transition, atomically, with
 * a history row. Returns { ok, subscription } or { ok: false, reason }.
 * `reason` is one of: not_found, invalid_transition.
 */
export async function transitionMembership(db, { subscriptionId, orgId, toStatus, reason = null, changedBy = null }) {
  return db.tx(async (tx) => {
    const sub = await tx.q1('SELECT * FROM subscriptions WHERE id = ? AND org_id = ?', [subscriptionId, orgId]);
    if (!sub) return { ok: false, reason: 'not_found' };
    const fromStatus = sub.lifecycle_status || 'ACTIVE';
    if (!isValidTransition(fromStatus, toStatus)) {
      return { ok: false, reason: 'invalid_transition', from: fromStatus, to: toStatus };
    }
    const coarse = COARSE_STATUS_MAP[toStatus];
    if (coarse) {
      await tx.run('UPDATE subscriptions SET lifecycle_status = ?, status = ? WHERE id = ?', [toStatus, coarse, sub.id]);
    } else {
      await tx.run('UPDATE subscriptions SET lifecycle_status = ? WHERE id = ?', [toStatus, sub.id]);
    }
    await tx.run(
      `INSERT INTO membership_status_history (id, subscription_id, org_id, previous_status, new_status, reason, changed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('msh'), sub.id, orgId, fromStatus, toStatus, reason, changedBy, now()]);
    await track(db, { type: 'membership_status_changed', orgId, userId: changedBy, data: { subscriptionId: sub.id, from: fromStatus, to: toStatus, reason } }).catch(() => {});
    const updated = await tx.q1('SELECT * FROM subscriptions WHERE id = ?', [sub.id]);
    return { ok: true, subscription: updated };
  });
}

export async function getMembershipHistory(db, subscriptionId, orgId) {
  return db.q('SELECT * FROM membership_status_history WHERE subscription_id = ? AND org_id = ? ORDER BY created_at DESC', [subscriptionId, orgId]);
}
