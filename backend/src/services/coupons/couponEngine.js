// ============================================================
// COUPON ENGINE — the ONE place a coupon is judged, priced, held and
// redeemed. Everything that touches money goes through here; the admin
// CRUD (couponAdmin.js) only ever writes the coupon's own definition.
//
// WHERE IT SITS IN THE EXISTING PAYMENT FLOW (nothing parallel):
//
//   POST /enterprise/billing/quote { couponCodes }
//     -> quotes.js prices the purchase exactly as before, then
//        priceWithCoupons() takes the discount off the locked total.
//        The quote row stores the discount + which coupons. NOTHING is
//        reserved or consumed here -- "Apply" only prices.
//
//   POST /enterprise/payment/order { quoteId }
//     -> reserveQuoteCoupons() re-checks every coupon against the clock
//        and its limits and HOLDS one use (coupon_redemptions RESERVED,
//        coupons.reserved_count + 1) before the gateway order is created
//        for the quote's already-discounted total.
//
//   payment verified (checkout signature OR signed webhook OR
//   reconciliation recovery) -> paymentActivation's _finalizeOrder
//     -> redeemOrderCoupons() inside the SAME transaction that marks the
//        order SUCCESS: RESERVED -> REDEEMED, redemption_count + 1.
//        _finalizeOrder's own "only the first SUCCESS activates" guard
//        is what makes a duplicate callback a no-op here too.
//
//   payment failed / cancelled / disputed -> releaseOrderCoupons()
//   hold older than RESERVATION_TTL_MS with no verified payment
//     -> sweepExpiredReservations() (lazy, no cron -- same posture as
//        getOrgBillingSnapshot's subscription expiry)
//
// CONCURRENCY: the global limit is a conditional UPDATE on the coupon
// row (redemption_count + reserved_count < max_redemptions in the WHERE
// clause) and the per-customer limit is a UNIQUE customer_slot -- both
// atomic on SQLite and PostgreSQL alike, neither a check-then-act race.
//
// LATE PAYMENTS: a hold can end (expired/released) and the customer can
// still complete payment at the discounted price afterwards. They paid
// that price, so the redemption is recorded (late_confirmation = 1)
// even if that takes the coupon one past its limit -- refusing to
// record a real payment would corrupt reconciliation, which is worse
// than a limit overshoot the founder can see.
// ============================================================
import { id, now } from '../../ids.js';
import { track } from '../events.js';
import { registerOrderOutcomeHook } from '../payments/paymentActivation.js';

export const COUPON_KINDS = ['ORG_PACKAGE', 'ORG_UPGRADE', 'ORG_CAPACITY_ADDON'];
export const KIND_LABELS = {
  ORG_PACKAGE: 'New package / renewal',
  ORG_UPGRADE: 'Upgrade / downgrade',
  ORG_CAPACITY_ADDON: 'Capacity add-on',
};
export const CUSTOMER_TYPES = ['ENTERPRISE', 'INDEPENDENT', 'BOTH'];
export const MAX_STACKED_COUPONS = 3;
/** How long a coupon is held for an unpaid gateway order. Longer than
 *  the 10-minute quote TTL (the order is created inside that window) and
 *  long enough for a slow UPI/netbanking confirmation. */
export const RESERVATION_TTL_MS = 30 * 60 * 1000;
/** A coupon never takes a payable amount below this (INR). Razorpay's
 *  own minimum order is Rs 1, and a zero total would route a purchase
 *  down enterprise.js's no-payment "free change" activation path --
 *  a coupon must never be a way to activate a package without paying. */
export const MIN_CHARGE = 1;

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const ACTIVE_HOLD_STATUSES = ['RESERVED', 'REDEEMED'];

/** Trim + uppercase. Returns null for anything that cannot be a code --
 *  the caller answers that exactly like an unknown code (no oracle). */
export function normalizeCouponCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

// ---- money: integer paise internally, so 25% of 13,999 is exactly 3,499.75 ----
const toPaise = (n) => Math.round(Number(n || 0) * 100);
const fromPaise = (p) => Math.round(p) / 100;
export const round2 = (n) => fromPaise(toPaise(n));

export function formatInr(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
}

