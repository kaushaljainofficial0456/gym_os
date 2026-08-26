// ============================================================
// PAYMENT ACTIVATION — the ONE place a payment_order's outcome gets
// finalized and, on success, the thing it paid for gets activated.
//
// Two independent inbound paths can reach this:
//   1. Checkout-return verification (recordCheckoutVerification) --
//      the frontend hands back { orderId, paymentId, signature } right
//      after the gateway's own checkout widget completes. The
//      signature is HMAC'd with a secret only SK OS's server holds, so
//      a VALID signature genuinely proves the payment happened -- it
//      is not "trusting the frontend", it's verifying a cryptographic
//      proof the frontend is merely relaying.
//   2. Webhook (recordWebhookEvent) -- the gateway's own server-to-
//      server callback, the durable channel that still arrives even if
//      the user's browser closed before the checkout redirect returned.
//
// Both are independently sufficient (spec: "Activation must happen
// only after verified payment confirmation from the payment provider/
// webhook/server verification") AND both funnel through the SAME
// _finalizeOrder() below, which is idempotent: whichever arrives
// FIRST activates; the second is a verified no-op. This is what
// prevents "duplicate webhook creates two memberships" and "checkout
// return + webhook both fire -> double activation".
//
// ACTIVATION CALLBACKS are registered per subject_type by the domain
// module that owns that subject (enterprise.js for ORG_PACKAGE/
// ORG_CAPACITY_ADDON, enrollment.js for CLIENT_MEMBERSHIP) via
// registerActivationHandler() -- this file stays domain-agnostic and
// never imports enterprise.js/enrollment.js directly, avoiding a
// circular import (they import FROM here).
// ============================================================

import { id, now } from '../../ids.js';
import { track } from '../events.js';
import {
  verifyCheckoutSignature, verifyWebhookSignature, parseWebhookPayload, mapProviderEventToStatus,
} from './paymentProvider.js';

const _activationHandlers = new Map(); // subject_type -> async (db, order, tx) => void
const _releaseHandlers = new Map();    // subject_type -> async (db, order, tx) => void

/** Registered by the domain module that owns a subject_type. Called
 *  exactly once, inside the SAME transaction that marks the order
 *  SUCCESS, the first time (and only the first time) an order for that
 *  subject_type is finalized as SUCCESS. */
export function registerActivationHandler(subjectType, handler) {
  _activationHandlers.set(subjectType, handler);
}

/** Registered by the domain module that owns a subject_type, for
 *  releasing whatever was provisionally held for an order (e.g. a
 *  reserved capacity slot -- see subscriptionLifecycle.js's
 *  reserveCapacitySlot) once that order is known to have DEFINITIVELY
 *  failed and can never still turn into a SUCCESS. Optional -- most
 *  subject types hold nothing that needs releasing. */
export function registerReleaseHandler(subjectType, handler) {
  _releaseHandlers.set(subjectType, handler);
}

/**
 * Checkout-return path. `signature` must verify against
 * `providerOrderId|providerPaymentId` (see paymentProvider.js). Returns
 * { ok, order, alreadyFinalized } or { ok: false, reason }.
 */
export async function recordCheckoutVerification(db, { orderId, providerPaymentId, signature }) {
  const order = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (!verifyCheckoutSignature({ providerOrderId: order.provider_order_id, providerPaymentId, signature })) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return _finalizeOrder(db, order, {
    providerPaymentId, amount: order.amount, currency: order.currency, status: 'SUCCESS', source: 'checkout_verification',
  });
}

/**
 * Webhook path. `rawBody` MUST be the exact raw request bytes (never a
 * re-serialized JSON.stringify of the parsed body -- that can silently
 * break the signature for a genuinely authentic webhook). Idempotent on
 * (provider, provider_event_id) via payment_events' UNIQUE constraint --
 * a duplicate delivery is detected and short-circuited before it can
 * touch payment_transactions/activation at all.
 */
