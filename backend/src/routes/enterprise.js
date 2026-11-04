// ============================================================
// ENTERPRISE — the gym owner's OWN SK OS subscription: onboarding
// wizard, package/pricing, payment, capacity add-ons, invoices, payout
// account status. Client/trainer QR enrollment lives in enrollment.js
// (a separate file -- different auth shape: this file is entirely
// GYM_OWNER-authenticated, enrollment.js's scan/join routes are public
// or CLIENT/TRAINER-authenticated).
//
// Mounted at /api/enterprise in index.js. The webhook route
// (POST /payment/webhook) is the one exception to "JSON body already
// parsed" -- see index.js's express.raw() mount for that one path,
// registered BEFORE the app-wide express.json() so the signature can be
// verified against the exact raw bytes Razorpay sent.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { id, now } from '../ids.js';
import { track } from '../services/events.js';
import { getCurrentPackages, getCurrentPricingRules, getCurrentCapacityAddons, calculatePackagePrice } from '../services/enterprise/pricing.js';
import { getOrgBillingSnapshot, getActiveTrainerCount, createPendingOrgSubscription, createPendingCapacityPurchase, activateOrgSubscription } from '../services/enterprise/subscriptionLifecycle.js';
import { createOrgPackageQuote, createOrgUpgradeQuote, createCapacityAddonQuote, getValidQuote, consumeQuote, quotePricing } from '../services/enterprise/quotes.js';
import {
  reserveQuoteCoupons, releaseQuoteReservations, attachReservationSubject, attachReservationOrder, quoteCouponLines, MAX_STACKED_COUPONS,
} from '../services/coupons/couponEngine.js';
import { createPaymentOrder } from '../services/payments/paymentOrders.js';
import { recordCheckoutVerification, recordWebhookEvent } from '../services/payments/paymentActivation.js';
import { issueInvoice } from '../services/payments/invoices.js';
import { renderInvoicePdf, resolveInvoiceRecipient } from '../services/payments/invoicePdf.js';
import { getPayoutAccount, payoutView, refreshPayoutStatus, submitPayoutDetails } from '../services/payments/payouts.js';
import { sendEmail } from '../services/notifications/emailProvider.js';

