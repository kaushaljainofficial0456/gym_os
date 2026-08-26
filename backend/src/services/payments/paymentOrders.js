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
import { createProviderOrder, providerName } from './paymentProvider.js';

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
  if (idempotencyKey) {
    const existing = await db.q1('SELECT * FROM payment_orders WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) return existing;
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

export async function getPaymentOrder(db, orderId) {
  return db.q1('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
}
