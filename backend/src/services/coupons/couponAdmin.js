// ============================================================
// COUPON ADMINISTRATION — the founder's side: define, edit, switch off,
// list and measure coupons. SUPER_ADMIN-only by construction: the only
// caller is routes/consoleCoupons.js, mounted inside the Admin Console
// router (routes/console.js) behind its requireAuth + requireRole gate.
//
// Every metric here is computed from coupon_redemptions rows in status
// REDEEMED -- a status that is only ever set inside the payment
// finalization transaction after a VERIFIED payment (see
// couponEngine.redeemOrderCoupons). Holds, releases and expiries are
// reported separately and never counted as redemptions.
// ============================================================
import { id, now } from '../../ids.js';
import {
  COUPON_KINDS, CUSTOMER_TYPES, KIND_LABELS, PERSONAL_KINDS, normalizeCouponCode, couponStatus, couponStatusSql, parseJsonArray,
  sweepExpiredReservations, round2, describeApplicability, HELD_FOR_REVIEW,
} from './couponEngine.js';
import { couponWindowFromLocal, utcToZoned, isValidTimeZone, zonedToUtcMs, DEFAULT_COUPON_TZ } from './couponTime.js';
import { plans as barbellPlans } from '../plans/barbellPlan.js';

/** The Barbell plan's lengths (30 / 365 days), which a coupon may also
 *  be limited to alongside the gym packages' durations. */
const planDurations = () => Object.values(barbellPlans()).map((p) => Number(p.days));

/** One customer, as the analytics count them: the person for a Barbell
 *  plan purchase (every Independent client shares one org), the gym for
 *  everything else. */
const CUSTOMER_KEY_SQL = `CASE WHEN cr.user_id IS NOT NULL THEN 'u:' || cr.user_id ELSE 'o:' || cr.org_id END`;

/** Fields that define what a coupon IS worth and to whom. Once any
 *  gym has held or redeemed the coupon these are frozen: changing them
 *  would make one code mean two different things across its own
 *  history. Everything else (window, limits, applicability, notes,
 *  stacking, on/off) stays editable. Past redemptions are snapshots and
 *  are never touched by an edit either way. */
export const LOCKED_AFTER_USE = ['code', 'discount_type', 'discount_value', 'max_discount_amount', 'customer_type'];

const MONEY_MAX = 10_000_000;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (s, max) => (s == null ? null : String(s).replace(CONTROL_CHARS, '').trim().slice(0, max) || null);
/** At most 2 decimal places (paise), tolerant of float noise like 0.1 + 0.2. */
const twoDp = (n) => Number.isFinite(Number(n)) && Math.abs(Math.round(Number(n) * 100) - Number(n) * 100) < 1e-6;
const jsonOrNull = (arr) => (Array.isArray(arr) && arr.length ? JSON.stringify(arr) : null);

export class CouponError extends Error {
  constructor(status, error, message, extra = {}) {
    super(message);
    this.status = status;
    this.error = error;
    this.extra = extra;
  }
}

/** Capacity tiers and billing durations the CURRENT pricing model
 *  actually has -- the only values a coupon may be restricted to, so
 *  the form can never invent a plan category that does not exist. */