export default function enterpriseRoutes(db) {
  const r = Router();
  const ownerOnly = requireRole('GYM_OWNER', 'SUPER_ADMIN');

  // Webhook is PUBLIC (Razorpay calls it directly, no user session) and
  // signature-verified instead -- mounted before the auth gate below,
  // and its own rate limit is by provider/IP, not by user.
  const webhookLimit = rateLimit({ windowMs: 60_000, max: 120, keyFn: (req) => req.ip || 'anon' });
  r.post('/payment/webhook', webhookLimit, async (req, res) => {
    // index.js mounts express.raw() for exactly this path, so req.body
    // is a Buffer here, never pre-parsed JSON -- see that file's comment.
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const signature = req.headers['x-razorpay-signature'] || '';
    let result;
    try {
      result = await recordWebhookEvent(db, { rawBody, signature });
    } catch (e) {
      // A genuinely unexpected failure (DB error, an activation handler
      // that threw, etc.) -- NOT the same as a malformed payload, which
      // recordWebhookEvent returns rather than throws (see there). A
      // non-2xx here is what makes the provider retry the delivery,
      // which is exactly what's wanted: the failure is ours to recover
      // from, not evidence the request itself was bad.
      return res.status(500).json({ error: 'webhook processing failed' });
    }
    if (!result.ok && result.reason === 'invalid_webhook_signature') return res.status(401).json({ error: 'invalid signature' });
    // A malformed body (not valid JSON) must never trigger a retry --
    // the provider would just keep resending the same unparseable bytes.
    if (!result.ok && result.reason === 'malformed_webhook_payload') return res.status(400).json({ error: 'invalid webhook payload' });
    // Every other outcome (order not found, unrecognized event, mismatch,
    // duplicate) still gets a 200 -- these are all legitimate, HANDLED
    // outcomes from the provider's point of view; a webhook retry storm
    // from returning non-2xx on something we've already correctly logged
    // would help nobody. Only a bad signature or bad payload is
    // genuinely "reject this, don't bother retrying."
    res.json({ ok: true });
  });

  r.use(requireAuth, orgScope, ownerOnly);
  // Baseline limiter for the rest of this (entirely owner-authenticated)
  // router -- nothing here had any rate limit before this file existed.
  // 240, not 60: six screens read /enterprise/status, several on every
  // page change, so an owner moving briskly through the workspace hit the
  // cap and got error screens. Payments and email keep their own tight
  // limits below; this one only has to stop a runaway client.
  r.use(rateLimit({ windowMs: 60_000, max: 240, keyFn: (req) => req.user?.sub || 'anon' }));

  // ---- status: the one call the owner dashboard needs to know what to show ----
  r.get('/status', async (req, res) => {
    const [snapshot, onboarding, trainerCount] = await Promise.all([
      getOrgBillingSnapshot(db, req.orgId),
      db.q1('SELECT completed_at FROM gym_onboarding WHERE org_id = ?', [req.orgId]),
      getActiveTrainerCount(db, req.orgId)
    ]);
    res.json({
      billingStatus: snapshot.status,
      onboardingCompleted: !!onboarding?.completed_at,
      subscription: snapshot.subscription,
      purchasedCapacity: snapshot.purchasedCapacity,
      activeClients: snapshot.activeClients,
      availableCapacity: snapshot.availableCapacity,
      activeTrainers: trainerCount,
    });
  });

  // ---- onboarding wizard ----
  r.get('/onboarding', async (req, res) => {
    const row = await db.q1('SELECT * FROM gym_onboarding WHERE org_id = ?', [req.orgId]);
    res.json({ onboarding: row || null });
  });

  const onboardingSchema = z.object({
    gymType: z.enum(['commercial', 'studio', 'crossfit', 'personal_training', 'sports_academy', 'other']).optional(),
    gymTypeOther: z.string().max(80).optional(),
    clientCountRange: z.enum(['0-25', '26-50', '51-75', '76-100', '101-200', '201-500', '500+']).optional(),
    trainerCount: z.number().int().min(0).max(10000).optional(),
    branchCount: z.number().int().min(0).max(1000).optional(),
    access: z.object({
      fingerprint: z.boolean().optional(), face: z.boolean().optional(), rfid: z.boolean().optional(),
      qr: z.boolean().optional(), manual: z.boolean().optional(), none: z.boolean().optional(),
    }).optional(),
    wantsAccessIntegration: z.boolean().optional(),
    billingCycle: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly', 'mixed']).optional(),
    offers: z.object({
      personalTraining: z.boolean().optional(), groupClasses: z.boolean().optional(), membershipPlans: z.boolean().optional(),
      nutritionPlans: z.boolean().optional(), workoutPlans: z.boolean().optional(), other: z.string().max(200).optional(),
    }).optional(),
    usesOtherSoftware: z.boolean().optional(),
    otherSoftwareName: z.string().max(100).optional(),
    improvementNotes: z.string().max(1000).optional(),
    activeClientsEstimate: z.number().int().min(0).max(1_000_000).optional(),
    avgMembershipPrice: z.number().min(0).max(1_000_000).optional(),
    expectedSkOsUsers: z.number().int().min(0).max(1_000_000).optional(),
    preferredContactMethod: z.string().max(40).optional(),
    complete: z.boolean().default(false),
  });
  r.post('/onboarding', validate(onboardingSchema), async (req, res) => {
    const b = req.body;
    const existing = await db.q1('SELECT * FROM gym_onboarding WHERE org_id = ?', [req.orgId]);
    const nowIso = now();
    await db.run(
      `INSERT INTO gym_onboarding (org_id, gym_type, gym_type_other, client_count_range, trainer_count, branch_count,
         access_fingerprint, access_face, access_rfid, access_qr, access_manual, access_none, wants_access_integration,
         billing_cycle, offers_personal_training, offers_group_classes, offers_membership_plans, offers_nutrition_plans,
         offers_workout_plans, offers_other, uses_other_software, other_software_name, improvement_notes,
         active_clients_estimate, avg_membership_price, expected_sk_os_users, preferred_contact_method, completed_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(org_id) DO UPDATE SET gym_type=excluded.gym_type, gym_type_other=excluded.gym_type_other,
         client_count_range=excluded.client_count_range, trainer_count=excluded.trainer_count, branch_count=excluded.branch_count,
         access_fingerprint=excluded.access_fingerprint, access_face=excluded.access_face, access_rfid=excluded.access_rfid,
         access_qr=excluded.access_qr, access_manual=excluded.access_manual, access_none=excluded.access_none,
         wants_access_integration=excluded.wants_access_integration, billing_cycle=excluded.billing_cycle,
         offers_personal_training=excluded.offers_personal_training, offers_group_classes=excluded.offers_group_classes,
         offers_membership_plans=excluded.offers_membership_plans, offers_nutrition_plans=excluded.offers_nutrition_plans,
         offers_workout_plans=excluded.offers_workout_plans, offers_other=excluded.offers_other,
         uses_other_software=excluded.uses_other_software, other_software_name=excluded.other_software_name,
         improvement_notes=excluded.improvement_notes, active_clients_estimate=excluded.active_clients_estimate,
         avg_membership_price=excluded.avg_membership_price, expected_sk_os_users=excluded.expected_sk_os_users,
         preferred_contact_method=excluded.preferred_contact_method, completed_at=excluded.completed_at, updated_at=excluded.updated_at`,
      [req.orgId, b.gymType ?? null, b.gymTypeOther ?? null, b.clientCountRange ?? null, b.trainerCount ?? null, b.branchCount ?? null,
       b.access?.fingerprint ? 1 : 0, b.access?.face ? 1 : 0, b.access?.rfid ? 1 : 0, b.access?.qr ? 1 : 0, b.access?.manual ? 1 : 0, b.access?.none ? 1 : 0,
       b.wantsAccessIntegration ? 1 : 0, b.billingCycle ?? null,
       b.offers?.personalTraining ? 1 : 0, b.offers?.groupClasses ? 1 : 0, b.offers?.membershipPlans ? 1 : 0, b.offers?.nutritionPlans ? 1 : 0,
       b.offers?.workoutPlans ? 1 : 0, b.offers?.other ?? null,
       b.usesOtherSoftware ? 1 : 0, b.otherSoftwareName ?? null, b.improvementNotes ?? null,
       b.activeClientsEstimate ?? null, b.avgMembershipPrice ?? null, b.expectedSkOsUsers ?? null, b.preferredContactMethod ?? null,
       b.complete ? nowIso : (existing?.completed_at ?? null),
       existing?.created_at ?? nowIso, nowIso]);
    if (b.complete && !existing?.completed_at) {
      await track(db, { type: 'gym_onboarding_completed', orgId: req.orgId, userId: req.user.sub, data: {} }).catch(() => {});
    }
    res.json({ ok: true });
  });

  // ---- packages / pricing ----
  r.get('/packages', async (req, res) => {
    const [packages, rules, addons] = await Promise.all([getCurrentPackages(db), getCurrentPricingRules(db), getCurrentCapacityAddons(db)]);
    res.json({ packages, pricingRules: rules, capacityAddons: addons });
  });

  r.post('/packages/calculate', validate(z.object({ capacity: z.number().int().min(1).max(100_000) })), async (req, res) => {
    const result = await calculatePackagePrice(db, req.body.capacity);
    if (!result.ok) return res.status(422).json({ error: result.reason });
    res.json(result);
  });

  // ---- gym package payment (SK OS billing the gym) ----
  const paymentLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.user?.sub || 'anon' });

  // ---- coupon attempts: an EXTRA, tighter limit that only counts
  // quote requests carrying coupon codes, so guessing codes is slow
  // (per user AND per gym, so rotating owner accounts does not reset
  // it) while ordinary quote traffic keeps the paymentLimit above. ----
  // 8 per 10 minutes binds BEFORE paymentLimit's 10/minute, so it is the
  // limit a code-guesser actually meets; a person fixing a typo never will.
  const couponUserLimit = rateLimit({ windowMs: 10 * 60_000, max: 8, keyFn: (req) => `cu:${req.user?.sub || 'anon'}` });
  const couponOrgLimit = rateLimit({ windowMs: 60 * 60_000, max: 30, keyFn: (req) => `co:${req.orgId || 'anon'}` });
  const couponAttemptLimit = (req, res, next) => {
    const codes = req.body?.couponCodes;
    if (!Array.isArray(codes) || !codes.length) return next();
    couponUserLimit(req, res, (err) => (err ? next(err) : couponOrgLimit(req, res, next)));
  };

  // ---- billing quotes: the ONE place a gym-level price gets locked,
  // before ANY payment_order exists. See quotes.js's header comment.
  // What the owner reads when a quote is refused: the billing page shows
  // `message`, and without one it showed the raw code ("same_capacity").
  const QUOTE_REFUSALS = {
    same_capacity: 'That is your current capacity. Use Renew current plan to extend it.',
    no_active_subscription: 'You need an active package before changing it.',
    capacity_exceeds_configured_range: 'That is above our largest package. Contact us for a custom plan.',
    no_packages_configured: 'No packages are available right now. Please contact support.',
    invalid_capacity: 'Enter a whole number of clients.',
    addon_not_found: 'That add-on is no longer available.',
  };

  // couponCodes (optional) are priced into the SAME locked quote -- the
  // discount is computed here, server-side, and the frontend only ever
  // displays the result. Applying a coupon reserves/consumes nothing.
  r.post('/billing/quote', paymentLimit, couponAttemptLimit, validate(z.object({
    kind: z.enum(['ORG_PACKAGE', 'ORG_UPGRADE', 'ORG_CAPACITY_ADDON']),
    capacity: z.number().int().min(1).max(100_000).optional(),
    addonId: z.string().min(1).optional(),
    couponCodes: z.array(z.string().trim().min(1).max(40)).max(MAX_STACKED_COUPONS).optional(),
  })), async (req, res) => {
    const { kind, capacity, addonId, couponCodes } = req.body;
    let result;
    if (kind === 'ORG_CAPACITY_ADDON') {
      if (!addonId) return res.status(400).json({ error: 'addonId is required for an ORG_CAPACITY_ADDON quote' });
      result = await createCapacityAddonQuote(db, { orgId: req.orgId, addonId, createdBy: req.user.sub, couponCodes });
    } else {
      if (!capacity) return res.status(400).json({ error: 'capacity is required for this quote kind' });
      result = kind === 'ORG_UPGRADE'
        ? await createOrgUpgradeQuote(db, { orgId: req.orgId, capacity, createdBy: req.user.sub, couponCodes })
        : await createOrgPackageQuote(db, { orgId: req.orgId, capacity, createdBy: req.user.sub, couponCodes });
    }
    if (!result.ok && result.reason === 'coupon_invalid') {
      // Logged (code + reason only) so abuse patterns are reviewable;
      // the response carries only the customer-facing reason.
      await track(db, {
        type: 'coupon_rejected', orgId: req.orgId, userId: req.user.sub,
        data: { code: result.coupon.code, reason: result.coupon.reason, kind },
      }).catch(() => {});
      return res.status(422).json({
        error: 'coupon_invalid', reason: result.coupon.reason, code: result.coupon.code, message: result.coupon.message,
      });
    }
    if (!result.ok) {
      if (result.reason === 'downgrade_blocked') {
        return res.status(409).json({
          error: result.reason, activeClients: result.activeClients, requestedCapacity: result.requestedCapacity,
          message: `You currently have ${result.activeClients} active clients. You cannot downgrade to ${result.requestedCapacity} until active membership count is within the new capacity.`,
        });
      }
      return res.status(422).json({ error: result.reason, message: QUOTE_REFUSALS[result.reason] || 'That quote could not be prepared. Please try again.' });
    }
    res.json({ quote: result.quote, direction: result.direction, pricing: quotePricing(result.quote) });
  });

  // A payment_order is ALWAYS created from a locked quote -- never from
  // a raw capacity/price the frontend sends directly. See quotes.js.
  r.post('/payment/order', paymentLimit, validate(z.object({ quoteId: z.string().min(1) })), async (req, res) => {
    const resolved = await getValidQuote(db, req.body.quoteId, req.orgId);
    if (!resolved.ok) return res.status(422).json({ error: resolved.reason });
    const quote = resolved.quote;
    const hasCoupons = quoteCouponLines(quote).length > 0;

    if (quote.kind === 'ORG_CAPACITY_ADDON') {
      const snapshot = await getOrgBillingSnapshot(db, req.orgId);
      if (!snapshot.subscription || snapshot.subscription.status !== 'ACTIVE') {
        return res.status(409).json({ error: 'An active package is required before buying additional capacity' });
      }
    }

    // Coupons are HELD here, before anything else is written -- this is
    // the first moment a coupon use is spoken for, and it is still only
    // a hold: it becomes a redemption only when the payment verifies
    // (couponEngine.redeemOrderCoupons). A coupon that stopped being
    // valid since the quote was priced (disabled, expired, used up)
    // fails the order instead of silently charging full price.
    if (hasCoupons) {
      const held = await reserveQuoteCoupons(db, { quote, orgId: req.orgId });
      if (!held.ok) {
        return res.status(409).json({ error: 'coupon_unavailable', reason: held.reason, code: held.code, message: held.message });
      }
    }
    // Anything below that fails must hand the hold back, or an
    // abandoned error would sit on a coupon use until its TTL.
    try {
      if (quote.kind === 'ORG_CAPACITY_ADDON') {
        const snapshot = await getOrgBillingSnapshot(db, req.orgId);
        if (!(await consumeQuote(db, quote.id))) {
          if (hasCoupons) await releaseQuoteReservations(db, quote.id, 'quote_already_used');
          return res.status(409).json({ error: 'quote_already_used' });
        }
        const purchase = await createPendingCapacityPurchase(db, {
          orgId: req.orgId, subscriptionId: snapshot.subscription.id, addonId: quote.addon_id, increment: quote.capacity, price: quote.total, currency: quote.currency,
        });
        if (hasCoupons) await attachReservationSubject(db, { quoteId: quote.id, subjectType: 'ORG_CAPACITY_ADDON', subjectId: purchase.id });
        const order = await createPaymentOrder(db, {
          subjectType: 'ORG_CAPACITY_ADDON', subjectId: purchase.id, orgId: req.orgId,
          amount: quote.total, currency: quote.currency, idempotencyKey: `capacity-${purchase.id}`,
        });
        if (hasCoupons) await attachReservationOrder(db, { quoteId: quote.id, orderId: order.id });
        return res.json({ order, purchase, quote, pricing: quotePricing(quote) });
      }
      return await createPackageOrder(req, res, quote, hasCoupons);
    } catch (e) {
      if (hasCoupons) await releaseQuoteReservations(db, quote.id, 'order_creation_failed').catch(() => {});
      throw e;
    }
  });

  // ORG_PACKAGE (initial purchase / renewal) and ORG_UPGRADE both just
  // create (or supersede-via-activation) an org_subscriptions row -- the
  // SAME ORG_PACKAGE activation handler covers both.
  async function createPackageOrder(req, res, quote, hasCoupons) {
    if (!(await consumeQuote(db, quote.id))) {
      if (hasCoupons) await releaseQuoteReservations(db, quote.id, 'quote_already_used');
      return res.status(409).json({ error: 'quote_already_used' });
    }
    const subscription = await createPendingOrgSubscription(db, {
      orgId: req.orgId, packageId: quote.package_id, clientCapacity: quote.capacity, price: quote.total, currency: quote.currency,
    });
    if (hasCoupons) await attachReservationSubject(db, { quoteId: quote.id, subjectType: 'ORG_PACKAGE', subjectId: subscription.id });

    // Unreachable with a coupon (a coupon never takes a total below
    // MIN_CHARGE -- see couponEngine.js), so a coupon can never route a
    // purchase down this no-payment activation path.
    if (quote.total <= 0) {
      // A downgrade fully covered by unused credit (or any other
      // zero-amount quote) has nothing to charge -- no payment gateway
      // round-trip, no payment_order. Activated immediately through the
      // SAME state-change function a real payment would trigger, so
      // this is never a second implementation of "what does activation
      // mean" (see activateOrgSubscription's own doc comment).
      const activated = await db.tx((tx) => activateOrgSubscription(db, tx, { orgId: req.orgId, subscriptionId: subscription.id }));
      await track(db, { type: 'org_subscription_free_change', orgId: req.orgId, userId: req.user.sub, data: { subscriptionId: subscription.id, quoteId: quote.id } }).catch(() => {});
      return res.json({ order: null, subscription: activated, quote, freeChange: true });
    }

    const order = await createPaymentOrder(db, {
      subjectType: 'ORG_PACKAGE', subjectId: subscription.id, orgId: req.orgId,
      amount: quote.total, currency: quote.currency, idempotencyKey: `org-pkg-${subscription.id}`,
    });
    if (hasCoupons) await attachReservationOrder(db, { quoteId: quote.id, orderId: order.id });
    await db.run(`UPDATE org_subscriptions SET payment_order_id = ? WHERE id = ?`, [order.id, subscription.id]);
    await db.run(`UPDATE org_billing_state SET status = 'PAYMENT_PENDING', updated_at = ? WHERE org_id = ?`, [now(), req.orgId]);
    return res.json({ order, subscription, quote, pricing: quotePricing(quote) });
  }

  r.post('/payment/verify', paymentLimit, validate(z.object({
    orderId: z.string().min(1), providerPaymentId: z.string().min(1), signature: z.string().min(1),
  })), async (req, res) => {
    const order = await db.q1('SELECT * FROM payment_orders WHERE id = ? AND org_id = ?', [req.body.orderId, req.orgId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const result = await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: req.body.providerPaymentId, signature: req.body.signature });
    if (!result.ok) return res.status(422).json({ error: result.reason });
    if (!result.alreadyFinalized) {
      await issueInvoice(db, order).catch(() => {}); // best-effort -- a receipt failing to generate must never undo a real payment
    }
    res.json({ ok: true, order: await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]) });
  });

  // ---- invoices ----
  r.get('/invoices', async (req, res) => {
    // What Barbell has billed this gym. Its members' receipts carry the
    // same org_id and were listed here as if they were Barbell's bills.
    const rows = await db.q(
      `SELECT * FROM invoices WHERE org_id = ? AND subject_type IN ('ORG_PACKAGE', 'ORG_CAPACITY_ADDON')
        ORDER BY issued_at DESC LIMIT 100`, [req.orgId]);
    // Coupon detail for the receipt view -- read from the REDEEMED
    // redemption snapshots, so a later edit to the coupon can never
    // change what an old receipt says. An invoice without a coupon is
    // returned exactly as before (discount_amount 0, no coupons).
    const orderIds = rows.map((i) => i.order_id);
    const redemptions = orderIds.length
      ? await db.q(
        `SELECT cr.payment_order_id, cr.original_amount, cr.discount_amount, c.code
           FROM coupon_redemptions cr JOIN coupons c ON c.id = cr.coupon_id
          WHERE cr.org_id = ? AND cr.status = 'REDEEMED' AND cr.payment_order_id IN (${orderIds.map(() => '?').join(',')})
          ORDER BY cr.created_at`, [req.orgId, ...orderIds])
      : [];
    const byOrder = new Map();
    for (const r0 of redemptions) {
      const list = byOrder.get(r0.payment_order_id) || [];
      list.push(r0);
      byOrder.set(r0.payment_order_id, list);
    }
    res.json({
      invoices: rows.map((inv) => {
        const list = byOrder.get(inv.order_id) || [];
        const discount = Math.round(list.reduce((s, x) => s + Number(x.discount_amount), 0) * 100) / 100;
        return {
          ...inv,
          original_amount: list.length ? Number(list[0].original_amount) : Number(inv.amount),
          discount_amount: discount,
          coupons: list.map((x) => ({ code: x.code, discountAmount: Number(x.discount_amount) })),
        };
      }),
    });
  });

  r.get('/invoices/:id/pdf', async (req, res) => {
    const pdf = await renderInvoicePdf(db, { invoiceId: req.params.id, orgId: req.orgId });
    if (!pdf) return res.status(404).json({ error: 'Invoice not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.pdf"`);
    res.send(pdf);
  });

  // "Email Invoice" -- uses emailProvider.js's zero-cost gate (mock by
  // default, real delivery only with EMAIL_PROVIDER=resend +
  // RESEND_API_KEY both set), same posture as payments/AI. `to` defaults
  // to the resolved client's email for a CLIENT_MEMBERSHIP invoice; an
  // ORG_PACKAGE/ORG_CAPACITY_ADDON invoice has no client (the gym paid
  // SK OS itself), so it falls back to the requesting owner's own
  // account email -- always overridable explicitly in the body.
  //
  // F-12e authorization review: this whole router is already gated to
  // GYM_OWNER/SUPER_ADMIN (line ~69) AND org-scoped via `orgScope`
  // (resolveInvoiceRecipient below is called with req.orgId, so a caller
  // can only ever email an invoice belonging to THEIR OWN org -- see the
  // cross-org 404 test in invoiceEmail.test.js). The `to` override does
  // NOT broaden data access: the requester already owns and can freely
  // view/download this exact invoice via GET /invoices/:id/pdf with no
  // `to` involved at all, so redirecting where the SAME document is
  // emailed isn't a new authorization boundary -- it's the same
  // legitimate "forward this document" action any invoicing tool
  // supports. What IS real: an already-privileged (or compromised)
  // owner account could use the override to relay unsolicited email to
  // arbitrary third parties from SK OS's sending domain/reputation. Two
  // things mitigate that: the existing per-user rate limit below, and
  // the audit trail this route now writes (track() call after a
  // successful send) recording orgId, the acting user, the invoice, and
  // the actual recipient used -- so an abuse pattern is reviewable after
  // the fact even though it isn't blocked outright (blocking legitimate
  // "email my accountant" use outright would be a worse trade-off here).
  const emailLimit = rateLimit({ windowMs: 60_000, max: 5, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/invoices/:id/email', emailLimit, validate(z.object({
    to: z.string().email().optional(),
  })), async (req, res) => {
    const recipient = await resolveInvoiceRecipient(db, { invoiceId: req.params.id, orgId: req.orgId });
    if (!recipient) return res.status(404).json({ error: 'Invoice not found' });
    const to = req.body.to || recipient.customer?.email || req.user.email;
    if (!to) return res.status(422).json({ error: 'no_recipient', message: 'No email address to send this invoice to. Provide one explicitly.' });
    const pdf = await renderInvoicePdf(db, { invoiceId: req.params.id, orgId: req.orgId });
    const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [req.orgId]);
    const { invoice } = recipient;
    const result = await sendEmail({
      to,
      subject: `Invoice ${invoice.invoice_number} from ${org?.name || 'Barbell'}`,
      html: `<p>Hi${recipient.customer?.name ? ' ' + recipient.customer.name : ''},</p>` +
        `<p>Please find attached invoice <strong>${invoice.invoice_number}</strong> for ${invoice.currency} ${Number(invoice.amount).toFixed(2)}.</p>`,
      attachments: [{ filename: `${invoice.invoice_number}.pdf`, content: pdf }],
    });
    if (!result.ok) return res.status(502).json({ error: 'email_send_failed', message: result.error, provider: result.provider });
    await db.run('UPDATE invoices SET emailed_at = ? WHERE id = ?', [now(), invoice.id]);
    track(db, 'invoice_emailed', req.orgId, req.user.sub, {
      invoice_id: invoice.id, to, recipient_overridden: !!req.body.to,
    });
    res.json({ ok: true, to, provider: result.provider });
  });

  // ---- getting paid: the gym's Razorpay Route account ----
  // Members pay the gym, not Barbell: their money is moved to this account
  // and settled to the gym's bank (services/payments/payouts.js). Until it
  // is ACTIVE, members pay at the desk.
  r.get('/payment-account', async (req, res) => {
    res.json({ account: payoutView(await getPayoutAccount(db, req.orgId)) });
  });

  const payoutLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/payment-account', payoutLimit, validate(z.object({
    legalBusinessName: z.string().trim().min(4).max(200),
    displayName: z.string().trim().max(120).optional(),
    businessType: z.enum(['individual', 'proprietorship', 'partnership', 'private_limited', 'public_limited', 'llp', 'trust', 'society', 'ngo', 'not_yet_registered', 'other']),
    contactName: z.string().trim().min(2).max(120),
    email: z.string().trim().email(),
    phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'A 10-digit Indian mobile number'),
    pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'A PAN looks like ABCDE1234F'),
    gst: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z0-9]{13}$/, 'A GSTIN has 15 characters').optional().or(z.literal('')),
    street1: z.string().trim().min(3).max(100),
    street2: z.string().trim().max(100).optional(),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().min(2).max(32),
    postalCode: z.string().trim().regex(/^\d{6}$/, 'A 6-digit PIN code'),
    accountNumber: z.string().trim().regex(/^\d{9,18}$/, 'Bank account numbers have 9 to 18 digits'),
    ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC looks like HDFC0001234'),
    beneficiaryName: z.string().trim().min(2).max(120),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: "Accept Razorpay's terms to continue" }) }),
  })), async (req, res) => {
    const account = await submitPayoutDetails(db, req.orgId, req.body);
    await track(db, { type: 'payout_account_submitted', orgId: req.orgId, userId: req.user.sub, data: { status: account.status } }).catch(() => {});
    res.json({ account: payoutView(account) });
  });

  r.post('/payment-account/refresh', payoutLimit, async (req, res) => {
    res.json({ account: payoutView(await refreshPayoutStatus(db, req.orgId)) });
  });

  return r;
}
