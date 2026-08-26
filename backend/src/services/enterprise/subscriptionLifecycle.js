// ============================================================
// ORG SUBSCRIPTION LIFECYCLE — the gym's OWN SaaS subscription to SK OS.
//
// No cron/scheduled-job infrastructure exists in this codebase (checked
// before writing this), so expiry is a LAZY check: getOrgBillingSnapshot
// below is the one place that resolves "is this org's subscription
// actually still active" by comparing end_date to now every time it's
// read, and persists the EXPIRED transition the first time it notices
// one rather than leaving it to silently drift (a subsequent read
// short-circuits on the already-updated status). Every route that needs
// to know "is this gym allowed to do X" calls this function -- nothing
// else re-derives subscription state independently.
// ============================================================

import { id, now } from '../../ids.js';
import { registerActivationHandler } from '../payments/paymentActivation.js';
import { notifyOwners } from './notifications.js';
import { track } from '../events.js';

/**
 * TOTAL PURCHASED CAPACITY / ACTIVE CLIENTS / AVAILABLE CAPACITY are
 * kept explicitly separate per the spec ("this prevents billing/
 * accounting confusion") -- purchased capacity is what the org paid
 * for (current subscription + any add-ons against it); active clients
 * is a live COUNT of clients table rows for this org; available is
 * simply purchased minus active. A client leaving does NOT free a
 * purchased slot on its own (spec: never automatically restore
 * capacity) -- it only reduces the ACTIVE count, which increases
 * available capacity as a natural side effect of the subtraction, not
 * because anything was "given back".
 */
export async function getOrgBillingSnapshot(db, orgId) {
  const billingState = await db.q1('SELECT * FROM org_billing_state WHERE org_id = ?', [orgId]);
  let subscription = await db.q1(
    `SELECT * FROM org_subscriptions WHERE org_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`, [orgId]);

  if (subscription && subscription.end_date && Date.parse(subscription.end_date) <= Date.now()) {
    await db.run(`UPDATE org_subscriptions SET status = 'EXPIRED', updated_at = ? WHERE id = ?`, [now(), subscription.id]);
    await db.run(`UPDATE org_billing_state SET status = 'EXPIRED', updated_at = ? WHERE org_id = ?`, [now(), orgId]);
    subscription = { ...subscription, status: 'EXPIRED' };
    await track(db, { type: 'org_subscription_expired', orgId, data: { subscriptionId: subscription.id } }).catch(() => {});
  }

  const addonRows = subscription
    ? await db.q(`SELECT COALESCE(SUM(increment), 0) AS total FROM org_capacity_purchases WHERE subscription_id = ?`, [subscription.id])
    : [{ total: 0 }];
  const purchasedCapacity = (subscription?.client_capacity || 0) + (addonRows[0]?.total || 0);
  const activeClientsRow = await db.q1(`SELECT COUNT(*) AS n FROM clients WHERE org_id = ?`, [orgId]);
  const activeClients = activeClientsRow?.n || 0;
  const reservedSlots = billingState?.reserved_slots || 0;

  return {
    status: billingState?.status || 'SETUP',
    subscription,
    purchasedCapacity,
    activeClients,
    reservedSlots,
    // reservedSlots (in-flight, unresolved client joins -- see
    // reserveCapacitySlot below) counts against availability the same
    // as an active client does, so a second QR scan or a second join
    // racing the first can't see room that's already spoken for.
    availableCapacity: Math.max(0, purchasedCapacity - activeClients - reservedSlots),
  };
}

/**
 * Atomically claims ONE capacity slot for an in-flight client join, as
 * a SINGLE conditional UPDATE -- the same "guard in the WHERE clause,
 * check rows-affected" pattern as enrollmentToken.js's consume. This is
 * what actually closes the race two simultaneous joins would otherwise
 * hit: computing availableCapacity via a plain SELECT and THEN issuing
 * a separate write has a gap between the two where another request's
 * own SELECT can read the same still-available count before either has
 * written anything (proven by test/enterpriseFlow.test.js's explicit
 * concurrent-join race test). Folding the capacity arithmetic into the
 * UPDATE's own WHERE clause means the read and the write happen as one
 * atomic statement, so a second concurrent UPDATE re-evaluates the
 * WHERE clause against the FIRST one's already-committed effect rather
 * than a stale snapshot. Returns true iff a slot was actually claimed.
 */
export async function reserveCapacitySlot(db, orgId) {
  const result = await db.run(
    `UPDATE org_billing_state
     SET reserved_slots = reserved_slots + 1, updated_at = ?
     WHERE org_id = ?
       AND status = 'ACTIVE'
       AND (
         COALESCE((
           SELECT os.client_capacity + COALESCE((SELECT SUM(ocp.increment) FROM org_capacity_purchases ocp WHERE ocp.subscription_id = os.id), 0)
           FROM org_subscriptions os
           WHERE os.org_id = org_billing_state.org_id AND os.status = 'ACTIVE'
           ORDER BY os.created_at DESC LIMIT 1
         ), 0)
         - (SELECT COUNT(*) FROM clients c WHERE c.org_id = org_billing_state.org_id)
         - reserved_slots
       ) > 0`,
    [now(), orgId]);
  return result.changes === 1;
}

