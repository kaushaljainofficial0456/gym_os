// ============================================================
// REFUND ENGINE (Phase 1 production hardening) -- full or partial
// refunds against a payment_order, reusing the EXISTING payment
// primitives (paymentProvider.js's refundProviderPayment) and the
// EXISTING client-membership state machine (membershipLifecycle.js's
// transitionMembership -- its ACTIVE -> REFUND_PENDING -> REFUNDED
// edges already existed in the graph, just never invoked by anything
// until now) rather than building parallel logic.
//
// Scope: CLIENT_MEMBERSHIP orders only for now -- the membership
// transition graph above already supports it end to end. ORG_PACKAGE /
// ORG_CAPACITY_ADDON refunds would need an additive enum migration on
// org_billing_state/org_subscriptions (neither has a REFUNDED-adjacent
// status today) and are intentionally out of scope for this pass; a
// refund attempted against one of those still processes at the
// provider and is recorded here, it just has no membership-side effect.
//
// payment_orders.amount is NEVER mutated -- the refundable remainder is
// always DERIVED from the sum of this order's own SUCCESSFUL refund
// rows (see remainingRefundable below), so it can never drift.
// ============================================================

import { id, now } from '../../ids.js';
import { refundProviderPayment } from './paymentProvider.js';
import { transitionMembership } from '../enterprise/membershipLifecycle.js';
import { track } from '../events.js';

/** A fresh CLIENT_MEMBERSHIP join order has client_id NULL at creation
 *  time (the clients row doesn't exist yet -- see enrollment.js's own
 *  activation handler comment) and it's never backfilled afterward. A
 *  renewal order has client_id set upfront. Resolve either shape the
 *  same way the activation handler itself does. */
async function resolveClientForOrder(db, order) {
  if (order.client_id) return order.client_id;
  if (order.subject_type !== 'CLIENT_MEMBERSHIP') return null;
  const tokenRow = await db.q1('SELECT consumed_by FROM enrollment_tokens WHERE id = ?', [order.subject_id]);
  if (!tokenRow?.consumed_by) return null;
  const client = await db.q1('SELECT id FROM clients WHERE user_id = ?', [tokenRow.consumed_by]);
  return client?.id || null;
}

export async function remainingRefundable(db, orderId) {
  const order = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) return null;
  const refundedRow = await db.q1(`SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_order_id = ? AND status = 'SUCCESS'`, [orderId]);
  const refunded = Number(refundedRow?.total || 0);
  return { order, refunded, remaining: Math.max(0, order.amount - refunded) };
}

/**
 * Initiates + attempts a refund in one call (Razorpay's refund API
 * responds synchronously in practice, so REQUESTED -> PROCESSING ->
 * SUCCESS/FAILED all resolve within this one invocation -- there's no
 * separate async confirmation to wait on, unlike a checkout which
 * genuinely needs the customer to act). `amount` omitted = full refund
 * of whatever remains. Returns { ok, refund, orderStatus, membership }
 * or { ok: false, reason }.
 */
