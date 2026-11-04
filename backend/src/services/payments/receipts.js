// ============================================================
// RECEIPTS — one for every payment, however it was paid.
//
// Every completed payment is a `payments` row. One made online already
// points at its payment_orders row (external_ref) and was invoiced at
// checkout. One taken at the desk -- cash, UPI to the gym's own number, a
// card machine -- had neither, so it had no receipt at all, and the member
// could not even see it in their own payment history.
//
// A desk payment now gets an order of its own (provider 'manual', the
// owner's reference, if any, as its provider reference) and an invoice
// dated the day it was paid. Payments recorded before this existed get the
// same the first time anyone asks for their receipt.
// ============================================================

import { id, now } from '../../ids.js';
import { issueInvoice } from './invoices.js';

/** The order and receipt for a payment taken at the desk. Idempotent on
 *  the payment id, so a retried request cannot receipt it twice. */
export async function receiptManualPayment(db, payment, { reference = null } = {}) {
  const key = `manual-${payment.id}`;
  let order = await db.q1('SELECT * FROM payment_orders WHERE idempotency_key = ?', [key]);
  if (!order) {
    const orderId = id('pord');
    const nowIso = now();
    await db.run(
      `INSERT INTO payment_orders (id, subject_type, subject_id, org_id, client_id, amount, currency, provider, provider_order_id, status, idempotency_key, created_at, updated_at)
       VALUES (?, 'CLIENT_MEMBERSHIP', ?, ?, ?, ?, ?, 'manual', ?, 'SUCCESS', ?, ?, ?)`,
      [orderId, payment.subscription_id || null, payment.org_id, payment.client_id, payment.amount, payment.currency || 'INR',
        reference, key, nowIso, nowIso]);
    order = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  }
  if (payment.external_ref !== order.id) {
    await db.run('UPDATE payments SET external_ref = ? WHERE id = ?', [order.id, payment.id]);
  }
  return issueInvoice(db, order, { issuedAt: payment.paid_at || undefined });
}

/** The receipt for any payment row: the checkout's invoice for one paid
 *  online, a desk receipt (created now, if need be) for one that was not. */
export async function ensureReceipt(db, payment) {
  const order = payment.external_ref
    ? await db.q1('SELECT * FROM payment_orders WHERE id = ?', [payment.external_ref])
    : null;
  if (order && order.provider !== 'manual') return issueInvoice(db, order);
  return receiptManualPayment(db, payment);
}
