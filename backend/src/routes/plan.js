// ============================================================
// /api/plan -- the Barbell plan for independent clients (see
// services/plans/barbellPlan.js): where they stand, buying a month or a
// year, and the receipts for it. Plus the gate that holds the rest of the
// app once a trial has run out and nothing has been paid.
// ============================================================
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { JWT_ALGORITHM, requireAuth } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import {
  confirmPlanPayment, createPlanOrder, hasAccessCached, isIndependentClient, paidPlanOrders, planStatus, plans,
  pricePlan, planPricing, planReceipt, releasePlanCheckout,
} from '../services/plans/barbellPlan.js';
import { MAX_STACKED_COUPONS } from '../services/coupons/couponEngine.js';
import { renderPlanReceiptPdf } from '../services/payments/invoicePdf.js';
import { track } from '../services/events.js';

const NOT_INDEPENDENT = { error: 'not_independent', message: 'Your gym membership already covers Barbell.' };
const couponCodes = z.array(z.string().trim().min(1).max(40)).max(MAX_STACKED_COUPONS).optional();

export default function planRoutes(db) {
  const r = Router();
  r.use(requireAuth);
  const limit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });
  // Coupon attempts: the same 8-per-10-minutes-per-person limit as a gym's
  // checkout, so guessing codes is slow. Not the gym checkout's per-ORG
  // limit as well: every Independent client shares one org, so that would
  // let a handful of people use up everyone's attempts.
  const couponUserLimit = rateLimit({ windowMs: 10 * 60_000, max: 8, keyFn: (req) => `cu:${req.user?.sub || 'anon'}` });
  const couponAttemptLimit = (req, res, next) => {
    const codes = req.body?.couponCodes;
    if (!Array.isArray(codes) || !codes.length) return next();
    return couponUserLimit(req, res, next);
  };
  const refuseCoupon = async (req, res, status, error, coupon) => {
    // Logged (code + reason only) so abuse patterns are reviewable; the
    // response carries only the customer-facing reason.
    await track(db, {
      type: 'coupon_rejected', orgId: req.user.org || null, userId: req.user.sub,
      data: { code: coupon.code, reason: coupon.reason, kind: 'BARBELL_PLAN' },
    }).catch(() => {});
    return res.status(status).json({ error, reason: coupon.reason, code: coupon.code, message: coupon.message });
  };

  r.get('/status', async (req, res) => {
    const independent = await isIndependentClient(db, req.user);
    if (!independent) return res.json({ applies: false });
    const status = await planStatus(db, req.user.sub);
    const receipts = await paidPlanOrders(db, req.user.sub);
    res.json({
      applies: true,
      ...status,
      plans: Object.values(plans()),
      receipts: receipts.map(planReceipt),
    });
  });

  // "Apply": prices the plan with the code(s) and says what it would
  // cost. Holds and consumes nothing -- that happens at /order, which
  // prices it all again rather than trusting anything shown here.
  r.post('/quote', limit, couponAttemptLimit, validate(z.object({
    plan: z.enum(['monthly', 'yearly']), couponCodes,
  })), async (req, res) => {
    if (!(await isIndependentClient(db, req.user))) return res.status(409).json(NOT_INDEPENDENT);
    const priced = await pricePlan(db, { userId: req.user.sub, orgId: req.user.org, planId: req.body.plan, couponCodes: req.body.couponCodes });
    if (!priced.ok) return refuseCoupon(req, res, 422, 'coupon_invalid', priced.coupon);
    res.json({ pricing: planPricing(priced) });
  });

  r.post('/order', limit, couponAttemptLimit, validate(z.object({
    plan: z.enum(['monthly', 'yearly']), couponCodes,
  })), async (req, res) => {
    if (!(await isIndependentClient(db, req.user))) return res.status(409).json(NOT_INDEPENDENT);
    const result = await createPlanOrder(db, req.user.sub, req.body.plan, { orgId: req.user.org, couponCodes: req.body.couponCodes });
    // coupon_unavailable: it applied when priced, but was disabled, expired
    // or used up since. The order fails rather than silently charging the
    // full price.
    if (!result.ok) return refuseCoupon(req, res, result.error === 'coupon_invalid' ? 422 : 409, result.error, result.coupon);
    res.json({ order: result.order, pricing: result.pricing });
  });

  // The checkout was closed without paying: give the order's coupon
  // holds back now instead of at their expiry (see releasePlanCheckout).
  r.post('/order/:id/cancel', limit, async (req, res) => {
    res.json(await releasePlanCheckout(db, req.user.sub, req.params.id));
  });

  r.post('/verify', limit, validate(z.object({
    orderId: z.string().min(1), providerPaymentId: z.string().min(1), signature: z.string().min(1),
  })), async (req, res) => {
    let order;
    try {
      order = await confirmPlanPayment(db, req.user.sub, req.body);
    } catch (e) {
      // Paid, but its coupon could no longer be honoured: no time was
      // granted, and a founder will refund or honour it (couponEngine.js).
      if (e.code === 'payment_held_for_review') return res.status(409).json({ error: e.code, message: e.message });
      throw e;
    }
    res.json({ order, status: await planStatus(db, req.user.sub) });
  });

  r.get('/receipts/:id/pdf', limit, async (req, res) => {
    const order = await db.q1(`SELECT * FROM barbell_plan_orders WHERE id = ? AND user_id = ? AND status = 'SUCCESS'`, [req.params.id, req.user.sub]);
    if (!order) return res.status(404).json({ error: 'Receipt not found' });
    const customer = await db.q1('SELECT name, email FROM users WHERE id = ?', [req.user.sub]);
    const plan = plans()[order.plan];
    const receipt = planReceipt(order);
    const pdf = await renderPlanReceiptPdf({
      number: order.invoice_number, customer, paidOn: order.updated_at, amount: receipt.amount,
      originalAmount: receipt.originalAmount, coupons: receipt.coupons,
      description: `Barbell plan (${plan?.name || order.plan})`,
      detail: `${String(order.period_start).slice(0, 10)} to ${String(order.period_end).slice(0, 10)}`,
      reference: order.provider_payment_id || order.provider_order_id,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${order.invoice_number}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  });

  return r;
}

/* What a locked account can still do: sign in and out, pay for a plan, see
   and leave its account (export, delete, settings), join a gym (which is
   another way to be covered), and the small reads every screen makes. */
const OPEN = [
  /^\/api\/auth\//, /^\/api\/plan\//, /^\/api\/payments\//, /^\/api\/receipts\//, /^\/api\/enrollment\//,
  /^\/api\/me\/(profile|export|delete-account|preferences|notification|announcements)/, /^\/api\/notifications\//,
  /^\/api\/client-error/, /^\/api\/health$/, /^\/api\/legal/, /^\/api\/share\//, /^\/api\/workout-share\//,
  /^\/api\/community-invite\//, /^\/api\/tournaments-public\//,
];

/**
 * Holds an independent client's requests once their trial is over and no
 * plan is paid: 402 plan_required, which the app answers with the plans
 * screen. Anyone else, any open path, and any request without a valid
 * session passes straight through (requireAuth still decides those).
 */
export function planGate(db) {
  return async (req, res, next) => {
    try {
      const path = req.originalUrl.split('?')[0];
      if (!path.startsWith('/api/') || OPEN.some((re) => re.test(path))) return next();
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies?.sk_token || null);
      if (!token) return next();
      let user;
      try { user = jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM] }); } catch { return next(); }
      if (user.role !== 'CLIENT' || user.demo || !(await isIndependentClient(db, user))) return next();
      if (await hasAccessCached(db, user.sub)) return next();
      return res.status(402).json({ error: 'plan_required', message: 'Your free trial has ended. Choose a plan to keep using Barbell.' });
    } catch {
      // Fail open: a hiccup here must never take the app down for anyone.
      return next();
    }
  };
}