/** "5 Nov 2026, 12:00 am IST" in the coupon's own timezone. */
export function formatInZone(iso, tz = 'Asia/Kolkata') {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

export function parseJsonArray(value) {
  if (value == null || value === '') return null;
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
}

const isUniqueViolation = (e) => e?.code === '23505' || /unique/i.test(String(e?.message || ''));

// ============================================================
// STATUS -- derived from the clock + counters, never stored (see the
// coupons table comment in schema.sql).
// ============================================================
export function couponStatus(c, nowIso = now()) {
  if (!Number(c.is_enabled)) return 'DISABLED';
  if (c.expires_at <= nowIso) return 'EXPIRED';
  if (c.max_redemptions != null && Number(c.redemption_count) >= Number(c.max_redemptions)) return 'EXHAUSTED';
  if (c.starts_at > nowIso) return 'SCHEDULED';
  return 'ACTIVE';
}

/** The same derivation as couponStatus(), as SQL, so lists can filter,
 *  sort and count by status in the database. Binds TWO parameters, both
 *  the current UTC ISO time: `[nowIso, nowIso]`. ISO-8601 UTC strings
 *  compare correctly as text, which every timestamp here is. */
export function couponStatusSql(alias = 'c') {
  return `CASE WHEN ${alias}.is_enabled = 0 THEN 'DISABLED'
    WHEN ${alias}.expires_at <= ? THEN 'EXPIRED'
    WHEN ${alias}.max_redemptions IS NOT NULL AND ${alias}.redemption_count >= ${alias}.max_redemptions THEN 'EXHAUSTED'
    WHEN ${alias}.starts_at > ? THEN 'SCHEDULED'
    ELSE 'ACTIVE' END`;
}

// ============================================================
// CUSTOMER-FACING REASONS. Never include founder notes, internal names
// or usage counts -- a gym owner sees only why their code did not work.
// ============================================================
const MESSAGES = {
  invalid_code: () => 'Invalid coupon code.',
  disabled: () => 'This coupon is no longer available.',
  not_started: (c) => `This coupon is not active yet. It starts on ${formatInZone(c.starts_at, c.timezone)}.`,
  expired: () => 'This coupon has expired.',
  exhausted: () => 'This coupon has reached its maximum number of uses.',
  already_used: () => 'You have already used this coupon.',
  enterprise_only: () => 'This coupon is only available for Enterprise gyms.',
  independent_only: () => 'This coupon is only available for Independent clients.',
  kind_not_eligible: () => 'This coupon is not applicable to this type of purchase.',
  plan_not_eligible: () => 'This coupon is not applicable to this subscription plan.',
  duration_not_eligible: () => 'This coupon is not applicable to this billing duration.',
  minimum_not_met: (c) => `Minimum purchase amount of ${formatInr(c.minimum_purchase_amount)} not met.`,
  first_time_only: () => 'This coupon is only for first-time Barbell customers.',
  stacking_not_allowed: () => "This coupon can't be combined with other coupons.",
  currency_mismatch: () => 'This coupon is not applicable to this currency.',
  nothing_to_discount: () => 'There is nothing left to discount on this purchase.',
  too_many_coupons: () => `You can apply up to ${MAX_STACKED_COUPONS} coupons to one purchase.`,
  quote_in_use: () => 'This checkout is already being paid for.',
  unknown_customer: () => 'Coupons are not available for this account.',
};

function fail(reason, coupon = null, code = null) {
  const msg = MESSAGES[reason] ? MESSAGES[reason](coupon || {}) : 'This coupon cannot be applied.';
  return { ok: false, reason, code: code || coupon?.code || null, message: msg };
}

// ============================================================
// CONTEXT RESOLUTION -- everything a coupon is judged against comes
// from the database, never from the request.
// ============================================================

/** Enterprise vs Independent, from the AUTHENTICATED org's own row.
 *  organizations.type is structural (see services/orgKind.js) -- there
 *  is no request field a customer could set to change it. */
export async function resolveCustomerType(db, orgId) {
  if (!orgId) return null;
  const org = await db.q1('SELECT type FROM organizations WHERE id = ?', [orgId]);
  if (!org) return null;
  return org.type === 'independent' ? 'INDEPENDENT' : 'ENTERPRISE';
}

/** The capacity tier (sk_packages.name) and billing duration a purchase
 *  belongs to. A package/upgrade quote carries its own base package; an
 *  add-on is bought against the gym's CURRENT package, so it inherits
 *  that package's tier and duration. */
export async function resolvePurchaseTarget(db, { orgId, kind, packageId }) {
  let pkg = null;
  if (kind === 'ORG_CAPACITY_ADDON') {
    const sub = await db.q1(
      `SELECT package_id FROM org_subscriptions WHERE org_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`, [orgId]);
    if (sub) pkg = await db.q1('SELECT name, duration_days FROM sk_packages WHERE id = ?', [sub.package_id]);
  } else if (packageId) {
    pkg = await db.q1('SELECT name, duration_days FROM sk_packages WHERE id = ?', [packageId]);
  }
  return { tier: pkg?.name ?? null, durationDays: pkg?.duration_days != null ? Number(pkg.duration_days) : null };
}

/** True when this gym has never completed a paid Barbell purchase.
 *  Both sources are verified facts: a payment_order only reaches
 *  SUCCESS/REFUNDED through signature-verified finalization, and an
 *  org_subscriptions row only leaves PENDING_PAYMENT by activation. */
export async function isFirstTimeCustomer(db, orgId) {
  const paid = await db.q1(
    `SELECT 1 AS x FROM payment_orders
      WHERE org_id = ? AND subject_type IN ('ORG_PACKAGE','ORG_CAPACITY_ADDON')
        AND status IN ('SUCCESS','REFUNDED','PARTIALLY_REFUNDED') LIMIT 1`, [orgId]);
  if (paid) return false;
  const activated = await db.q1(
    `SELECT 1 AS x FROM org_subscriptions WHERE org_id = ? AND status IN ('ACTIVE','EXPIRED','SUPERSEDED') LIMIT 1`, [orgId]);
  return !activated;
}

async function customerUseCount(db, couponId, orgId, nowIso) {
  const row = await db.q1(
    `SELECT COUNT(*) AS n FROM coupon_redemptions
      WHERE coupon_id = ? AND org_id = ?
        AND (status = 'REDEEMED' OR (status = 'RESERVED' AND reservation_expires_at > ?))`,
    [couponId, orgId, nowIso]);
  return Number(row?.n || 0);
}

// ============================================================
// ELIGIBILITY -- the documented order: exists -> enabled -> window ->
// customer type -> purchase/plan -> minimum -> limits -> stacking.
// ============================================================
async function checkEligibility(db, coupon, ctx, { checkLimits = true } = {}) {
  const { orgId, kind, customerType, target, subtotal, currency, nowIso, stackedCount } = ctx;
  if (!coupon) return fail('invalid_code');
  if (!Number(coupon.is_enabled)) return fail('disabled', coupon);
  if (coupon.starts_at > nowIso) return fail('not_started', coupon);
  if (coupon.expires_at <= nowIso) return fail('expired', coupon);

  if (!customerType) return fail('unknown_customer', coupon);
  if (coupon.customer_type === 'ENTERPRISE' && customerType !== 'ENTERPRISE') return fail('enterprise_only', coupon);
  if (coupon.customer_type === 'INDEPENDENT' && customerType !== 'INDEPENDENT') return fail('independent_only', coupon);

  const kinds = parseJsonArray(coupon.applicable_kinds_json);
  if (kinds && !kinds.includes(kind)) return fail('kind_not_eligible', coupon);
  const tiers = parseJsonArray(coupon.applicable_tiers_json);
  if (tiers && !(target.tier && tiers.includes(target.tier))) return fail('plan_not_eligible', coupon);
  const durations = parseJsonArray(coupon.applicable_durations_json);
  if (durations && !(target.durationDays != null && durations.map(Number).includes(target.durationDays))) {
    return fail('duration_not_eligible', coupon);
  }
  if (coupon.discount_type === 'FIXED' && (coupon.currency || 'INR') !== currency) return fail('currency_mismatch', coupon);

  if (coupon.minimum_purchase_amount != null && toPaise(subtotal) < toPaise(coupon.minimum_purchase_amount)) {
    return fail('minimum_not_met', coupon);
  }

  if (checkLimits) {
    if (coupon.max_redemptions != null
        && Number(coupon.redemption_count) + Number(coupon.reserved_count) >= Number(coupon.max_redemptions)) {
      return fail('exhausted', coupon);
    }
    if (coupon.max_redemptions_per_customer != null
        && (await customerUseCount(db, coupon.id, orgId, nowIso)) >= Number(coupon.max_redemptions_per_customer)) {
      return fail('already_used', coupon);
    }
  }
  if (Number(coupon.first_time_only) && !(await isFirstTimeCustomer(db, orgId))) return fail('first_time_only', coupon);
  if (stackedCount > 1 && !Number(coupon.allow_stacking)) return fail('stacking_not_allowed', coupon);
  return { ok: true };
}

/** Discount in PAISE for one coupon against `remainingPaise`, already
 *  capped (max_discount_amount) and floored (never below MIN_CHARGE). */
export function discountPaise(coupon, remainingPaise) {
  const floorP = toPaise(MIN_CHARGE);
  if (remainingPaise <= floorP) return 0;
  let d = coupon.discount_type === 'PERCENTAGE'
    ? Math.round((remainingPaise * Number(coupon.discount_value)) / 100)
    : toPaise(coupon.discount_value);
  if (coupon.discount_type === 'PERCENTAGE' && coupon.max_discount_amount != null) {
    d = Math.min(d, toPaise(coupon.max_discount_amount));
  }
  return Math.max(0, Math.min(d, remainingPaise - floorP));
}

/** What a gym owner is allowed to see about a coupon at checkout. */
export function publicCouponLine(coupon, discountAmount) {
  return {
    couponId: coupon.id,
    code: coupon.code,
    description: coupon.description || null,
    discountType: coupon.discount_type,
    discountValue: Number(coupon.discount_value),
    maxDiscountAmount: coupon.max_discount_amount != null ? Number(coupon.max_discount_amount) : null,
    discountAmount: round2(discountAmount),
    expiresAt: coupon.expires_at,
    timezone: coupon.timezone,
    appliesTo: describeApplicability(coupon),
  };
}

export function describeApplicability(coupon) {
  const kinds = parseJsonArray(coupon.applicable_kinds_json);
  const tiers = parseJsonArray(coupon.applicable_tiers_json);
  const durations = parseJsonArray(coupon.applicable_durations_json);
  const parts = [];
  parts.push(kinds ? kinds.map((k) => KIND_LABELS[k] || k).join(', ') : 'All purchases');
  if (tiers) parts.push(tiers.join(', '));
  if (durations) parts.push(durations.map((d) => (Number(d) % 365 === 0 ? `${Number(d) / 365 * 12} months` : `${d} days`)).join(', '));
  return parts.join(' · ');
}

/**
 * Prices a purchase with one or more coupon codes. Pure pricing plus
 * reads -- writes nothing except lazily expiring holds that are already
 * past their TTL. `amount` is the payable total BEFORE coupons (after
 * any upgrade proration credit), exactly as quotes.js computed it.
 *
 * Stacked coupons apply in the order given, each to what is left, so
 * stacking can never discount more than the purchase is worth.
 *
 * Returns { ok, subtotal, discount, total, lines } or
 * { ok: false, reason, code, message }.
 */
export async function priceWithCoupons(db, { orgId, kind, packageId = null, amount, currency = 'INR', codes, nowIso = now() }) {
  const seen = new Set();
  const normalized = [];
  for (const raw of codes || []) {
    const code = normalizeCouponCode(raw);
    if (!code) return fail('invalid_code', null, typeof raw === 'string' ? raw.trim().toUpperCase().slice(0, 32) : null);
    if (!seen.has(code)) { seen.add(code); normalized.push(code); }
  }
  if (!normalized.length) return fail('invalid_code');
  if (normalized.length > MAX_STACKED_COUPONS) return fail('too_many_coupons');
  if (!COUPON_KINDS.includes(kind)) return fail('kind_not_eligible');

  const customerType = await resolveCustomerType(db, orgId);
  const target = await resolvePurchaseTarget(db, { orgId, kind, packageId });
  const subtotalP = toPaise(amount);
  let remainingP = subtotalP;
  const lines = [];

  for (const code of normalized) {
    const found = await db.q1('SELECT id FROM coupons WHERE code = ?', [code]);
    if (found) await sweepExpiredReservations(db, { couponId: found.id });
    const coupon = found ? await db.q1('SELECT * FROM coupons WHERE id = ?', [found.id]) : null;
    const check = await checkEligibility(db, coupon, {
      orgId, kind, customerType, target, subtotal: fromPaise(subtotalP), currency, nowIso, stackedCount: normalized.length,
    });
    if (!check.ok) return { ...check, code };
    const d = discountPaise(coupon, remainingP);
    if (d <= 0) return fail('nothing_to_discount', coupon);
    remainingP -= d;
    lines.push(publicCouponLine(coupon, fromPaise(d)));
  }

  return {
    ok: true,
    subtotal: fromPaise(subtotalP),
    discount: fromPaise(subtotalP - remainingP),
    total: fromPaise(remainingP),
    lines,
    customerType,
  };
}

/** The customer-facing success line, built server-side so every
 *  surface says the same thing with the same rounding. */
export function successMessage(lines, discount) {
  const codes = lines.map((l) => l.code).join(' + ');
  return `Congratulations! ${codes} applied successfully. You saved ${formatInr(discount)}.`;
}

export function quoteCouponLines(quote) {
  return parseJsonArray(quote?.coupons_json) || [];
}

// ============================================================
// HOLDS -- created at /payment/order, never at Apply.
// ============================================================

// NOTE: the counter UPDATEs in this file deliberately leave
// coupons.updated_at alone -- that column means "the founder last edited
// this coupon's definition" (shown as "Last changed by ..." in the Admin
// Console). Usage is tracked on coupon_redemptions' own timestamps.
async function decrementReserved(db, couponId) {
  await db.run(
    `UPDATE coupons SET reserved_count = CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END WHERE id = ?`,
    [couponId]);
}

/** Ends ONE hold (RESERVED -> RELEASED|EXPIRED) and gives its unit back.
 *  The status guard in the WHERE clause makes it safe to race against a
 *  concurrent redemption or a second release: only one of them wins. */
async function endHold(db, row, status, reason) {
  const ts = now();
  const upd = await db.run(
    `UPDATE coupon_redemptions SET status = ?, customer_slot = NULL, released_at = ?, release_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'RESERVED'`,
    [status, ts, reason, ts, row.id]);
  if (upd.changes === 1) await decrementReserved(db, row.coupon_id);
  return upd.changes === 1;
}

/**
 * Lazily expires holds past their TTL whose payment never verified.
 * Holds on an order the gateway already reports as in progress
 * (PENDING/PROCESSING) are left alone -- that payment is very likely
 * about to succeed, and expiring it would only make it a late
 * confirmation.
 */
export async function sweepExpiredReservations(db, { couponId = null, limit = 200 } = {}) {
  const nowIso = now();
  const rows = await db.q(
    `SELECT cr.id, cr.coupon_id FROM coupon_redemptions cr
       LEFT JOIN payment_orders po ON po.id = cr.payment_order_id
      WHERE cr.status = 'RESERVED' AND cr.reservation_expires_at <= ?
        AND (po.status IS NULL OR po.status NOT IN ('PENDING','PROCESSING','SUCCESS'))
        ${couponId ? 'AND cr.coupon_id = ?' : ''}
      LIMIT ?`,
    couponId ? [nowIso, couponId, limit] : [nowIso, limit]);
  let expired = 0;
  for (const row of rows) {
    if (await endHold(db, row, 'EXPIRED', 'reservation_expired')) expired += 1;
  }
  return expired;
}

/** Inserts the RESERVED row, claiming the lowest free per-customer slot.
 *  A lost race on a slot just retries with the next free one. */
async function insertHold(db, { coupon, quote, orgId, line, subtotal }) {
  const max = coupon.max_redemptions_per_customer != null ? Number(coupon.max_redemptions_per_customer) : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    let slot = null;
    if (max != null) {
      const taken = await db.q(
        `SELECT customer_slot FROM coupon_redemptions WHERE coupon_id = ? AND org_id = ? AND customer_slot IS NOT NULL`,
        [coupon.id, orgId]);
      const used = new Set(taken.map((r) => Number(r.customer_slot)));
      for (let s = 1; s <= max; s++) if (!used.has(s)) { slot = s; break; }
      if (slot == null) return { ok: false, reason: 'already_used' };
    }
    const rowId = id('cred');
    const ts = now();
    try {
      await db.run(
        `INSERT INTO coupon_redemptions (id, coupon_id, org_id, quote_id, original_amount, discount_amount, final_amount, currency,
           status, customer_slot, reserved_at, reservation_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?)`,
        [rowId, coupon.id, orgId, quote.id, subtotal, round2(line.discountAmount), round2(quote.total), quote.currency,
         slot, ts, new Date(Date.now() + RESERVATION_TTL_MS).toISOString(), ts, ts]);
      return { ok: true, id: rowId, couponId: coupon.id };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const sameQuote = await db.q1('SELECT id FROM coupon_redemptions WHERE coupon_id = ? AND quote_id = ?', [coupon.id, quote.id]);
      if (sameQuote) return { ok: false, reason: 'quote_in_use' };
      // otherwise a concurrent checkout took this slot first -- try the next one
    }
  }
  return { ok: false, reason: 'already_used' };
}

