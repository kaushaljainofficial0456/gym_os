// ============================================================
// PAYMENT ORDERS — the one place a payment_order row gets created.
//
// HARD RULE: amount/currency are ALWAYS resolved from the subject
// (an org_subscription's package, a capacity add-on, a membership
// plan) by the CALLER, server-side, before this function ever runs.
// This module does not accept a caller-supplied amount from anywhere
// near request input -- every call site in this codebase looks the
// price up from a DB row first. See enterprise.js/enrollment.js for
// the actual resolution logic per subject_type.
// ============================================================

import { id, now } from '../../ids.js';
import { createProviderOrder, fetchProviderOrderStatus, providerName } from './paymentProvider.js';
import { assertNotDemoOrg } from '../demo/session.js';

/**
 * Creates (or, if idempotencyKey was already used, returns) a
 * payment_order + its provider-side order. Idempotent on
 * idempotencyKey: a client retrying "pay now" after a flaky network
 * response must never create a second gateway order for the same
 * intent -- the UNIQUE constraint on payment_orders.idempotency_key
 * is the actual enforcement; this function just makes the retry path
 * return the original order instead of erroring.
 */
export async function createPaymentOrder(db, { subjectType, subjectId, orgId, clientId = null, amount, currency = 'INR', idempotencyKey }) {
  if (!(amount > 0)) throw new Error('createPaymentOrder: amount must be a positive number');
  // A demo tenant must never reach a real payment gateway -- see
  // assertNotDemoOrg for why this is guarded at the service and not on the
  // routes. Checked before the idempotency lookup so a demo order cannot
  // be created even once.
  await assertNotDemoOrg(db, orgId, 'make payments');
  if (idempotencyKey) {
    const existing = await db.q1('SELECT * FROM payment_orders WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing && !(await needsNewGatewayOrder(existing))) return existing;
    if (existing) return reissueGatewayOrder(db, existing, { subjectType, subjectId, orgId });
  }
  const orderId = id('pord');
  const nowIso = now();
  const provider = await createProviderOrder({ amount, currency, receipt: orderId, notes: { subjectType, subjectId, orgId } });
  await db.run(
    `INSERT INTO payment_orders (id, subject_type, subject_id, org_id, client_id, amount, currency, provider, provider_order_id, status, idempotency_key, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'CREATED', ?, ?, ?)`,
    [orderId, subjectType, subjectId, orgId, clientId, amount, currency, provider.provider, provider.providerOrderId, idempotencyKey || null, nowIso, nowIso]);
  return db.q1('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
}

/**
 * An unpaid order the current gateway cannot take payment against.
 *
 * Idempotency keys are stable per intent (`renew-<subscription>-<end>`), so
 * an order created under the mock provider, or under another Razorpay
 * account or key pair, was handed back on every later attempt. Razorpay's
 * Checkout was then opened with an order id it had never issued and failed
 * with "Payment Failed", for that member forever. Switching from test keys
 * to live keys would have done the same to every order left unpaid.
 *
 * Only an order nothing has been paid against (CREATED) is ever replaced.
 */
async function needsNewGatewayOrder(existing) {
  if (existing.status !== 'CREATED') return false;
  const current = providerName();
  if (existing.provider !== current) return true;
  if (current !== 'razorpay') return false;
  try {
    const status = await fetchProviderOrderStatus(existing.provider_order_id);
    return !status.found;
  } catch (e) {
    // Razorpay answers an id from another account with a 400; anything
    // else (a network blip) keeps the order rather than replacing it.
    return /\b40[04]\b/.test(String(e?.message || ''));
  }
}

/** The same payment_orders row, with a gateway order the current provider
 *  can take payment against. Compare-and-set on the old gateway id, so two
 *  taps racing here keep one replacement, and the loser gets the winner's. */
async function reissueGatewayOrder(db, existing, { subjectType, subjectId, orgId }) {
  const provider = await createProviderOrder({
    amount: existing.amount, currency: existing.currency, receipt: existing.id, notes: { subjectType, subjectId, orgId },
  });
  // A new attempt, so a new created_at: the member's payment list is dated
  // by it, and a renewal paid today was shown under the day the stale
  // order was first made.
  const nowIso = now();
  await db.run(
    `UPDATE payment_orders SET provider = ?, provider_order_id = ?, created_at = ?, updated_at = ?
      WHERE id = ? AND provider_order_id = ? AND status = 'CREATED'`,
    [provider.provider, provider.providerOrderId, nowIso, nowIso, existing.id, existing.provider_order_id]);
  return db.q1('SELECT * FROM payment_orders WHERE id = ?', [existing.id]);
}

export async function getPaymentOrder(db, orderId) {
  return db.q1('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
}
