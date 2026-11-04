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
// ============================================================
import { id, now } from '../../ids.js';
import { createProviderOrder, verifyCheckoutSignature, providerName } from '../payments/paymentProvider.js';

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

/** A purchase attempt for a plan, with its gateway order. */
export async function createPlanOrder(db, userId, planId) {
  const plan = plans()[planId];
  if (!plan) {
    const err = new Error('Choose monthly or yearly.');
    err.status = 422;
    throw err;
  }
  const orderId = id('bpo');
  const provider = await createProviderOrder({ amount: plan.amount, currency: plan.currency, receipt: orderId, notes: { subjectType: 'BARBELL_PLAN', plan: planId, userId } });
  const nowIso = now();
  await db.run(
    `INSERT INTO barbell_plan_orders (id, user_id, plan, amount, currency, provider, provider_order_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?)`,
    [orderId, userId, planId, plan.amount, plan.currency, provider.provider, provider.providerOrderId, nowIso, nowIso]);
  return db.q1('SELECT * FROM barbell_plan_orders WHERE id = ?', [orderId]);
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
 */
async function activatePlanOrder(db, order, { providerPaymentId }) {
  const plan = plans()[order.plan];
  const current = await db.q1(`SELECT MAX(period_end) AS until FROM barbell_plan_orders WHERE user_id = ? AND status = 'SUCCESS'`, [order.user_id]);
  const from = Math.max(Date.now(), Date.parse(current?.until || '') || 0);
  const start = new Date(from).toISOString();
  const end = new Date(from + plan.days * DAY).toISOString();
  const number = `BBL-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  // WHERE status = 'CREATED': if the other path got here first, this
  // changes no rows and its result is the one that stands.
  await db.run(
    `UPDATE barbell_plan_orders SET status = 'SUCCESS', provider_payment_id = ?, period_start = ?, period_end = ?, invoice_number = ?, updated_at = ?
      WHERE id = ? AND status = 'CREATED'`,
    [providerPaymentId, start, end, number, now(), order.id]);
  forgetAccess(order.user_id);
  return db.q1('SELECT * FROM barbell_plan_orders WHERE id = ?', [order.id]);
}

/**
 * THE BACKUP: Razorpay's signed webhook for a plan order. Someone who pays
 * and closes the app before it confirms still gets their time, because
 * Razorpay tells the server directly. The signature is already checked by
 * the caller (recordWebhookEvent). Only a successful payment does
 * anything; a failed attempt on an order can still be followed by a
 * successful one, so it changes nothing here.
 */
export async function confirmPlanFromWebhook(db, order, { status, providerPaymentId, amount, currency }) {
  if (status !== 'SUCCESS') return { ok: true, plan: true, ignored: status };
  if (order.status === 'SUCCESS') return { ok: true, plan: true, duplicate: true };
  if (order.status !== 'CREATED') return { ok: false, plan: true, reason: 'plan_order_not_payable', orderStatus: order.status };
  if ((amount != null && Math.abs(amount - Number(order.amount)) > 0.01) || (currency && currency !== order.currency)) {
    // Never grant time for a payment that does not match what was asked.
    // The raw event is kept in payment_events for whoever looks into it.
    console.error(`[plan] webhook amount/currency mismatch on ${order.id}: got ${amount} ${currency}, expected ${order.amount} ${order.currency}`);
    return { ok: false, plan: true, reason: 'amount_or_currency_mismatch' };
  }
  const done = await activatePlanOrder(db, order, { providerPaymentId });
  return { ok: true, plan: true, activated: done?.status === 'SUCCESS' };
}

export async function paidPlanOrders(db, userId) {
  return db.q(
    `SELECT id, plan, amount, currency, status, period_start, period_end, invoice_number, updated_at
       FROM barbell_plan_orders WHERE user_id = ? AND status = 'SUCCESS' ORDER BY period_end DESC LIMIT 50`, [userId]);
}