/**
 * Releases a previously-claimed slot -- called exactly once per
 * reservation, either when the payment that would have consumed it
 * definitively fails/cancels (the slot goes back to the pool for a
 * future join) or when it succeeds (the slot converts into a real
 * `clients` row inside the SAME activation transaction, so the
 * reservation must be released in that same moment or it would be
 * double-counted against availableCapacity forever). Floored at 0 via
 * the WHERE guard so a stray extra call is a harmless no-op, never a
 * negative counter.
 */
export async function releaseCapacitySlot(db, orgId) {
  await db.run(
    `UPDATE org_billing_state SET reserved_slots = reserved_slots - 1, updated_at = ? WHERE org_id = ? AND reserved_slots > 0`,
    [now(), orgId]);
}

export async function getActiveTrainerCount(db, orgId) {
  const row = await db.q1(`SELECT COUNT(*) AS n FROM trainers WHERE org_id = ? AND status = 'ACTIVE'`, [orgId]);
  return row?.n || 0;
}

/**
 * ORG_PACKAGE activation -- registered with paymentActivation.js, called
 * inside the SAME transaction that marks the payment_order SUCCESS. The
 * order's subject_id is an org_subscriptions.id already inserted in
 * PENDING_PAYMENT status at order-creation time (see enterprise.js);
 * this just flips it ACTIVE and stamps real start/end dates, computed
 * from the org_subscriptions.package_id's duration_days (never a
 * default -- see the caller's own resolution).
 */
registerActivationHandler('ORG_PACKAGE', async (db, order, tx) => {
  const subscription = await tx.q1('SELECT * FROM org_subscriptions WHERE id = ?', [order.subject_id]);
  if (!subscription) return; // defensive -- should be unreachable if enterprise.js's order creation is correct
  const pkg = await tx.q1('SELECT * FROM sk_packages WHERE id = ?', [subscription.package_id]);
  const startDate = now();
  const endDate = new Date(Date.now() + (pkg?.duration_days || 365) * 86_400_000).toISOString();

  // Supersede any OTHER row still marked ACTIVE for this org (an
  // upgrade purchase mid-cycle) -- history is preserved, never deleted.
  await tx.run(`UPDATE org_subscriptions SET status = 'SUPERSEDED', updated_at = ? WHERE org_id = ? AND status = 'ACTIVE' AND id != ?`,
    [now(), order.org_id, subscription.id]);
  await tx.run(`UPDATE org_subscriptions SET status = 'ACTIVE', start_date = ?, end_date = ?, updated_at = ? WHERE id = ?`,
    [startDate, endDate, now(), subscription.id]);
  await tx.run(`UPDATE org_billing_state SET status = 'ACTIVE', updated_at = ? WHERE org_id = ?`, [now(), order.org_id]);

  await notifyOwners(db, order.org_id, {
    type: 'gym_package_activated',
    title: 'Your SK OS package is active',
    body: `${subscription.client_capacity} client capacity, active until ${endDate.slice(0, 10)}.`,
    data: { subscriptionId: subscription.id },
  });
});

/**
 * ORG_CAPACITY_ADDON activation -- the subject_id is an
 * org_capacity_purchases.id already inserted (amount/capacity locked
 * at order-creation time); this just confirms it happened. Capacity
 * math itself (getOrgBillingSnapshot's SUM over org_capacity_purchases)
 * doesn't need a separate "apply" step -- a capacity_purchases row
 * existing IS the applied state, so there's nothing else to flip here
 * besides notifying the owner.
 */
registerActivationHandler('ORG_CAPACITY_ADDON', async (db, order, tx) => {
  const purchase = await tx.q1('SELECT * FROM org_capacity_purchases WHERE id = ?', [order.subject_id]);
  if (!purchase) return;
  await notifyOwners(db, order.org_id, {
    type: 'gym_capacity_purchased',
    title: `+${purchase.increment} client capacity added`,
    data: { purchaseId: purchase.id },
  });
});

/**
 * Creates the NEXT org_subscriptions row for a renewal or an upgrade --
 * always a NEW row (never mutates the current one in place), so
 * history/invoices for the OLD period are untouched. Returns the new
 * (PENDING_PAYMENT) row; the caller creates a payment_order against it
 * exactly like the initial purchase.
 */
export async function createPendingOrgSubscription(db, { orgId, packageId, clientCapacity, price, currency }) {
  const subId = id('osub');
  const nowIso = now();
  await db.run(
    `INSERT INTO org_subscriptions (id, org_id, package_id, client_capacity, price, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', ?, ?)`,
    [subId, orgId, packageId, clientCapacity, price, currency, nowIso, nowIso]);
  return db.q1('SELECT * FROM org_subscriptions WHERE id = ?', [subId]);
}

export async function createPendingCapacityPurchase(db, { orgId, subscriptionId, addonId, increment, price, currency }) {
  const purchaseId = id('ocap');
  await db.run(
    `INSERT INTO org_capacity_purchases (id, org_id, subscription_id, addon_id, increment, price, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [purchaseId, orgId, subscriptionId, addonId, increment, price, currency, now()]);
  return db.q1('SELECT * FROM org_capacity_purchases WHERE id = ?', [purchaseId]);
}