export async function getCouponOptions(db) {
  const pkgs = await db.q(
    `SELECT name, client_capacity, duration_days, price, currency FROM sk_packages WHERE status = 'active' AND effective_until IS NULL ORDER BY client_capacity ASC`);
  const allNames = await db.q('SELECT DISTINCT name FROM sk_packages');
  const durations = [...new Set([...pkgs.map((p) => Number(p.duration_days)), ...planDurations()])].sort((a, b) => a - b);
  return {
    // `personal` marks the Barbell plan: bought by Independent clients
    // only, so the form keeps it out of an Enterprise-only coupon.
    kinds: COUPON_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k], personal: PERSONAL_KINDS.includes(k) })),
    // price is for the form's PREVIEW only ("on 100 Clients a gym would
    // pay..."); what a gym is actually charged is always re-priced
    // server-side at checkout.
    tiers: pkgs.map((p) => ({ value: p.name, label: p.name, capacity: Number(p.client_capacity), price: Number(p.price), durationDays: Number(p.duration_days) })),
    knownTierNames: allNames.map((r) => r.name),
    // The Barbell plan's own prices, for the same preview. It has no
    // capacity tier, so a tier-limited coupon never applies to it.
    plans: Object.values(barbellPlans()).map((p) => ({ value: p.id, label: `Barbell plan · ${p.name}`, price: Number(p.amount), durationDays: Number(p.days) })),
    durations: durations.map((d) => ({ value: d, label: d % 365 === 0 ? `${(d / 365) * 12} months (${d} days)` : `${d} days` })),
    customerTypes: [
      { value: 'ENTERPRISE', label: 'Enterprise gyms' },
      { value: 'INDEPENDENT', label: 'Independent clients' },
      { value: 'BOTH', label: 'Both' },
    ],
    timezones: ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York'],
    defaultTimezone: DEFAULT_COUPON_TZ,
  };
}

/** Business rules zod cannot express. `input` is the camelCase body. */
async function normalizeInput(db, input) {
  const code = normalizeCouponCode(input.code);
  if (!code) {
    throw new CouponError(422, 'invalid_code', 'Coupon code must be 3–32 characters: letters, numbers, hyphen or underscore, starting with a letter or number.');
  }
  const discountType = input.discountType;
  const value = Number(input.discountValue);
  if (!(value > 0) || !twoDp(value)) throw new CouponError(422, 'invalid_discount', 'Discount value must be a positive amount with at most 2 decimal places.');
  if (discountType === 'PERCENTAGE' && value >= 100) {
    throw new CouponError(422, 'invalid_discount', 'A percentage discount must be less than 100%. Coupons can never make a subscription free.');
  }
  if (discountType === 'FIXED' && value > MONEY_MAX) throw new CouponError(422, 'invalid_discount', 'Fixed discount is too large.');
  const maxDiscount = discountType === 'PERCENTAGE' && input.maxDiscountAmount != null ? Number(input.maxDiscountAmount) : null;
  if (maxDiscount != null && (!(maxDiscount > 0) || !twoDp(maxDiscount))) {
    throw new CouponError(422, 'invalid_discount_cap', 'Maximum discount must be a positive amount with at most 2 decimal places.');
  }
  const minPurchase = input.minimumPurchaseAmount != null ? Number(input.minimumPurchaseAmount) : null;
  if (minPurchase != null && (!(minPurchase >= 0) || !twoDp(minPurchase))) {
    throw new CouponError(422, 'invalid_minimum', 'Minimum purchase must be zero or more, with at most 2 decimal places.');
  }
  if (!CUSTOMER_TYPES.includes(input.customerType)) throw new CouponError(422, 'invalid_customer_type', 'Choose who this coupon is for.');

  const timezone = input.timezone || DEFAULT_COUPON_TZ;
  if (!isValidTimeZone(timezone)) throw new CouponError(422, 'invalid_timezone', 'Unknown timezone.');
  const window = couponWindowFromLocal({ ...input, timezone });
  if (!window.ok) throw new CouponError(422, window.reason, window.message);

  const kinds = Array.isArray(input.applicableKinds) && input.applicableKinds.length ? [...new Set(input.applicableKinds)] : null;
  if (kinds && kinds.some((k) => !COUPON_KINDS.includes(k))) throw new CouponError(422, 'invalid_kind', 'Unknown purchase type.');
  if (kinds && input.customerType === 'ENTERPRISE' && kinds.some((k) => PERSONAL_KINDS.includes(k))) {
    throw new CouponError(422, 'invalid_kind', 'Only Independent clients buy the Barbell plan, so an Enterprise-only coupon cannot include it.');
  }
  if (kinds && kinds.length === COUPON_KINDS.length) kinds.length = 0; // "every type" is stored as no restriction
  const tiers = Array.isArray(input.applicableTiers) && input.applicableTiers.length ? [...new Set(input.applicableTiers.map((t) => String(t)))] : null;
  if (tiers) {
    const known = new Set((await db.q('SELECT DISTINCT name FROM sk_packages')).map((r) => r.name));
    const unknown = tiers.filter((t) => !known.has(t));
    if (unknown.length) throw new CouponError(422, 'invalid_tier', `Unknown capacity tier: ${unknown.join(', ')}.`);
  }
  const durations = Array.isArray(input.applicableDurations) && input.applicableDurations.length
    ? [...new Set(input.applicableDurations.map(Number))] : null;
  if (durations) {
    const known = new Set([...(await db.q('SELECT DISTINCT duration_days FROM sk_packages')).map((r) => Number(r.duration_days)), ...planDurations()]);
    const unknown = durations.filter((d) => !known.has(d));
    if (unknown.length) throw new CouponError(422, 'invalid_duration', `Unknown billing duration: ${unknown.join(', ')} days.`);
  }

  const maxRedemptions = input.maxRedemptions != null ? Number(input.maxRedemptions) : null;
  const perCustomer = input.maxRedemptionsPerCustomer != null ? Number(input.maxRedemptionsPerCustomer) : null;
  if (maxRedemptions != null && perCustomer != null && perCustomer > maxRedemptions) {
    throw new CouponError(422, 'invalid_limits', 'Per-customer limit cannot exceed the total redemption limit.');
  }

  return {
    code,
    internal_name: clean(input.internalName, 120),
    description: clean(input.description, 500),
    discount_type: discountType,
    discount_value: round2(value),
    max_discount_amount: maxDiscount != null ? round2(maxDiscount) : null,
    minimum_purchase_amount: minPurchase != null ? round2(minPurchase) : null,
    customer_type: input.customerType,
    applicable_kinds_json: jsonOrNull(kinds),
    applicable_tiers_json: jsonOrNull(tiers),
    applicable_durations_json: jsonOrNull(durations),
    starts_at: window.startsAt,
    expires_at: window.expiresAt,
    timezone,
    max_redemptions: maxRedemptions,
    max_redemptions_per_customer: perCustomer,
    first_time_only: input.firstTimeOnly ? 1 : 0,
    allow_stacking: input.allowStacking ? 1 : 0,
    is_enabled: input.enabled === false ? 0 : 1,
    founder_notes: clean(input.founderNotes, 2000),
  };
}