/** Releases holds created for `quoteId` that never got as far as a
 *  gateway order (order creation threw, or the quote turned out to be
 *  already consumed by a concurrent request). */
export async function releaseQuoteReservations(db, quoteId, reason = 'order_not_created') {
  const rows = await db.q(`SELECT id, coupon_id FROM coupon_redemptions WHERE quote_id = ? AND status = 'RESERVED'`, [quoteId]);
  for (const row of rows) await endHold(db, row, 'RELEASED', reason);
}

/**
 * Holds every coupon on `quote` for the payment about to be created.
 * Re-checks each coupon NOW (it may have been disabled, expired, or used
 * up since the quote was priced) but never re-prices: the discount and
 * total stay exactly as locked on the quote. All-or-nothing: a failure
 * on any coupon releases the ones already held by this call.
 */
export async function reserveQuoteCoupons(db, { quote, orgId }) {
  const lines = quoteCouponLines(quote);
  if (!lines.length) return { ok: true, reservations: [] };
  const nowIso = now();
  const customerType = await resolveCustomerType(db, orgId);
  const target = await resolvePurchaseTarget(db, { orgId, kind: quote.kind, packageId: quote.package_id });
  const subtotal = round2(Number(quote.total) + Number(quote.discount_amount || 0));
  const held = [];
  const abort = async (result) => {
    for (const h of held) await endHold(db, { id: h.id, coupon_id: h.couponId }, 'RELEASED', 'reservation_aborted');
    return result;
  };

  for (const line of lines) {
    await sweepExpiredReservations(db, { couponId: line.couponId });
    const coupon = await db.q1('SELECT * FROM coupons WHERE id = ?', [line.couponId]);
    const check = await checkEligibility(db, coupon, {
      orgId, kind: quote.kind, customerType, target, subtotal, currency: quote.currency, nowIso, stackedCount: lines.length,
    }, { checkLimits: false });
    if (!check.ok) return abort({ ...check, code: line.code });

    // The global limit, atomically: the WHERE clause re-reads both
    // counters at write time, so two gyms racing for the last use
    // cannot both get it.
    const claim = await db.run(
      `UPDATE coupons SET reserved_count = reserved_count + 1
        WHERE id = ? AND is_enabled = 1 AND starts_at <= ? AND expires_at > ?
          AND (max_redemptions IS NULL OR redemption_count + reserved_count < max_redemptions)`,
      [coupon.id, nowIso, nowIso]);
    if (claim.changes !== 1) return abort(fail('exhausted', coupon));

    const hold = await insertHold(db, { coupon, quote, orgId, line, subtotal });
    if (!hold.ok) {
      await decrementReserved(db, coupon.id);
      return abort(fail(hold.reason, coupon));
    }
    held.push(hold);
  }
  return { ok: true, reservations: held };
}

