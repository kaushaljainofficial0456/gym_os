// ============================================================
// THE BARBELL PLAN -- what an independent client (no gym) pays Barbell.
//
// Everything is free for 14 days, then it takes a plan: ₹59 a month, or
// ₹590 a year ("pay for 10 months, get 2 free"). Prices come from
// BARBELL_PLAN_MONTHLY / BARBELL_PLAN_YEARLY so they can change without a
// release. Gym members never see any of this: their gym is what they pay.
//
// The trial counts from the latest of: signing up, leaving a gym (someone
// who trained at a gym and goes solo gets their own 14 days), and the
// first time the plan was checked for them (users.plan_trial_from, set
// once), so nobody who already used Barbell is locked out the day this
// ships, whenever that is.
//
// The payment goes to Barbell's own Razorpay account, with no transfer:
// this money is Barbell's, unlike a gym membership.
//
// COUPONS (founder-issued, see services/coupons/couponEngine.js and
// docs/COUPONS.md) work here the way they work on a gym's checkout, with
// the plan order as the price lock in place of a billing quote:
//   POST /plan/quote  prices the plan with the codes -- nothing is held.
//   POST /plan/order  re-prices on the server, stores the original price,
//                     the discount and the coupons on the order, HOLDS
//                     each coupon, and only then asks the gateway for the
//                     discounted amount (never below ₹1).
//   verified payment  the order turns SUCCESS and its coupons REDEEMED in
//                     one transaction, whichever of the checkout signature
//                     and the webhook arrives first.
//   failed/cancelled  the hold is given back (the order stays payable).
//   abandoned         the hold expires after RESERVATION_TTL_MS.
// ============================================================
import { id, now } from '../../ids.js';
import { track } from '../events.js';
import { createProviderOrder, verifyCheckoutSignature, providerName } from '../payments/paymentProvider.js';
import {
  priceWithCoupons, reservePlanOrderCoupons, releasePlanOrderCoupons, redeemPlanOrderCoupons,
  planOrderCouponLines, successMessage, round2,
} from '../coupons/couponEngine.js';

export const TRIAL_DAYS = 14;
const DAY = 86_400_000;