/** Admin-facing shape: the stored row plus everything derived. */
export function serializeCoupon(row, nowIso = now()) {
  if (!row) return null;
  const kinds = parseJsonArray(row.applicable_kinds_json);
  const tiers = parseJsonArray(row.applicable_tiers_json);
  const durations = parseJsonArray(row.applicable_durations_json);
  const redeemed = Number(row.redemption_count || 0);
  const max = row.max_redemptions != null ? Number(row.max_redemptions) : null;
  return {
    ...row,
    discount_value: Number(row.discount_value),
    max_discount_amount: row.max_discount_amount != null ? Number(row.max_discount_amount) : null,
    minimum_purchase_amount: row.minimum_purchase_amount != null ? Number(row.minimum_purchase_amount) : null,
    max_redemptions: max,
    max_redemptions_per_customer: row.max_redemptions_per_customer != null ? Number(row.max_redemptions_per_customer) : null,
    redemption_count: redeemed,
    reserved_count: Number(row.reserved_count || 0),
    first_time_only: !!Number(row.first_time_only),
    allow_stacking: !!Number(row.allow_stacking),
    is_enabled: !!Number(row.is_enabled),
    status: row.status || couponStatus(row, nowIso),
    applicable_kinds: kinds,
    applicable_tiers: tiers,
    applicable_durations: durations ? durations.map(Number) : null,
    applicable_plans: kinds || tiers || durations ? 'SELECTED' : 'ALL',
    applies_to: describeApplicability(row),
    remaining_redemptions: max != null ? Math.max(0, max - redeemed) : null,
    starts_local: utcToZoned(row.starts_at, row.timezone),
    expires_local: utcToZoned(row.expires_at, row.timezone),
  };
}

