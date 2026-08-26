// ============================================================
// BILLING QUOTES — the ONE server-side price lock every gym-level
// payment (initial package, upgrade/downgrade, capacity add-on) goes
// through before a payment_order is ever created.
//
// Why this exists, concretely: sk_packages/sk_pricing_rules are
// themselves versioned (effective_from/effective_until) so a LOCKED-IN
// purchase never retroactively changes -- but that only protects a
// purchase that has already completed. Between "the owner opens the
// checkout screen" and "the owner actually pays" there is a real gap
// (seconds to minutes) during which an admin could change pricing. A
// quote closes that gap too: the price is resolved and snapshotted the
// moment the quote is created, not re-derived at payment time, and it
// expires (10 minutes) so a stale, long-abandoned quote can't be paid
// against outdated numbers either. /payment/order accepts ONLY a
// quoteId -- never capacity/price/currency directly from the frontend.
// ============================================================
import { id, now } from '../../ids.js';
import { calculatePackagePrice } from './pricing.js';
import { getOrgBillingSnapshot } from './subscriptionLifecycle.js';

const QUOTE_TTL_MS = 10 * 60 * 1000; // 10 minutes, per spec

async function insertQuote(db, { orgId, kind, packageId, addonId, capacity, basePrice, credit, total, currency, breakdown, createdBy }) {
  const quoteId = id('bq');
  const nowIso = now();
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
  await db.run(
    `INSERT INTO billing_quotes (id, org_id, kind, package_id, addon_id, capacity, base_price, credit, total, currency, breakdown_json, status, created_by, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?, ?, ?)`,
    [quoteId, orgId, kind, packageId ?? null, addonId ?? null, capacity ?? null, basePrice, credit, total, currency,
     JSON.stringify(breakdown ?? null), createdBy ?? null, expiresAt, nowIso]);
  return db.q1('SELECT * FROM billing_quotes WHERE id = ?', [quoteId]);
}

/** Initial package purchase OR a same-capacity renewal quote. */
export async function createOrgPackageQuote(db, { orgId, capacity, createdBy }) {
  const priced = await calculatePackagePrice(db, capacity);
  if (!priced.ok) return { ok: false, reason: priced.reason };
  const quote = await insertQuote(db, {
    orgId, kind: 'ORG_PACKAGE', packageId: priced.basePackage.id, capacity,
    basePrice: priced.price, credit: 0, total: priced.price, currency: priced.currency, breakdown: priced.breakdown, createdBy,
  });
  return { ok: true, quote };
}

/** Additional capacity add-on, billed for the remainder of the current period (not prorated -- see enterprise.js's prior note). */
export async function createCapacityAddonQuote(db, { orgId, addonId, createdBy }) {
  const addon = await db.q1(`SELECT * FROM sk_capacity_addons WHERE id = ? AND status = 'active' AND effective_until IS NULL`, [addonId]);
  if (!addon) return { ok: false, reason: 'addon_not_found' };
  const snapshot = await getOrgBillingSnapshot(db, orgId);
  if (!snapshot.subscription || snapshot.subscription.status !== 'ACTIVE') return { ok: false, reason: 'no_active_subscription' };
  const quote = await insertQuote(db, {
    orgId, kind: 'ORG_CAPACITY_ADDON', addonId: addon.id, capacity: addon.increment,
    basePrice: addon.price, credit: 0, total: addon.price, currency: addon.currency,
    breakdown: { increment: addon.increment, note: 'Billed for the remaining period of the current package -- not prorated.' }, createdBy,
  });
  return { ok: true, quote };
}

/**
 * Upgrade OR downgrade quote. Downgrade is BLOCKED outright (409-style
 * reason, no quote created) when active clients exceed the requested
 * capacity -- per spec's own example message. Otherwise the total is
 * the new package's full price minus a straight-line proration credit
 * for the unused remainder of the CURRENT paid period, floored at 0
 * (this deployment never cash-refunds the difference on a downgrade,
 * it only ever reduces what's charged now).
 */
export async function createOrgUpgradeQuote(db, { orgId, capacity, createdBy }) {
  const snapshot = await getOrgBillingSnapshot(db, orgId);
  const current = snapshot.subscription;
  if (!current || current.status !== 'ACTIVE') return { ok: false, reason: 'no_active_subscription' };
  const currentCapacity = snapshot.purchasedCapacity;
  if (capacity === currentCapacity) return { ok: false, reason: 'same_capacity' };
  if (capacity < currentCapacity && snapshot.activeClients > capacity) {
    return { ok: false, reason: 'downgrade_blocked', activeClients: snapshot.activeClients, requestedCapacity: capacity };
  }
  const priced = await calculatePackagePrice(db, capacity);
  if (!priced.ok) return { ok: false, reason: priced.reason };

  const startMs = Date.parse(current.start_date);
  const endMs = Date.parse(current.end_date);
  const nowMs = Date.now();
  const totalDurationMs = Math.max(1, endMs - startMs);
  const remainingMs = Math.max(0, endMs - nowMs);
  const unusedCredit = Math.round(current.price * (remainingMs / totalDurationMs) * 100) / 100;
  const total = Math.max(0, Math.round((priced.price - unusedCredit) * 100) / 100);

  const quote = await insertQuote(db, {
    orgId, kind: 'ORG_UPGRADE', packageId: priced.basePackage.id, capacity,
    basePrice: priced.price, credit: unusedCredit, total, currency: priced.currency,
    breakdown: {
      ...priced.breakdown, currentCapacity, currentPrice: current.price,
      remainingDays: Math.ceil(remainingMs / 86_400_000), totalDurationDays: Math.ceil(totalDurationMs / 86_400_000), unusedCredit,
    },
    createdBy,
  });
  return { ok: true, quote, direction: capacity > currentCapacity ? 'upgrade' : 'downgrade' };
}

/** Fetches a quote and lazily expires it if its TTL has passed -- same lazy-check style as getOrgBillingSnapshot's subscription expiry. */
export async function getValidQuote(db, quoteId, orgId) {
  const quote = await db.q1('SELECT * FROM billing_quotes WHERE id = ? AND org_id = ?', [quoteId, orgId]);
  if (!quote) return { ok: false, reason: 'quote_not_found' };
  if (quote.status === 'CONSUMED') return { ok: false, reason: 'quote_already_used' };
  if (quote.status !== 'ACTIVE' || Date.parse(quote.expires_at) <= Date.now()) {
    if (quote.status === 'ACTIVE') await db.run(`UPDATE billing_quotes SET status = 'EXPIRED' WHERE id = ?`, [quote.id]);
    return { ok: false, reason: 'quote_expired' };
  }
  return { ok: true, quote };
}

/**
 * Atomic single-use consumption -- the same conditional-UPDATE-as-guard
 * pattern used everywhere else in this codebase (enrollment tokens,
 * capacity reservation): the WHERE clause IS the atomicity guard, so
 * two simultaneous attempts to pay against the SAME quote can't both
 * succeed. Returns true iff this call actually consumed it.
 */
export async function consumeQuote(db, quoteId) {
  const result = await db.run(
    `UPDATE billing_quotes SET status = 'CONSUMED', consumed_at = ? WHERE id = ? AND status = 'ACTIVE' AND expires_at > ?`,
    [now(), quoteId, now()]);
  return result.changes === 1;
}