const price = (envName, fallback) => {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

export function plans() {
  const monthly = price('BARBELL_PLAN_MONTHLY', 59);
  const yearly = price('BARBELL_PLAN_YEARLY', 590);
  return {
    monthly: { id: 'monthly', name: 'Monthly', amount: monthly, currency: 'INR', days: 30, line: 'Billed every month' },
    yearly: {
      id: 'yearly', name: 'Yearly', amount: yearly, currency: 'INR', days: 365,
      line: yearly < monthly * 12 ? 'Pay for 10 months, get 2 free' : 'Billed every year',
    },
  };
}

/**
 * Whether this signed-in person is an independent client at all: a client
 * in THE shared independent org (slug 'independent', as the app itself
 * checks). Type alone is not enough: /auth/setup-org accepts
 * type 'independent' for a trainer's own org, and that trainer's clients
 * pay the trainer, not Barbell.
 */
export async function isIndependentClient(db, user) {
  if (!user || user.role !== 'CLIENT' || !user.org) return false;
  const org = await db.q1('SELECT type, slug FROM organizations WHERE id = ?', [user.org]);
  return org?.type === 'independent' && org?.slug === 'independent';
}

async function trialStart(db, userId) {
  const user = await db.q1('SELECT created_at, plan_trial_from FROM users WHERE id = ?', [userId]);
  let first = user?.plan_trial_from;
  if (user && !first) {
    first = now();
    await db.run('UPDATE users SET plan_trial_from = ? WHERE id = ? AND plan_trial_from IS NULL', [first, userId]);
  }
  const left = await db.q1(
    `SELECT MAX(p.left_at) AS left_at FROM client_gym_periods p JOIN clients c ON c.id = p.client_id
      WHERE c.user_id = ? AND p.left_at IS NOT NULL`, [userId]);
  const times = [user?.created_at, left?.left_at, first].map((t) => Date.parse(t || '')).filter(Number.isFinite);
  return new Date(Math.max(...times));
}

/** Where an independent client stands: on trial, paid up, or locked. */
export async function planStatus(db, userId) {
  const start = await trialStart(db, userId);
  const trialEnds = new Date(start.getTime() + TRIAL_DAYS * DAY);
  const paid = await db.q1(
    `SELECT MAX(period_end) AS until FROM barbell_plan_orders WHERE user_id = ? AND status = 'SUCCESS'`, [userId]);
  const paidUntil = paid?.until ? new Date(paid.until) : null;
  const t = Date.now();
  const access = paidUntil && paidUntil.getTime() > t ? 'active' : trialEnds.getTime() > t ? 'trial' : 'locked';
  return {
    access,
    trialEndsAt: trialEnds.toISOString(),
    trialDaysLeft: Math.max(0, Math.ceil((trialEnds.getTime() - t) / DAY)),
    paidUntil: paidUntil ? paidUntil.toISOString() : null,
  };
}

// The gate asks on most requests, so the answer is held briefly per person
// and dropped the moment they pay.
const cache = new Map();
const CACHE_MS = 60_000;
export async function hasAccessCached(db, userId) {
  const hit = cache.get(userId);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.ok;
  const ok = (await planStatus(db, userId)).access !== 'locked';
  cache.set(userId, { ok, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return ok;
}
export function forgetAccess(userId) { cache.delete(userId); }

function planOrThrow(planId) {
  const plan = plans()[planId];
  if (!plan) {
    const err = new Error('Choose monthly or yearly.');
    err.status = 422;
    throw err;
  }
  return plan;
}

/**
 * What a plan costs this person, with coupon codes if they gave any. The
 * price comes from the plan table and the discount from the coupon engine
 * -- nothing in the request can set either. Holds nothing.
 * `orgId` is the person's own org, which is what makes them INDEPENDENT.
 * Returns { ok, plan, original, discount, total, currency, lines } or
 * { ok: false, coupon } with the engine's customer-facing refusal.
 */
export async function pricePlan(db, { userId, orgId, planId, couponCodes = null }) {
  const plan = planOrThrow(planId);
  const codes = Array.isArray(couponCodes) ? couponCodes : [];
  if (!codes.length) return { ok: true, plan, original: plan.amount, discount: 0, total: plan.amount, currency: plan.currency, lines: [] };
  const priced = await priceWithCoupons(db, {
    orgId, userId, kind: 'BARBELL_PLAN', durationDays: plan.days, amount: plan.amount, currency: plan.currency, codes,
  });
  if (!priced.ok) return { ok: false, coupon: priced };
  return { ok: true, plan, original: priced.subtotal, discount: priced.discount, total: priced.total, currency: plan.currency, lines: priced.lines };
}

/** The checkout summary, in the same shape quotes.js's quotePricing()
 *  gives a gym checkout, so one coupon UI renders both. Founder-only
 *  fields never appear: coupon lines are publicCouponLine() output,
 *  minus the internal coupon id. */
export function planPricing({ plan, original, discount, total, currency, lines }) {
  const coupons = (lines || []).map(({ couponId, ...pub }) => pub); // eslint-disable-line no-unused-vars
  const d = round2(Number(discount || 0));
  return {
    plan: plan?.id ?? null,
    originalAmount: round2(Number(original)),
    credit: 0,
    subtotal: round2(Number(original)),
    discount: d,
    total: round2(Number(total)),
    currency,
    coupons,
    savings: d,
    message: coupons.length ? successMessage(coupons, d) : null,
  };
}

/** The same summary for a STORED order -- what it was actually priced
 *  at, never re-derived from today's coupons or prices. */
export function planOrderPricing(order) {
  const discount = Number(order.discount_amount || 0);
  const total = Number(order.amount);
  const original = order.original_amount != null ? Number(order.original_amount) : round2(total + discount);
  return planPricing({ plan: { id: order.plan }, original, discount, total, currency: order.currency, lines: planOrderCouponLines(order) });
}

/**
 * A purchase attempt for a plan, with its gateway order. Prices it again
 * here (what /plan/quote showed is never trusted), stores what it was
 * priced at, holds its coupons, and asks the gateway for exactly the
 * discounted amount. The row is written before the gateway order because
 * a coupon hold references it; if anything after that fails, the holds
 * are given back and the row is CANCELLED (no gateway order exists, so
 * nothing could ever be paid against it).
 *
 * Returns { ok: true, order, pricing }, or { ok: false, error, coupon }
 * where error is 'coupon_invalid' (the code does not apply) or
 * 'coupon_unavailable' (it applied when priced, but not any more).
 */
export async function createPlanOrder(db, userId, planId, { orgId = null, couponCodes = null } = {}) {
  const priced = await pricePlan(db, { userId, orgId, planId, couponCodes });
  if (!priced.ok) return { ok: false, error: 'coupon_invalid', coupon: priced.coupon };
  const { plan } = priced;
  const orderId = id('bpo');
  const nowIso = now();
  await db.run(
    `INSERT INTO barbell_plan_orders (id, user_id, plan, amount, original_amount, discount_amount, coupons_json, currency, provider, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?)`,
    [orderId, userId, planId, priced.total, priced.original, priced.discount,
     priced.lines.length ? JSON.stringify(priced.lines) : null, plan.currency, providerName(), nowIso, nowIso]);
  const giveUp = async (reason) => {
    await releasePlanOrderCoupons(db, orderId, reason).catch(() => {});
    await db.run(`UPDATE barbell_plan_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'CREATED'`, [now(), orderId]).catch(() => {});
  };

  if (priced.lines.length) {
    const row = await db.q1('SELECT * FROM barbell_plan_orders WHERE id = ?', [orderId]);
    const held = await reservePlanOrderCoupons(db, { planOrder: row, orgId, durationDays: plan.days });
    if (!held.ok) {
      await giveUp('reservation_failed');
      return { ok: false, error: 'coupon_unavailable', coupon: held };
    }
  }
  try {
    const provider = await createProviderOrder({
      amount: priced.total, currency: plan.currency, receipt: orderId, notes: { subjectType: 'BARBELL_PLAN', plan: planId, userId },
    });
    await db.run(`UPDATE barbell_plan_orders SET provider = ?, provider_order_id = ?, updated_at = ? WHERE id = ?`,
      [provider.provider, provider.providerOrderId, now(), orderId]);
  } catch (e) {
    await giveUp('order_creation_failed');
    throw e;
  }
  const order = await db.q1('SELECT * FROM barbell_plan_orders WHERE id = ?', [orderId]);
  return { ok: true, order, pricing: planOrderPricing(order) };
}

/**
 * The buyer closed the checkout without paying: hand this order's coupon
 * holds back now, rather than in RESERVATION_TTL_MS, so they can try
 * again straight away (a once-per-customer coupon would otherwise read
 * as already used). The order itself stays CREATED and payable -- a UPI
 * approval that lands after the sheet closed still grants the plan, and
 * its coupon is then recorded as a late confirmation.
 */
export async function releasePlanCheckout(db, userId, orderId) {
  const order = await db.q1('SELECT id, status FROM barbell_plan_orders WHERE id = ? AND user_id = ?', [orderId, userId]);
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }
  if (order.status !== 'CREATED') return { released: 0 };
  return { released: await releasePlanOrderCoupons(db, order.id, 'checkout_closed') };
}

/**
 * Confirms a plan payment from Checkout's signed result and extends access:
 * from the end of the time already paid for, or from now if that has run
 * out, so paying early never loses days. Idempotent: confirming the same
 * order twice changes nothing the second time.
 */
export async function confirmPlanPayment(db, userId, { orderId, providerPaymentId, signature }) {
  const order = await db.q1('SELECT * FROM barbell_plan_orders WHERE id = ? AND user_id = ?', [orderId, userId]);
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }
  if (order.status === 'SUCCESS') return order;
  if (order.provider !== providerName() || !verifyCheckoutSignature({ providerOrderId: order.provider_order_id, providerPaymentId, signature })) {
    const e = new Error('This payment could not be verified. You have not been charged twice; contact support if money left your account.');
    e.status = 422;
    throw e;
  }
  return activatePlanOrder(db, order, { providerPaymentId });
}

/**
 * The one step that turns a paid plan order into time: from the end of the
 * time already paid for, or from now if that has run out. Shared by the
 * app's own confirmation above and the Razorpay webhook below; whichever
 * arrives first wins, and the other changes nothing.
 *
 * The order's coupons are redeemed in the SAME transaction, and only by
 * the call whose guarded UPDATE actually confirmed the order -- so a
 * duplicate webhook, or the webhook racing the app, counts a coupon once.
 */
async function activatePlanOrder(db, order, { providerPaymentId }) {
  const plan = plans()[order.plan];
  const number = `BBL-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  let redeemed = 0;
  await db.tx(async (tx) => {
    const current = await tx.q1(`SELECT MAX(period_end) AS until FROM barbell_plan_orders WHERE user_id = ? AND status = 'SUCCESS'`, [order.user_id]);
    const from = Math.max(Date.now(), Date.parse(current?.until || '') || 0);
    const start = new Date(from).toISOString();
    const end = new Date(from + plan.days * DAY).toISOString();
    // WHERE status = 'CREATED': if the other path got here first, this
    // changes no rows and its result is the one that stands.
    const upd = await tx.run(
      `UPDATE barbell_plan_orders SET status = 'SUCCESS', provider_payment_id = ?, period_start = ?, period_end = ?, invoice_number = ?, updated_at = ?
        WHERE id = ? AND status = 'CREATED'`,
      [providerPaymentId, start, end, number, now(), order.id]);
    if (upd.changes === 1) redeemed = await redeemPlanOrderCoupons(tx, order);
  });
  forgetAccess(order.user_id);
  if (redeemed) {
    await track(db, { type: 'coupon_redeemed', userId: order.user_id, data: { planOrderId: order.id, count: redeemed } }).catch(() => {});
  }
  return db.q1('SELECT * FROM barbell_plan_orders WHERE id = ?', [order.id]);
}

/**
 * THE BACKUP: Razorpay's signed webhook for a plan order. Someone who pays
 * and closes the app before it confirms still gets their time, because
 * Razorpay tells the server directly. The signature is already checked by
 * the caller (recordWebhookEvent). Only a successful payment grants
 * time. A failed attempt on an order can still be followed by a
 * successful one, so the order itself stays as it is -- but a failed,
 * cancelled or disputed payment gives its coupon holds back, the same as
 * a gym's (a later success on the order is still recorded, as a late
 * confirmation).
 */
export async function confirmPlanFromWebhook(db, order, { status, providerPaymentId, amount, currency }) {
  if (status !== 'SUCCESS') {
    let couponsReleased = 0;
    if (order.status === 'CREATED' && ['FAILED', 'CANCELLED', 'DISPUTED'].includes(status)) {
      couponsReleased = await releasePlanOrderCoupons(db, order.id, `payment_${status.toLowerCase()}`);
    }
    return { ok: true, plan: true, ignored: status, couponsReleased };
  }
  if (order.status === 'SUCCESS') return { ok: true, plan: true, duplicate: true };
  if (order.status !== 'CREATED') return { ok: false, plan: true, reason: 'plan_order_not_payable', orderStatus: order.status };
  if ((amount != null && Math.abs(amount - Number(order.amount)) > 0.01) || (currency && currency !== order.currency)) {
    // Never grant time for a payment that does not match what was asked.
    // The raw event is kept in payment_events for whoever looks into it.
    console.error(`[plan] webhook amount/currency mismatch on ${order.id}: got ${amount} ${currency}, expected ${order.amount} ${order.currency}`);
    await releasePlanOrderCoupons(db, order.id, 'payment_disputed');
    return { ok: false, plan: true, reason: 'amount_or_currency_mismatch' };
  }
  const done = await activatePlanOrder(db, order, { providerPaymentId });
  return { ok: true, plan: true, activated: done?.status === 'SUCCESS' };
}

/** A paid order as its receipt (BBL-...) shows it: the price before
 *  coupons, each coupon and what it took off, and what was paid -- all
 *  from the order's own snapshot, so editing or disabling a coupon later
 *  never changes a receipt. Orders from before coupons show no lines. */
export function planReceipt(order) {
  const p = planOrderPricing(order);
  return {
    id: order.id, plan: order.plan, amount: Number(order.amount), currency: order.currency,
    originalAmount: p.originalAmount, discount: p.discount,
    coupons: p.coupons.map((c) => ({ code: c.code, discountType: c.discountType, discountValue: c.discountValue, discountAmount: c.discountAmount })),
    periodStart: order.period_start, periodEnd: order.period_end, number: order.invoice_number,
  };
}

export async function paidPlanOrders(db, userId) {
  return db.q(
    `SELECT id, plan, amount, original_amount, discount_amount, coupons_json, currency, status, period_start, period_end, invoice_number, updated_at
       FROM barbell_plan_orders WHERE user_id = ? AND status = 'SUCCESS' ORDER BY period_end DESC LIMIT 50`, [userId]);
}