export async function recordWebhookEvent(db, { rawBody, signature }) {
  if (!verifyWebhookSignature(rawBody, signature)) return { ok: false, reason: 'invalid_webhook_signature' };
  const parsed = parseWebhookPayload(rawBody);
  const status = mapProviderEventToStatus(parsed.eventType);
  if (!status) return { ok: false, reason: 'unrecognized_event_type', eventType: parsed.eventType };

  const order = parsed.providerOrderId
    ? await db.q1('SELECT * FROM payment_orders WHERE provider_order_id = ?', [parsed.providerOrderId])
    : null;

  // Log the raw event FIRST, unconditionally -- this is the
  // reconciliation source of truth even for an order we can't resolve
  // or a duplicate we're about to skip. The UNIQUE(provider, provider_event_id)
  // constraint is the actual duplicate-delivery guard: a second delivery
  // of the same event hits it and we catch that specifically.
  const eventId = id('pevt');
  try {
    await db.run(
      `INSERT INTO payment_events (id, provider, provider_event_id, event_type, order_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [eventId, order?.provider || 'unknown', parsed.providerOrderId ? `${parsed.eventType}:${parsed.providerOrderId}:${parsed.providerPaymentId || ''}` : eventId, parsed.eventType, order?.id || null, rawBody, now()]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { ok: true, duplicate: true, reason: 'duplicate_webhook_delivery' };
    throw e;
  }

  if (!order) return { ok: false, reason: 'order_not_found', eventType: parsed.eventType };

  const result = await _finalizeOrder(db, order, {
    providerPaymentId: parsed.providerPaymentId, amount: parsed.amount, currency: parsed.currency, status, source: 'webhook',
  });
  await db.run('UPDATE payment_events SET processed_at = ? WHERE id = ?', [now(), eventId]);
  return result;
}

/**
 * The one idempotent finalize path both entry points above share.
 * Amount/currency from the provider are compared against what the
 * ORDER was created with (server-resolved at order-creation time,
 * never from this call) -- a mismatch is flagged, never silently
 * accepted (spec: "confirm amount, confirm currency... then activate").
 */
async function _finalizeOrder(db, order, { providerPaymentId, amount, currency, status, source }) {
  const txnId = id('ptxn');
  const mismatch = status === 'SUCCESS' && (
    (amount != null && Math.abs(amount - order.amount) > 0.01) ||
    (currency != null && currency !== order.currency)
  );

  return db.tx(async (tx) => {
    // Always log the transaction attempt, whatever the outcome.
    await tx.run(
      `INSERT INTO payment_transactions (id, order_id, provider, provider_payment_id, amount, currency, status, failure_reason, verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [txnId, order.id, order.provider, providerPaymentId || null, amount ?? order.amount, currency || order.currency,
       mismatch ? 'DISPUTED' : status, mismatch ? 'amount_or_currency_mismatch' : null, mismatch ? null : now(), now()]);

    if (mismatch) {
      const upd = await tx.run(`UPDATE payment_orders SET status = 'DISPUTED', updated_at = ? WHERE id = ? AND status != 'DISPUTED'`, [now(), order.id]);
      if (upd.changes > 0) {
        const release = _releaseHandlers.get(order.subject_type);
        if (release) await release(db, order, tx);
      }
      await track(db, { type: 'payment_amount_mismatch', orgId: order.org_id, data: { orderId: order.id, expected: { amount: order.amount, currency: order.currency }, got: { amount, currency }, source } }).catch(() => {});
      return { ok: false, reason: 'amount_or_currency_mismatch' };
    }

    // Idempotency guard: only an order that ISN'T already SUCCESS can
    // transition to SUCCESS and trigger activation. A second arrival
    // (webhook after checkout-return already finalized it, or a
    // literal duplicate) sees changes === 0 and is reported as an
    // already-finalized no-op, never a second activation.
    if (status === 'SUCCESS') {
      const upd = await tx.run(
        `UPDATE payment_orders SET status = 'SUCCESS', updated_at = ? WHERE id = ? AND status != 'SUCCESS'`,
        [now(), order.id]);
      if (upd.changes === 0) {
        return { ok: true, order, alreadyFinalized: true };
      }
      const handler = _activationHandlers.get(order.subject_type);
      if (handler) await handler(db, order, tx);
      // A provisional hold (e.g. a reserved capacity slot) converts
      // into the real thing the activation handler just created --
      // release it in the SAME transaction so it's never
      // double-counted against availability.
      const release = _releaseHandlers.get(order.subject_type);
      if (release) await release(db, order, tx);
      await track(db, { type: 'payment_success', orgId: order.org_id, data: { orderId: order.id, subjectType: order.subject_type, amount: order.amount, currency: order.currency, source } }).catch(() => {});
      return { ok: true, order, alreadyFinalized: false };
    }

    // Any non-SUCCESS terminal-ish status just updates the order's
    // status directly -- no activation. Guarded against both SUCCESS
    // (a FAILED order can still receive a later SUCCESS from a retry
    // attempt against a NEW order, never this same one) AND the SAME
    // status it's already at, so a duplicate delivery of the same
    // failure/cancellation (e.g. two identical webhook retries) can't
    // fire the release handler twice for one reservation.
    const upd = await tx.run(`UPDATE payment_orders SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('SUCCESS', ?)`, [status, now(), order.id, status]);
    if (upd.changes > 0 && ['FAILED', 'CANCELLED', 'DISPUTED'].includes(status)) {
      const release = _releaseHandlers.get(order.subject_type);
      if (release) await release(db, order, tx);
    }
    await track(db, { type: `payment_${status.toLowerCase()}`, orgId: order.org_id, data: { orderId: order.id, subjectType: order.subject_type, source } }).catch(() => {});
    return { ok: true, order, alreadyFinalized: false };
  });
}