export async function initiateRefund(db, { orderId, orgId, amount, reason, initiatedBy }) {
  const state = await remainingRefundable(db, orderId);
  if (!state || state.order.org_id !== orgId) return { ok: false, reason: 'order_not_found' };
  const { order, remaining } = state;
  if (!['SUCCESS', 'PARTIALLY_REFUNDED'].includes(order.status)) {
    return { ok: false, reason: 'order_not_refundable', status: order.status };
  }
  const refundAmount = amount == null ? remaining : Number(amount);
  if (!(refundAmount > 0)) return { ok: false, reason: 'invalid_amount' };
  if (refundAmount > remaining + 0.01) return { ok: false, reason: 'exceeds_remaining_refundable', remaining };

  const payTxn = await db.q1(`SELECT * FROM payment_transactions WHERE order_id = ? AND status = 'SUCCESS' ORDER BY created_at DESC LIMIT 1`, [order.id]);
  if (!payTxn?.provider_payment_id) return { ok: false, reason: 'no_captured_payment_found' };

  const clientId = await resolveClientForOrder(db, order);
  const refundId = id('rfnd');
  const nowIso = now();
  const type = refundAmount >= remaining - 0.01 ? 'FULL' : 'PARTIAL';
  await db.run(
    `INSERT INTO refunds (id, payment_order_id, org_id, client_id, type, amount, currency, status, reason, initiated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PROCESSING', ?, ?, ?, ?)`,
    [refundId, order.id, orgId, clientId, type, refundAmount, order.currency, reason || null, initiatedBy || null, nowIso, nowIso]);

  let providerResult;
  try {
    providerResult = await refundProviderPayment({ providerPaymentId: payTxn.provider_payment_id, amount: refundAmount });
  } catch (e) {
    await db.run(`UPDATE refunds SET status = 'FAILED', failure_reason = ?, updated_at = ? WHERE id = ?`, [String(e.message || e).slice(0, 300), now(), refundId]);
    await track(db, { type: 'payment_refund_failed', orgId, userId: initiatedBy, data: { orderId: order.id, refundId, amount: refundAmount } }).catch(() => {});
    return { ok: false, reason: 'provider_refund_failed' };
  }

  await db.run(`UPDATE refunds SET status = 'SUCCESS', provider_refund_id = ?, updated_at = ? WHERE id = ?`, [providerResult.providerRefundId, now(), refundId]);

  const newTotal = state.refunded + refundAmount;
  const newOrderStatus = newTotal >= order.amount - 0.01 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await db.run(`UPDATE payment_orders SET status = ?, updated_at = ? WHERE id = ?`, [newOrderStatus, now(), order.id]);

  // Membership consequence -- ONLY for CLIENT_MEMBERSHIP orders, and
  // ONLY once the order is FULLY refunded (a partial refund is a
  // goodwill/price adjustment, not grounds to terminate an otherwise-
  // active membership -- deterministic by design, see the plan's own
  // refund/membership interaction requirement). Reuses the EXISTING
  // transition graph end to end rather than a bespoke status write.
  let membershipResult = null;
  if (order.subject_type === 'CLIENT_MEMBERSHIP' && newOrderStatus === 'REFUNDED' && clientId) {
    const subscription = await db.q1(
      `SELECT * FROM subscriptions WHERE org_id = ? AND client_id = ? ORDER BY end_date DESC LIMIT 1`, [orgId, clientId]);
    if (subscription) {
      const toPending = await transitionMembership(db, { subscriptionId: subscription.id, orgId, toStatus: 'REFUND_PENDING', reason: 'refund_issued', changedBy: initiatedBy });
      if (toPending.ok) {
        membershipResult = await transitionMembership(db, { subscriptionId: subscription.id, orgId, toStatus: 'REFUNDED', reason: 'refund_completed', changedBy: initiatedBy });
      }
      // An invalid-transition result (e.g. the membership was already
      // CANCELLED) is left as-is deliberately -- the payment-side refund
      // already succeeded and must not be rolled back just because the
      // membership side couldn't also transition; see the reason string
      // surfaced back to the caller via membershipResult below.
    }
  }

  await track(db, { type: 'payment_refunded', orgId, userId: initiatedBy, data: { orderId: order.id, refundId, amount: refundAmount, type, membershipTransitioned: !!membershipResult?.ok } }).catch(() => {});

  const refund = await db.q1('SELECT * FROM refunds WHERE id = ?', [refundId]);
  return { ok: true, refund, orderStatus: newOrderStatus, membership: membershipResult?.subscription || null };
}

export async function listRefunds(db, { orgId, orderId = null }) {
  const conds = ['org_id = ?']; const params = [orgId];
  if (orderId) { conds.push('payment_order_id = ?'); params.push(orderId); }
  return db.q(`SELECT * FROM refunds WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`, params);
}
