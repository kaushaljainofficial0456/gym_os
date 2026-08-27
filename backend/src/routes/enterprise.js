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
import { createOrgPackageQuote, createOrgUpgradeQuote, createCapacityAddonQuote, getValidQuote, consumeQuote } from '../services/enterprise/quotes.js';
import { createPaymentOrder } from '../services/payments/paymentOrders.js';
import { recordCheckoutVerification, recordWebhookEvent } from '../services/payments/paymentActivation.js';
import { issueInvoice } from '../services/payments/invoices.js';
import { renderInvoicePdf } from '../services/payments/invoicePdf.js';

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
  r.use(rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => req.user?.sub || 'anon' }));

  // ---- status: the one call the owner dashboard needs to know what to show ----
  r.get('/status', async (req, res) => {
    const snapshot = await getOrgBillingSnapshot(db, req.orgId);
    const onboarding = await db.q1('SELECT completed_at FROM gym_onboarding WHERE org_id = ?', [req.orgId]);
    const trainerCount = await getActiveTrainerCount(db, req.orgId);
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

  // ---- billing quotes: the ONE place a gym-level price gets locked,
  // before ANY payment_order exists. See quotes.js's header comment.
  r.post('/billing/quote', paymentLimit, validate(z.object({
    kind: z.enum(['ORG_PACKAGE', 'ORG_UPGRADE', 'ORG_CAPACITY_ADDON']),
    capacity: z.number().int().min(1).max(100_000).optional(),
    addonId: z.string().min(1).optional(),
  })), async (req, res) => {
    const { kind, capacity, addonId } = req.body;
    let result;
    if (kind === 'ORG_CAPACITY_ADDON') {
      if (!addonId) return res.status(400).json({ error: 'addonId is required for an ORG_CAPACITY_ADDON quote' });
      result = await createCapacityAddonQuote(db, { orgId: req.orgId, addonId, createdBy: req.user.sub });
    } else {
      if (!capacity) return res.status(400).json({ error: 'capacity is required for this quote kind' });
      result = kind === 'ORG_UPGRADE'
        ? await createOrgUpgradeQuote(db, { orgId: req.orgId, capacity, createdBy: req.user.sub })
        : await createOrgPackageQuote(db, { orgId: req.orgId, capacity, createdBy: req.user.sub });
    }
    if (!result.ok) {
      if (result.reason === 'downgrade_blocked') {
        return res.status(409).json({
          error: result.reason, activeClients: result.activeClients, requestedCapacity: result.requestedCapacity,
          message: `You currently have ${result.activeClients} active clients. You cannot downgrade to ${result.requestedCapacity} until active membership count is within the new capacity.`,
        });
      }
      return res.status(422).json({ error: result.reason });
    }
    res.json({ quote: result.quote, direction: result.direction });
  });

  // A payment_order is ALWAYS created from a locked quote -- never from
  // a raw capacity/price the frontend sends directly. See quotes.js.
  r.post('/payment/order', paymentLimit, validate(z.object({ quoteId: z.string().min(1) })), async (req, res) => {
    const resolved = await getValidQuote(db, req.body.quoteId, req.orgId);
    if (!resolved.ok) return res.status(422).json({ error: resolved.reason });
    const quote = resolved.quote;

    if (quote.kind === 'ORG_CAPACITY_ADDON') {
      const snapshot = await getOrgBillingSnapshot(db, req.orgId);
      if (!snapshot.subscription || snapshot.subscription.status !== 'ACTIVE') {
        return res.status(409).json({ error: 'An active package is required before buying additional capacity' });
      }
      if (!(await consumeQuote(db, quote.id))) return res.status(409).json({ error: 'quote_already_used' });
      const purchase = await createPendingCapacityPurchase(db, {
        orgId: req.orgId, subscriptionId: snapshot.subscription.id, addonId: quote.addon_id, increment: quote.capacity, price: quote.total, currency: quote.currency,
      });
      const order = await createPaymentOrder(db, {
        subjectType: 'ORG_CAPACITY_ADDON', subjectId: purchase.id, orgId: req.orgId,
        amount: quote.total, currency: quote.currency, idempotencyKey: `capacity-${purchase.id}`,
      });
      return res.json({ order, purchase, quote });
    }

    // ORG_PACKAGE (initial purchase / renewal) and ORG_UPGRADE both
    // just create (or supersede-via-activation) an org_subscriptions
    // row -- the SAME ORG_PACKAGE activation handler covers both.
    if (!(await consumeQuote(db, quote.id))) return res.status(409).json({ error: 'quote_already_used' });
    const subscription = await createPendingOrgSubscription(db, {
      orgId: req.orgId, packageId: quote.package_id, clientCapacity: quote.capacity, price: quote.total, currency: quote.currency,
    });

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
    await db.run(`UPDATE org_subscriptions SET payment_order_id = ? WHERE id = ?`, [order.id, subscription.id]);
    await db.run(`UPDATE org_billing_state SET status = 'PAYMENT_PENDING', updated_at = ? WHERE org_id = ?`, [now(), req.orgId]);
    res.json({ order, subscription, quote });
  });

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
    const rows = await db.q('SELECT * FROM invoices WHERE org_id = ? ORDER BY issued_at DESC LIMIT 100', [req.orgId]);
    res.json({ invoices: rows });
  });

  // "Email Invoice" is intentionally not implemented -- no email
  // provider is configured anywhere in this environment (see
  // notifications.js's own header comment); this is the honest "Download
  // Invoice" half only, per the spec's own "don't pretend a channel is
  // implemented" rule.
  r.get('/invoices/:id/pdf', async (req, res) => {
    const pdf = await renderInvoicePdf(db, { invoiceId: req.params.id, orgId: req.orgId });
    if (!pdf) return res.status(404).json({ error: 'Invoice not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.pdf"`);
    res.send(pdf);
  });

  // ---- payout/KYC account status (Razorpay Route linked account, once configured) ----
  r.get('/payment-account', async (req, res) => {
    const row = await db.q1('SELECT * FROM payment_accounts WHERE org_id = ?', [req.orgId]);
    res.json({ account: row || { org_id: req.orgId, provider: 'razorpay', status: 'NOT_CONNECTED' } });
  });

  r.put('/payment-account', validate(z.object({
    businessName: z.string().max(120).optional(), legalName: z.string().max(120).optional(),
  })), async (req, res) => {
    // Deliberately does NOT collect bank account/IFSC/UPI details here --
    // those stay entirely inside the payment provider's own hosted KYC
    // flow per its compliance requirements (spec: "prefer provider-
    // hosted KYC/account onboarding"). This just records the business/
    // legal name SK OS already has and marks KYC as the next step; the
    // actual provider_account_id/status transition to ACTIVE happens
    // once real Razorpay Route credentials exist to call their account
    // API with -- see the Enterprise report's "remaining manual
    // configuration" section.
    await db.run(
      `INSERT INTO payment_accounts (org_id, provider, status, business_name, legal_name, updated_at)
       VALUES (?, 'razorpay', 'KYC_PENDING', ?, ?, ?)
       ON CONFLICT(org_id) DO UPDATE SET business_name=excluded.business_name, legal_name=excluded.legal_name,
         status = CASE WHEN payment_accounts.status = 'NOT_CONNECTED' THEN 'KYC_PENDING' ELSE payment_accounts.status END,
         updated_at=excluded.updated_at`,
      [req.orgId, req.body.businessName ?? null, req.body.legalName ?? null, now()]);
    res.json({ ok: true });
  });

  return r;
}