/** Links a quote's holds to the subject row (org_subscriptions /
 *  org_capacity_purchases) the moment it exists -- BEFORE the gateway
 *  order -- so a crash between "order created" and "order linked" can
 *  still be resolved by subject at payment time. */
export async function attachReservationSubject(db, { quoteId, subjectType, subjectId }) {
  await db.run(
    `UPDATE coupon_redemptions SET subject_type = ?, subject_id = ?, updated_at = ? WHERE quote_id = ?`,
    [subjectType, subjectId, now(), quoteId]);
}

export async function attachReservationOrder(db, { quoteId, orderId }) {
  await db.run(`UPDATE coupon_redemptions SET payment_order_id = ?, updated_at = ? WHERE quote_id = ?`, [orderId, now(), quoteId]);
}

async function holdsForOrder(tx, order) {
  return tx.q(
    `SELECT * FROM coupon_redemptions
      WHERE payment_order_id = ? OR (payment_order_id IS NULL AND subject_type = ? AND subject_id = ?)`,
    [order.id, order.subject_type, order.subject_id]);
}

/**
 * VERIFIED payment -> REDEEMED. Runs inside _finalizeOrder's SUCCESS
 * transaction, which only ever runs once per order (its own
 * `status != 'SUCCESS'` guard), so a duplicate webhook or a webhook
 * racing the checkout return cannot reach this twice. Every write here
 * is a guarded UPDATE that cannot violate a constraint, so it can never
 * be the reason a real payment fails to finalize.
 */