async function loadCoupon(db, couponId) {
  return db.q1(
    `SELECT c.*, u.name AS created_by_name, u.email AS created_by_email, ub.name AS updated_by_name
       FROM coupons c
       LEFT JOIN users u ON u.id = c.created_by
       LEFT JOIN users ub ON ub.id = c.updated_by
      WHERE c.id = ?`, [couponId]);
}

export async function getCoupon(db, couponId) {
  const row = await loadCoupon(db, couponId);
  if (!row) return null;
  const activity = await db.q1('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?', [couponId]);
  return { ...serializeCoupon(row), has_activity: Number(activity?.n || 0) > 0, locked_fields: Number(activity?.n || 0) > 0 ? LOCKED_AFTER_USE : [] };
}

export async function createCoupon(db, input, adminId) {
  const v = await normalizeInput(db, input);
  const dup = await db.q1('SELECT id FROM coupons WHERE code = ?', [v.code]);
  if (dup) throw new CouponError(409, 'duplicate_code', `A coupon with the code ${v.code} already exists. Codes are case-insensitive.`);
  const couponId = id('cpn');
  const ts = now();
  try {
    await db.run(
      `INSERT INTO coupons (id, code, internal_name, description, discount_type, discount_value, max_discount_amount,
         minimum_purchase_amount, currency, customer_type, applicable_kinds_json, applicable_tiers_json, applicable_durations_json,
         starts_at, expires_at, timezone, max_redemptions, max_redemptions_per_customer, first_time_only, allow_stacking,
         is_enabled, founder_notes, created_by, updated_by, disabled_at, disabled_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [couponId, v.code, v.internal_name, v.description, v.discount_type, v.discount_value, v.max_discount_amount,
       v.minimum_purchase_amount, v.customer_type, v.applicable_kinds_json, v.applicable_tiers_json, v.applicable_durations_json,
       v.starts_at, v.expires_at, v.timezone, v.max_redemptions, v.max_redemptions_per_customer, v.first_time_only, v.allow_stacking,
       v.is_enabled, v.founder_notes, adminId, adminId, v.is_enabled ? null : ts, v.is_enabled ? null : adminId, ts, ts]);
  } catch (e) {
    // Lost a race with a concurrent create of the same code -- the
    // UNIQUE constraint is the real guard, the SELECT above is UX.
    if (e?.code === '23505' || /unique/i.test(String(e?.message))) {
      throw new CouponError(409, 'duplicate_code', `A coupon with the code ${v.code} already exists. Codes are case-insensitive.`);
    }
    throw e;
  }
  return getCoupon(db, couponId);
}

/**
 * Full replacement of the editable definition (the form always sends
 * every field). Fields in LOCKED_AFTER_USE may only change while no gym
 * has ever held or redeemed the coupon; a changed locked field after
 * that is refused, never silently ignored.
 */
export async function updateCoupon(db, couponId, input, adminId) {
  const before = await getCoupon(db, couponId);
  if (!before) throw new CouponError(404, 'not_found', 'Coupon not found.');
  const v = await normalizeInput(db, input);

  if (before.has_activity) {
    const changed = LOCKED_AFTER_USE.filter((f) => {
      const a = before[f] == null ? null : (typeof before[f] === 'number' ? round2(before[f]) : before[f]);
      const b = v[f] == null ? null : (typeof v[f] === 'number' ? round2(v[f]) : v[f]);
      return a !== b;
    });
    if (changed.length) {
      throw new CouponError(409, 'field_locked',
        `This coupon has already been used, so these can no longer change: ${changed.join(', ')}. Create a new coupon instead.`,
        { fields: changed });
    }
  }
  if (v.code !== before.code) {
    const dup = await db.q1('SELECT id FROM coupons WHERE code = ? AND id <> ?', [v.code, couponId]);
    if (dup) throw new CouponError(409, 'duplicate_code', `A coupon with the code ${v.code} already exists.`);
  }
  if (v.max_redemptions != null && v.max_redemptions < before.redemption_count) {
    throw new CouponError(422, 'invalid_limits', `This coupon has already been redeemed ${before.redemption_count} times; the limit cannot be lower than that.`);
  }

  const ts = now();
  const toggled = !!v.is_enabled !== before.is_enabled;
  await db.run(
    `UPDATE coupons SET code = ?, internal_name = ?, description = ?, discount_type = ?, discount_value = ?, max_discount_amount = ?,
        minimum_purchase_amount = ?, customer_type = ?, applicable_kinds_json = ?, applicable_tiers_json = ?, applicable_durations_json = ?,
        starts_at = ?, expires_at = ?, timezone = ?, max_redemptions = ?, max_redemptions_per_customer = ?, first_time_only = ?,
        allow_stacking = ?, is_enabled = ?, founder_notes = ?, updated_by = ?, updated_at = ?,
        disabled_at = ?, disabled_by = ?
      WHERE id = ?`,
    [v.code, v.internal_name, v.description, v.discount_type, v.discount_value, v.max_discount_amount,
     v.minimum_purchase_amount, v.customer_type, v.applicable_kinds_json, v.applicable_tiers_json, v.applicable_durations_json,
     v.starts_at, v.expires_at, v.timezone, v.max_redemptions, v.max_redemptions_per_customer, v.first_time_only,
     v.allow_stacking, v.is_enabled, v.founder_notes, adminId, ts,
     v.is_enabled ? null : (toggled ? ts : before.disabled_at), v.is_enabled ? null : (toggled ? adminId : before.disabled_by),
     couponId]);
  const after = await getCoupon(db, couponId);
  return { before, after };
}

/** The immediate kill switch (and its undo). Takes effect on the very
 *  next Apply and the very next /payment/order -- both re-read the row.
 *  A gym already mid-payment at the discounted price keeps it: they
 *  will have paid it, and that payment is recorded as it really was. */
export async function setCouponEnabled(db, couponId, enabled, adminId) {
  const before = await getCoupon(db, couponId);
  if (!before) throw new CouponError(404, 'not_found', 'Coupon not found.');
  const ts = now();
  await db.run(
    `UPDATE coupons SET is_enabled = ?, disabled_at = ?, disabled_by = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    [enabled ? 1 : 0, enabled ? null : ts, enabled ? null : adminId, adminId, ts, couponId]);
  return { before, after: await getCoupon(db, couponId) };
}

/** Only a coupon nobody has ever held or redeemed can be deleted --
 *  anything with history must be disabled instead, so the redemption
 *  ledger never loses the coupon it points at (and coupon_redemptions'
 *  FK has no ON DELETE action, so the database refuses it too). */
export async function deleteCoupon(db, couponId) {
  const before = await getCoupon(db, couponId);
  if (!before) throw new CouponError(404, 'not_found', 'Coupon not found.');
  if (before.has_activity) {
    throw new CouponError(409, 'coupon_in_use', 'This coupon has been used, so it cannot be deleted. Disable it instead — its history is kept.');
  }
  await db.run('DELETE FROM coupons WHERE id = ?', [couponId]);
  return { before };
}

// ============================================================
// LIST / DASHBOARD
// ============================================================
const SORTS = {
  created_at: 'x.created_at', code: 'x.code', starts_at: 'x.starts_at', expires_at: 'x.expires_at',
  redemption_count: 'x.redemption_count', status: 'x.status', discount_value: 'x.discount_value',
};

export async function listCoupons(db, { search, status, customerType, createdFrom, createdTo, sort = 'created_at', dir = 'desc', limit = 25, offset = 0 } = {}) {
  await sweepExpiredReservations(db, {});
  const nowIso = now();
  const conds = [];
  const params = [];
  if (search) {
    const like = `%${String(search).trim().toUpperCase().slice(0, 64)}%`;
    conds.push('(x.code LIKE ? OR UPPER(x.internal_name) LIKE ?)');
    params.push(like, like);
  }
  if (status) { conds.push('x.status = ?'); params.push(status); }
  if (customerType) { conds.push('x.customer_type = ?'); params.push(customerType); }
  // Creation-date filters are calendar days in IST (the founders' own
  // day), converted to UTC bounds here rather than compared as UTC
  // dates, which would put 12:00–5:29 AM IST on the previous day.
  if (createdFrom) {
    const ms = zonedToUtcMs(createdFrom, '00:00', DEFAULT_COUPON_TZ);
    if (ms != null) { conds.push('x.created_at >= ?'); params.push(new Date(ms).toISOString()); }
  }
  if (createdTo) {
    const ms = zonedToUtcMs(createdTo, '00:00', DEFAULT_COUPON_TZ);
    if (ms != null) { conds.push('x.created_at < ?'); params.push(new Date(ms + 86_400_000).toISOString()); }
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sortCol = SORTS[sort] || SORTS.created_at;
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
  const inner = `SELECT c.*, ${couponStatusSql('c')} AS status, u.name AS created_by_name
                   FROM coupons c LEFT JOIN users u ON u.id = c.created_by`;
  const lim = Math.min(100, Math.max(1, Number(limit) || 25));
  const off = Math.max(0, Number(offset) || 0);
  const [rows, totalRow] = await Promise.all([
    db.q(`SELECT * FROM (${inner}) x ${where} ORDER BY ${sortCol} ${sortDir}, x.id ASC LIMIT ? OFFSET ?`, [nowIso, nowIso, ...params, lim, off]),
    db.q1(`SELECT COUNT(*) AS n FROM (${inner}) x ${where}`, [nowIso, nowIso, ...params]),
  ]);
  return { coupons: rows.map((r) => serializeCoupon(r, nowIso)), total: Number(totalRow?.n || 0), limit: lim, offset: off };
}

export async function getCouponDashboard(db) {
  await sweepExpiredReservations(db, {});
  const nowIso = now();
  const [byStatus, redeemed, revenue, planRevenue, refunded] = await Promise.all([
    db.q(`SELECT status, COUNT(*) AS n FROM (SELECT ${couponStatusSql('c')} AS status FROM coupons c) x GROUP BY status`, [nowIso, nowIso]),
    db.q1(
      `SELECT COUNT(*) AS n, COALESCE(SUM(cr.discount_amount), 0) AS discount,
              COALESCE(SUM(CASE WHEN o.type = 'independent' THEN 1 ELSE 0 END), 0) AS independent
         FROM coupon_redemptions cr JOIN organizations o ON o.id = cr.org_id WHERE cr.status = 'REDEEMED'`),
    // Revenue is counted once per ORDER (a stacked purchase has one row
    // per coupon), from the order's own verified amount: gym purchases in
    // payment_orders, Barbell plans in barbell_plan_orders.
    db.q1(`SELECT COUNT(*) AS n, COALESCE(SUM(po.amount), 0) AS total FROM payment_orders po
            WHERE EXISTS (SELECT 1 FROM coupon_redemptions cr WHERE cr.payment_order_id = po.id AND cr.status = 'REDEEMED')`),
    db.q1(`SELECT COUNT(*) AS n, COALESCE(SUM(bpo.amount), 0) AS total,
                  COALESCE(SUM(CASE WHEN bpo.status = 'REFUNDED' THEN bpo.amount ELSE 0 END), 0) AS refunded
             FROM barbell_plan_orders bpo
            WHERE EXISTS (SELECT 1 FROM coupon_redemptions cr WHERE cr.plan_order_id = bpo.id AND cr.status = 'REDEEMED')`),
    db.q1(`SELECT COALESCE(SUM(rf.amount), 0) AS total FROM refunds rf
            WHERE rf.status = 'SUCCESS'
              AND EXISTS (SELECT 1 FROM coupon_redemptions cr WHERE cr.payment_order_id = rf.payment_order_id AND cr.status = 'REDEEMED')`),
  ]);
  const counts = { ACTIVE: 0, SCHEDULED: 0, EXPIRED: 0, DISABLED: 0, EXHAUSTED: 0 };
  let total = 0;
  for (const r of byStatus) { counts[r.status] = Number(r.n || 0); total += Number(r.n || 0); }
  const gross = round2(Number(revenue?.total || 0) + Number(planRevenue?.total || 0));
  const refundedTotal = round2(Number(refunded?.total || 0) + Number(planRevenue?.refunded || 0));
  const redemptions = Number(redeemed?.n || 0);
  const independent = Number(redeemed?.independent || 0);
  return {
    totalCoupons: total,
    active: counts.ACTIVE,
    scheduled: counts.SCHEDULED,
    expired: counts.EXPIRED,
    disabled: counts.DISABLED,
    exhausted: counts.EXHAUSTED,
    successfulRedemptions: redemptions,
    enterpriseRedemptions: redemptions - independent,
    independentRedemptions: independent,
    discountedOrders: Number(revenue?.n || 0) + Number(planRevenue?.n || 0),
    totalDiscountGiven: round2(Number(redeemed?.discount || 0)),
    grossRevenue: gross,
    refundedRevenue: refundedTotal,
    netRevenue: round2(gross - refundedTotal),
  };
}

// ============================================================
// PER-COUPON ANALYTICS + REDEMPTION HISTORY
// ============================================================
export async function getCouponAnalytics(db, couponId) {
  await sweepExpiredReservations(db, { couponId });
  const coupon = await getCoupon(db, couponId);
  if (!coupon) return null;
  const [agg, holds, refunded] = await Promise.all([
    db.q1(
      `SELECT COUNT(*) AS redemptions, COUNT(DISTINCT ${CUSTOMER_KEY_SQL}) AS customers,
              COALESCE(SUM(cr.discount_amount), 0) AS discount, COALESCE(SUM(cr.original_amount), 0) AS original,
              COALESCE(SUM(cr.final_amount), 0) AS collected,
              COALESCE(SUM(CASE WHEN o.type = 'independent' THEN 1 ELSE 0 END), 0) AS independent,
              COALESCE(SUM(CASE WHEN o.type = 'independent' THEN 0 ELSE 1 END), 0) AS enterprise,
              COALESCE(SUM(cr.late_confirmation), 0) AS late
         FROM coupon_redemptions cr JOIN organizations o ON o.id = cr.org_id
        WHERE cr.coupon_id = ? AND cr.status = 'REDEEMED'`, [couponId]),
    db.q(`SELECT CASE WHEN release_reason = ? THEN 'HELD' ELSE status END AS status, COUNT(*) AS n
            FROM coupon_redemptions WHERE coupon_id = ? AND status <> 'REDEEMED'
           GROUP BY CASE WHEN release_reason = ? THEN 'HELD' ELSE status END`, [HELD_FOR_REVIEW, couponId, HELD_FOR_REVIEW]),
    db.q1(
      `SELECT (SELECT COALESCE(SUM(rf.amount), 0) FROM refunds rf
                WHERE rf.status = 'SUCCESS'
                  AND EXISTS (SELECT 1 FROM coupon_redemptions cr WHERE cr.coupon_id = ? AND cr.status = 'REDEEMED' AND cr.payment_order_id = rf.payment_order_id))
            + (SELECT COALESCE(SUM(bpo.amount), 0) FROM barbell_plan_orders bpo
                WHERE bpo.status = 'REFUNDED'
                  AND EXISTS (SELECT 1 FROM coupon_redemptions cr WHERE cr.coupon_id = ? AND cr.status = 'REDEEMED' AND cr.plan_order_id = bpo.id)) AS total`,
      [couponId, couponId]),
  ]);
  const holdCounts = { RESERVED: 0, RELEASED: 0, EXPIRED: 0, HELD: 0 };
  for (const h of holds) holdCounts[h.status] = Number(h.n || 0);
  const collected = round2(Number(agg?.collected || 0));
  return {
    coupon,
    analytics: {
      successfulRedemptions: Number(agg?.redemptions || 0),
      remainingRedemptions: coupon.remaining_redemptions,
      inFlight: holdCounts.RESERVED,
      abandonedOrFailed: holdCounts.RELEASED + holdCounts.EXPIRED,
      // Paid after the hold ended with no use left: not activated, waiting
      // for a founder (Reconciliation). Never counted as a redemption.
      heldForReview: holdCounts.HELD,
      lateConfirmations: Number(agg?.late || 0),
      totalDiscount: round2(Number(agg?.discount || 0)),
      totalOriginalValue: round2(Number(agg?.original || 0)),
      totalRevenueCollected: collected,
      refundedRevenue: round2(Number(refunded?.total || 0)),
      uniqueCustomers: Number(agg?.customers || 0),
      enterpriseRedemptions: Number(agg?.enterprise || 0),
      independentRedemptions: Number(agg?.independent || 0),
    },
  };
}

export async function listCouponRedemptions(db, couponId, { status = 'REDEEMED', limit = 25, offset = 0 } = {}) {
  const statusFilter = ['REDEEMED', 'RESERVED', 'RELEASED', 'EXPIRED'].includes(status) ? status : null; // 'ALL' -> null
  const lim = Math.min(5000, Math.max(1, Number(limit) || 25));
  const off = Math.max(0, Number(offset) || 0);
  const where = `cr.coupon_id = ? ${statusFilter ? 'AND cr.status = ?' : ''}`;
  const params = statusFilter ? [couponId, statusFilter] : [couponId];
  const [rows, totalRow] = await Promise.all([
    db.q(
      `SELECT cr.id, cr.status, cr.org_id, o.name AS org_name, o.type AS org_type,
              cr.user_id, cu.name AS customer_name, cr.plan_order_id,
              cr.subject_type, cr.subject_id, cr.payment_order_id, cr.original_amount, cr.discount_amount, cr.final_amount,
              cr.currency, cr.late_confirmation, cr.reserved_at, cr.redeemed_at, cr.released_at, cr.release_reason, cr.created_at,
              COALESCE(po.status, bpo.status) AS order_status,
              COALESCE(po.provider, bpo.provider) AS provider,
              COALESCE(po.provider_order_id, bpo.provider_order_id) AS provider_order_id,
              COALESCE((SELECT pt.provider_payment_id FROM payment_transactions pt
                 WHERE pt.order_id = cr.payment_order_id AND pt.status = 'SUCCESS' ORDER BY pt.created_at DESC LIMIT 1),
                 bpo.provider_payment_id) AS provider_payment_id,
              COALESCE((SELECT inv.invoice_number FROM invoices inv WHERE inv.order_id = cr.payment_order_id LIMIT 1),
                 bpo.invoice_number) AS invoice_number
         FROM coupon_redemptions cr
         JOIN organizations o ON o.id = cr.org_id
         LEFT JOIN users cu ON cu.id = cr.user_id
         LEFT JOIN payment_orders po ON po.id = cr.payment_order_id
         LEFT JOIN barbell_plan_orders bpo ON bpo.id = cr.plan_order_id
        WHERE ${where}
        ORDER BY COALESCE(cr.redeemed_at, cr.created_at) DESC, cr.id ASC
        LIMIT ? OFFSET ?`, [...params, lim, off]),
    db.q1(`SELECT COUNT(*) AS n FROM coupon_redemptions cr WHERE ${where}`, params),
  ]);
  return {
    redemptions: rows.map((r) => ({
      ...r,
      customer_type: r.org_type === 'independent' ? 'INDEPENDENT' : 'ENTERPRISE',
      // A plan was bought by a person, not the shared 'independent' org.
      customer_name: r.subject_type === 'BARBELL_PLAN' ? (r.customer_name || 'Deleted account') : r.org_name,
      original_amount: Number(r.original_amount), discount_amount: Number(r.discount_amount), final_amount: Number(r.final_amount),
      late_confirmation: !!Number(r.late_confirmation),
    })),
    total: Number(totalRow?.n || 0), limit: lim, offset: off,
  };
}