export async function redeemOrderCoupons(tx, order) {
  if (!['ORG_PACKAGE', 'ORG_CAPACITY_ADDON'].includes(order.subject_type)) return 0;
  const rows = await holdsForOrder(tx, order);
  let redeemed = 0;
  for (const row of rows) {
    if (row.status === 'REDEEMED') continue;
    const ts = now();
    const onTime = await tx.run(
      `UPDATE coupon_redemptions SET status = 'REDEEMED', payment_order_id = ?, redeemed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'RESERVED'`,
      [order.id, ts, ts, row.id]);
    if (onTime.changes === 1) {
      await tx.run(
        `UPDATE coupons SET redemption_count = redemption_count + 1,
            reserved_count = CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END
          WHERE id = ?`,
        [row.coupon_id]);
      redeemed += 1;
      continue;
    }
    // The hold had already ended (expired / released) -- the customer
    // still paid the discounted price, so the redemption is real.
    const late = await tx.run(
      `UPDATE coupon_redemptions SET status = 'REDEEMED', payment_order_id = ?, customer_slot = NULL, late_confirmation = 1,
          redeemed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('RELEASED','EXPIRED')`,
      [order.id, ts, ts, row.id]);
    if (late.changes === 1) {
      await tx.run(`UPDATE coupons SET redemption_count = redemption_count + 1 WHERE id = ?`, [row.coupon_id]);
      redeemed += 1;
    }
  }
  return redeemed;
}

/** Failed / cancelled / disputed payment -> hold RELEASED. Never a redemption. */
export async function releaseOrderCoupons(tx, order, status) {
  if (!['ORG_PACKAGE', 'ORG_CAPACITY_ADDON'].includes(order.subject_type)) return 0;
  const rows = await holdsForOrder(tx, order);
  let released = 0;
  for (const row of rows) {
    if (row.status !== 'RESERVED') continue;
    if (await endHold(tx, row, 'RELEASED', `payment_${String(status || 'failed').toLowerCase()}`)) released += 1;
  }
  return released;
}

// Registered once per process (ES modules evaluate once). The hooks run
// inside paymentActivation's transaction -- see registerOrderOutcomeHook.
registerOrderOutcomeHook({
  name: 'coupons',
  async onSuccess(db, order, tx) {
    const n = await redeemOrderCoupons(tx, order);
    if (n) await track(db, { type: 'coupon_redeemed', orgId: order.org_id, data: { orderId: order.id, count: n } }).catch(() => {});
  },
  async onRelease(db, order, tx, status) {
    await releaseOrderCoupons(tx, order, status);
  },
});
