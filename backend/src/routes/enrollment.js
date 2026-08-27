// ============================================================
// ENROLLMENT — QR-based client + trainer onboarding.
//
// Three distinct auth shapes in this one file:
//   - Owner routes (generate/list/revoke QR): GYM_OWNER-authenticated.
//   - Client routes (preview/join/pay): CLIENT-authenticated, but the
//     user may be in the "no org yet" PENDING_GYM_ENROLLMENT state --
//     see auth.js's /register (gymCode now optional) for how that
//     account gets created in the first place.
//   - Trainer routes (preview/join): TRAINER-authenticated, same
//     pending-enrollment shape.
//
// CLIENT JOIN SEQUENCING (the one subtle design decision here): the
// enrollment_tokens row is consumed at JOIN time (before payment) to
// burn the QR immediately -- but the actual `clients` row, subscription
// membership row, and users.org_id assignment are all deferred to the
// CLIENT_MEMBERSHIP payment activation handler below, which fires only
// once payment is verified. Between those two moments the user is in a
// real but narrow limbo state: token consumed, no clients row yet. A
// failed/abandoned payment can be retried against the SAME payment_order
// (see /client/payment/order's idempotency) without needing a new QR.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, orgScope, signToken, setAuthCookie } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { id, now } from '../ids.js';
import { track } from '../services/events.js';
import { issueEnrollmentToken, verifyEnrollmentToken, consumeEnrollmentToken, revokeEnrollmentToken } from '../services/enterprise/enrollmentToken.js';
import { getOrgBillingSnapshot, reserveCapacitySlot, releaseCapacitySlot } from '../services/enterprise/subscriptionLifecycle.js';
import { syncPrimaryMembership } from '../services/enterprise/gymMemberships.js';
import { notify, notifyOwners } from '../services/enterprise/notifications.js';
import { createPaymentOrder } from '../services/payments/paymentOrders.js';
import { recordCheckoutVerification, registerActivationHandler, registerReleaseHandler } from '../services/payments/paymentActivation.js';
import { issueInvoice } from '../services/payments/invoices.js';

// Releases the capacity slot claimed at /client/join time (see
// reserveCapacitySlot there) once this order is known to have
// definitively failed/cancelled/disputed and can never still succeed --
// see paymentActivation.js's terminal-status branch for exactly when
// this fires, and its idempotency guard for why it's safe to call at
// most once per reservation.
registerReleaseHandler('CLIENT_MEMBERSHIP', async (db, order, tx) => {
  await releaseCapacitySlot(tx, order.org_id);
});

/**
 * RENEWAL activation -- the OTHER shape CLIENT_MEMBERSHIP orders can
 * take (see the dispatch below): order.subject_id is an EXISTING
 * subscriptions.id, order.client_id is already set (the client already
 * exists -- see /client/renew). Extends end_date from the CURRENT
 * end_date if the membership hasn't lapsed yet (never shortens it by
 * renewing early), or from now if it already expired.
 */
async function activateRenewal(db, order, tx) {
  const subscription = await tx.q1('SELECT * FROM subscriptions WHERE id = ? AND org_id = ?', [order.subject_id, order.org_id]);
  if (!subscription) return; // defensive -- should be unreachable
  const plan = subscription.package_id ? await tx.q1('SELECT * FROM packages WHERE id = ?', [subscription.package_id]) : null;
  const periodDays = plan?.period_days || 30;
  const wasExpired = Date.parse(subscription.end_date) <= Date.now();
  const base = wasExpired ? Date.now() : Date.parse(subscription.end_date);
  const newEndDate = new Date(base + periodDays * 86_400_000).toISOString();
  const nowIso = now();
  const client = await tx.q1('SELECT user_id FROM clients WHERE id = ?', [order.client_id]);

  await tx.run(`UPDATE subscriptions SET end_date = ?, status = 'active', payment_status = 'paid', lifecycle_status = 'ACTIVE' WHERE id = ?`, [newEndDate, subscription.id]);
  await tx.run(
    `INSERT INTO membership_status_history (id, subscription_id, org_id, previous_status, new_status, reason, changed_by, created_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [id('msh'), subscription.id, order.org_id, subscription.lifecycle_status || 'ACTIVE', wasExpired ? 'renewed_after_expiry' : 'renewed', client?.user_id || null, nowIso]);
  await tx.run(
    `INSERT INTO payments (id, org_id, client_id, subscription_id, amount, currency, method, status, paid_at, external_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)`,
    [id('pay'), order.org_id, order.client_id, subscription.id, order.amount, order.currency, order.provider, nowIso, order.id]);

  await notify(db, { orgId: order.org_id, userId: client?.user_id, type: 'membership_renewed', title: `Your membership is renewed through ${newEndDate.slice(0, 10)}`, data: { subscriptionId: subscription.id } });
  await track(db, { type: 'client_membership_renewed', orgId: order.org_id, userId: client?.user_id, data: { subscriptionId: subscription.id, newEndDate, wasExpired } }).catch(() => {});
}

/**
 * CLIENT_MEMBERSHIP activation -- fires once inside the same transaction
 * that marks the payment order SUCCESS. Two shapes share this one
 * subject_type: a fresh JOIN (order.client_id is null -- everything is
 * resolved from the enrollment_tokens row instead, order.subject_id
 * being that token's id) and a RENEWAL (order.client_id is already set
 * at order-creation time -- see /client/renew -- and order.subject_id
 * is an existing subscriptions.id, not a token). The two never collide:
 * a fresh join's payment_order always has client_id NULL because the
 * clients row doesn't exist until THIS handler creates it.
 */
registerActivationHandler('CLIENT_MEMBERSHIP', async (db, order, tx) => {
  if (order.client_id) return activateRenewal(db, order, tx);
  const enrollmentToken = await tx.q1('SELECT * FROM enrollment_tokens WHERE id = ?', [order.subject_id]);
  if (!enrollmentToken || !enrollmentToken.consumed_by) return; // defensive -- should be unreachable
  const userId = enrollmentToken.consumed_by;
  const orgId = enrollmentToken.org_id;

  const alreadyClient = await tx.q1('SELECT id FROM clients WHERE user_id = ?', [userId]);
  if (alreadyClient) return; // idempotency safety net -- see paymentActivation.js's own guard, this is belt-and-suspenders

  const plan = enrollmentToken.membership_plan_id ? await tx.q1('SELECT * FROM packages WHERE id = ?', [enrollmentToken.membership_plan_id]) : null;
  const clientId = id('cli');
  const nowIso = now();
  await tx.run('UPDATE users SET org_id = ? WHERE id = ?', [orgId, userId]);
  await tx.run(
    `INSERT INTO clients (id, user_id, org_id, status, goal, created_at) VALUES (?, ?, ?, 'ON_TRACK', 'GENERAL', ?)`,
    [clientId, userId, orgId, nowIso]);
  // Phase 2: mirrors the primary org_id/role relationship into
  // gym_memberships too, in the SAME transaction -- see
  // gymMemberships.js's own header comment.
  await syncPrimaryMembership(tx, { userId, orgId, role: 'CLIENT' });
  // NOTE: the provisional reservation made at /client/join time (see
  // reserveCapacitySlot) is released by the registerReleaseHandler
  // call below, which paymentActivation.js fires in the SAME
  // transaction right after this activation handler returns -- not
  // here, so success and failure both release through the one path.
  await tx.run(`INSERT INTO client_profiles (client_id, meals_per_day, sleep_target_h, water_target_l) VALUES (?, 5, 8, 3)`, [clientId]);

  // Reuse the EXISTING gym-membership tables (subscriptions/payments --
  // see database/schema.sql's note on why these aren't duplicated) so
  // this client's membership shows up correctly in the Business
  // dashboard's existing revenue/member views without any change there.
  const periodDays = plan?.period_days || 30;
  const startDate = nowIso;
  const endDate = new Date(Date.now() + periodDays * 86_400_000).toISOString();
  const subId = id('sub');
  await tx.run(
    `INSERT INTO subscriptions (id, org_id, client_id, package_id, plan_name, amount, currency, start_date, end_date, status, payment_status, lifecycle_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'paid', 'ACTIVE')`,
    [subId, orgId, clientId, plan?.id || null, plan?.name || 'Membership', order.amount, order.currency, startDate, endDate]);
  await tx.run(
    `INSERT INTO payments (id, org_id, client_id, subscription_id, amount, currency, method, status, paid_at, external_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)`,
    [id('pay'), orgId, clientId, subId, order.amount, order.currency, order.provider, nowIso, order.id]);

  await notify(db, { orgId, userId, type: 'membership_activated', title: `Welcome! Your ${plan?.name || 'membership'} is active`, data: { subscriptionId: subId } });
  await notifyOwners(db, orgId, { type: 'client_joined', title: 'New client joined', body: plan?.name ? `via ${plan.name} membership` : undefined, data: { clientId } });
  await track(db, { type: 'client_enrolled', orgId, userId, data: { clientId, tokenId: enrollmentToken.id } }).catch(() => {});
});

export default function enrollmentRoutes(db) {
  const r = Router();
  r.use(requireAuth);
  // NOT a sub-router mounted with its own role-gating .use() -- a
  // sub-router's .use() middleware runs for EVERY request that reaches
  // it (since it's mounted at '/'), even ones that don't match any of
  // its own routes and were only "passing through" on their way to a
  // later route on the parent -- Express's per-router middleware doesn't
  // skip itself just because nothing downstream matches. Learned this
  // the hard way: the very first version of this file 403'd
  // /enrollment/preview for a legitimate CLIENT because it happened to
  // run through the owner sub-router's requireRole('GYM_OWNER', ...)
  // first, since preview was registered after that router was mounted.
  // Every route below applies its own auth gate inline instead, matching
  // the pattern already established elsewhere in this codebase (e.g.
  // workouts.js's `trainerOnly` applied per-route, never as a blanket
  // router-wide .use()).
  const ownerOnly = [orgScope, requireRole('GYM_OWNER', 'SUPER_ADMIN')];
  const clientOnly = requireRole('CLIENT');
  const trainerOnlyRole = requireRole('TRAINER');
  const qrGenLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });

  /* ================= OWNER: generate / list / revoke QR ================= */
  r.post('/qr/client', ...ownerOnly, qrGenLimit, validate(z.object({ membershipPlanId: z.string().min(1) })), async (req, res) => {
    const plan = await db.q1('SELECT * FROM packages WHERE id = ? AND org_id = ?', [req.body.membershipPlanId, req.orgId]);
    if (!plan) return res.status(404).json({ error: 'Membership plan not found' });
    const snapshot = await getOrgBillingSnapshot(db, req.orgId);
    if (snapshot.status !== 'ACTIVE') return res.status(409).json({ error: 'Your SK OS package is not active yet' });
    if (snapshot.availableCapacity <= 0) return res.status(409).json({ error: 'No client capacity remaining', availableCapacity: 0 });
    const issued = await issueEnrollmentToken(db, { orgId: req.orgId, createdBy: req.user.sub, purpose: 'CLIENT', membershipPlanId: plan.id });
    await track(db, { type: 'client_qr_generated', orgId: req.orgId, userId: req.user.sub, data: { tokenId: issued.id, membershipPlanId: plan.id } }).catch(() => {});
    res.json({ payload: issued.payload, id: issued.id, expiresAt: issued.expiresAt, remainingCapacity: snapshot.availableCapacity });
  });

  r.post('/qr/trainer', ...ownerOnly, qrGenLimit, async (req, res) => {
    // Trainer capacity is UNLIMITED (spec) -- no capacity gate here,
    // unlike the client QR route above.
    const issued = await issueEnrollmentToken(db, { orgId: req.orgId, createdBy: req.user.sub, purpose: 'TRAINER' });
    await track(db, { type: 'trainer_qr_generated', orgId: req.orgId, userId: req.user.sub, data: { tokenId: issued.id } }).catch(() => {});
    res.json({ payload: issued.payload, id: issued.id, expiresAt: issued.expiresAt });
  });

  r.get('/qr', ...ownerOnly, async (req, res) => {
    // validate() checks req.body, not query strings -- a GET request has
    // no body, so query params are checked inline against a fixed
    // allow-list instead (anything else is silently ignored, not an error).
    const purpose = ['CLIENT', 'TRAINER'].includes(req.query.purpose) ? req.query.purpose : null;
    const status = ['AVAILABLE', 'CONSUMED', 'EXPIRED', 'REVOKED'].includes(req.query.status) ? req.query.status : null;
    // Every condition is prefixed with the enrollment_tokens alias (t.) --
    // packages ALSO has org_id and status columns (see its own guarded
    // status migration), so once a membership plan row exists for this
    // org, an unqualified `org_id = ?`/`status = ?` becomes genuinely
    // ambiguous across the joined tables and SQLite rejects the whole
    // query outright. Caught live in browser verification, not by any
    // existing automated test (none had a `packages` row AND called this
    // route in the same test) -- see hardeningPass2.test.js's tenant-
    // isolation test for where this is now covered going forward.
    const conds = ['t.org_id = ?']; const params = [req.orgId];
    if (purpose) { conds.push('t.purpose = ?'); params.push(purpose); }
    if (status) { conds.push('t.status = ?'); params.push(status); }
    const rows = await db.q(
      `SELECT t.*, u.name AS consumed_by_name, p.name AS membership_plan_name
         FROM enrollment_tokens t
         LEFT JOIN users u ON u.id = t.consumed_by
         LEFT JOIN packages p ON p.id = t.membership_plan_id
        WHERE ${conds.join(' AND ')} ORDER BY t.created_at DESC LIMIT 200`, params);
    // token_hash is deliberately never returned -- it's a verifier, not
    // display data, and even though it can't be reversed to a working
    // QR, there's no reason to ship it to the client at all.
    res.json({ tokens: rows.map(({ token_hash, ...t }) => t) });
  });

  r.post('/qr/:id/revoke', ...ownerOnly, qrGenLimit, async (req, res) => {
    const ok = await revokeEnrollmentToken(db, { orgId: req.orgId, tokenId: req.params.id });
    if (!ok) return res.status(409).json({ error: 'Token cannot be revoked (already consumed, expired, or not found)' });
    await track(db, { type: 'qr_revoked', orgId: req.orgId, userId: req.user.sub, data: { tokenId: req.params.id } }).catch(() => {});
    res.json({ ok: true });
  });

  /* ================= SCAN: preview a QR before committing ================= */
  const scanLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/preview', scanLimit, validate(z.object({ payload: z.string().min(1) })), async (req, res) => {
    const verified = await verifyEnrollmentToken(db, req.body.payload);
    if (!verified.ok) return res.status(422).json({ error: verified.reason });
    const org = await db.q1('SELECT o.*, bs.status AS billing_status FROM organizations o LEFT JOIN org_billing_state bs ON bs.org_id = o.id WHERE o.id = ?', [verified.token.org_id]);
    if (!org || org.billing_status !== 'ACTIVE') return res.status(409).json({ error: 'gym_not_active' });
    const plan = verified.token.purpose === 'CLIENT' && verified.token.membership_plan_id
      ? await db.q1('SELECT id, name, amount, currency, period_days FROM packages WHERE id = ?', [verified.token.membership_plan_id])
      : null;
    res.json({
      purpose: verified.token.purpose,
      gym: { id: org.id, name: org.name },
      membershipPlan: plan,
      expiresAt: verified.token.expires_at,
    });
  });

  /* ================= CLIENT: join + pay ================= */
  r.post('/client/join', clientOnly, scanLimit, validate(z.object({ payload: z.string().min(1) })), async (req, res) => {
    if (req.user.org) return res.status(409).json({ error: 'already_in_a_gym' });
    const alreadyClient = await db.q1('SELECT id FROM clients WHERE user_id = ?', [req.user.sub]);
    if (alreadyClient) return res.status(409).json({ error: 'already_a_client' });

    // Consume the token first: its own conditional UPDATE
    // (WHERE status = 'AVAILABLE') is what prevents two scans of the
    // SAME QR from both winning.
    const consumed = await consumeEnrollmentToken(db, req.body.payload, { expectedPurpose: 'CLIENT', consumedBy: req.user.sub });
    if (!consumed.ok) return res.status(422).json({ error: consumed.reason });

    const org = await db.q1('SELECT o.*, bs.status AS billing_status FROM organizations o LEFT JOIN org_billing_state bs ON bs.org_id = o.id WHERE o.id = ?', [consumed.token.org_id]);
    if (!org || org.billing_status !== 'ACTIVE') return res.status(409).json({ error: 'gym_not_active' });

    // Claim a capacity slot as ONE atomic conditional UPDATE (see
    // reserveCapacitySlot) rather than "read availableCapacity, then
    // separately decide" -- that read-then-act shape is exactly what
    // let two DIFFERENT, independently-valid QRs both pass a capacity
    // check for the SAME last slot when their joins land at the same
    // moment (caught by test/enterpriseFlow.test.js's concurrent-join
    // race test). The token is already consumed at this point --
    // burned, not refunded to AVAILABLE, even if the reservation below
    // fails. This is a deliberate tradeoff: the owner generated it
    // while capacity existed; capacity was claimed by someone else's
    // faster join in the gap between generation and this scan. The
    // spec's own race-condition requirement is about never going
    // NEGATIVE or double-granting a slot, not about guaranteeing every
    // generated QR is always redeemable.
    const reserved = await reserveCapacitySlot(db, consumed.token.org_id);
    if (!reserved) return res.status(409).json({ error: 'capacity_exhausted' });

    const plan = consumed.token.membership_plan_id ? await db.q1('SELECT * FROM packages WHERE id = ?', [consumed.token.membership_plan_id]) : null;
    let order;
    try {
      order = await createPaymentOrder(db, {
        subjectType: 'CLIENT_MEMBERSHIP', subjectId: consumed.token.id, orgId: consumed.token.org_id,
        amount: plan?.amount || 0, currency: plan?.currency || 'INR', idempotencyKey: `client-mem-${consumed.token.id}`,
      });
    } catch (e) {
      // The slot was already claimed above -- if order creation itself
      // fails (never reaching a payment_orders row that could later
      // resolve to FAILED/CANCELLED and release it through the normal
      // path), release it here so it doesn't leak forever.
      await releaseCapacitySlot(db, consumed.token.org_id);
      throw e;
    }
    res.json({ order, gym: { id: org.id, name: org.name }, membershipPlan: plan });
  });

  r.post('/client/payment/verify', clientOnly, scanLimit, validate(z.object({
    orderId: z.string().min(1), providerPaymentId: z.string().min(1), signature: z.string().min(1),
  })), async (req, res) => {
    const order = await db.q1(`SELECT * FROM payment_orders WHERE id = ? AND subject_type = 'CLIENT_MEMBERSHIP'`, [req.body.orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    // Two shapes share this one subject_type -- see the registered
    // activation handler's own branch for why: a fresh JOIN (client_id
    // still null -- the client row doesn't exist until activation, so
    // ownership is checked via the enrollment_tokens row instead) vs a
    // RENEWAL (client_id set at order-creation time, since the client
    // already exists -- see /client/renew).
    if (order.client_id) {
      const client = await db.q1('SELECT user_id FROM clients WHERE id = ?', [order.client_id]);
      if (!client || client.user_id !== req.user.sub) return res.status(403).json({ error: 'Not your payment' });
    } else {
      const enrollmentToken = await db.q1('SELECT consumed_by FROM enrollment_tokens WHERE id = ?', [order.subject_id]);
      if (!enrollmentToken || enrollmentToken.consumed_by !== req.user.sub) return res.status(403).json({ error: 'Not your payment' });
    }
    const result = await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: req.body.providerPaymentId, signature: req.body.signature });
    if (!result.ok) return res.status(422).json({ error: result.reason });
    if (!result.alreadyFinalized) await issueInvoice(db, order).catch(() => {});
    const client = await db.q1('SELECT id FROM clients WHERE user_id = ?', [req.user.sub]);
    // The activation handler just set users.org_id in the DB, but this
    // request's OWN JWT (still carrying org: null from before enrollment)
    // is immutable -- a fresh token is the only way the frontend's next
    // request (or a page reload reading the stored session) sees the
    // client's real org membership instead of stale "no gym yet" state.
    let token;
    if (client) {
      const freshUser = await db.q1('SELECT id, org_id, role, name, email FROM users WHERE id = ?', [req.user.sub]);
      token = signToken({ id: freshUser.id, org_id: freshUser.org_id, role: freshUser.role, name: freshUser.name, email: freshUser.email });
      setAuthCookie(res, token);
    }
    res.json({ ok: true, membershipActive: !!client, token });
  });

  /* ================= CLIENT: my membership ================= */
  // The one client-facing read of "what am I actually subscribed to,
  // where" -- the frontend's Membership page (and the renew button on
  // it) is the only consumer; no other client-facing route exposed this
  // before now.
  r.get('/client/membership', clientOnly, async (req, res) => {
    const client = await db.q1('SELECT id, org_id FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!client) return res.json({ membership: null });
    const subscription = await db.q1('SELECT * FROM subscriptions WHERE client_id = ? ORDER BY end_date DESC LIMIT 1', [client.id]);
    const org = client.org_id ? await db.q1('SELECT id, name FROM organizations WHERE id = ?', [client.org_id]) : null;
    res.json({ membership: subscription, gym: org });
  });

  /* ================= CLIENT: renew ================= */
  // No new capacity slot is reserved here -- the client is already
  // counted in activeClients (see getOrgBillingSnapshot), so renewing
  // doesn't compete for a slot the way a fresh join does.
  r.post('/client/renew', clientOnly, scanLimit, async (req, res) => {
    const client = await db.q1('SELECT id, org_id FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!client) return res.status(404).json({ error: 'not_a_client' });
    const subscription = await db.q1('SELECT * FROM subscriptions WHERE client_id = ? ORDER BY end_date DESC LIMIT 1', [client.id]);
    if (!subscription) return res.status(404).json({ error: 'no_membership_found' });
    if (['CANCELLED', 'REFUNDED', 'TRANSFERRED'].includes(subscription.lifecycle_status)) {
      return res.status(409).json({ error: 'membership_terminated' });
    }
    // Renews at the price the client is ALREADY locked into (their own
    // subscription row's own amount), never re-priced from today's
    // package rates -- a genuine plan CHANGE on renewal isn't built yet
    // (out of scope for this pass; would need its own quote step,
    // mirroring the org-level billing_quotes pattern).
    const order = await createPaymentOrder(db, {
      subjectType: 'CLIENT_MEMBERSHIP', subjectId: subscription.id, orgId: client.org_id, clientId: client.id,
      amount: subscription.amount, currency: subscription.currency,
      // Keyed to the subscription's CURRENT end_date -- a double-click
      // before this renewal's payment resolves reuses the SAME order
      // (createPaymentOrder's own idempotency_key dedup); once it
      // actually completes, end_date moves, so a later, genuinely NEW
      // renewal request naturally gets its own key instead of being
      // silently merged into the last one.
      idempotencyKey: `renew-${subscription.id}-${subscription.end_date}`,
    });
    res.json({ order, subscription });
  });

  /* ================= TRAINER: join (no payment) ================= */
  r.post('/trainer/join', trainerOnlyRole, scanLimit, validate(z.object({ payload: z.string().min(1) })), async (req, res) => {
    if (req.user.org) return res.status(409).json({ error: 'already_in_a_gym' });
    const alreadyTrainer = await db.q1('SELECT user_id FROM trainers WHERE user_id = ?', [req.user.sub]);
    if (alreadyTrainer) return res.status(409).json({ error: 'already_a_trainer' });

    const consumed = await consumeEnrollmentToken(db, req.body.payload, { expectedPurpose: 'TRAINER', consumedBy: req.user.sub });
    if (!consumed.ok) return res.status(422).json({ error: consumed.reason });
    const org = await db.q1('SELECT o.*, bs.status AS billing_status FROM organizations o LEFT JOIN org_billing_state bs ON bs.org_id = o.id WHERE o.id = ?', [consumed.token.org_id]);
    if (!org || org.billing_status !== 'ACTIVE') return res.status(409).json({ error: 'gym_not_active' });

    // Trainer capacity is unlimited and there's no payment step -- the
    // consumed QR activates the trainer immediately (spec: "If no
    // approval is required: activate immediately").
    await db.run('UPDATE users SET org_id = ? WHERE id = ?', [org.id, req.user.sub]);
    await db.run(`INSERT INTO trainers (user_id, org_id, status) VALUES (?, ?, 'ACTIVE')`, [req.user.sub, org.id]);
    await syncPrimaryMembership(db, { userId: req.user.sub, orgId: org.id, role: 'TRAINER' }).catch(() => {});
    await notifyOwners(db, org.id, { type: 'trainer_joined', title: 'A trainer joined your gym', data: { trainerId: req.user.sub } });
    await track(db, { type: 'trainer_enrolled', orgId: org.id, userId: req.user.sub, data: { tokenId: consumed.token.id } }).catch(() => {});
    // Fresh token: this activation is synchronous (no payment step), so
    // unlike the client path above, org membership is real by the time
    // this response goes out -- the OLD token (org: null) would still
    // be stale otherwise. See the client/payment/verify route's own
    // comment for the full reasoning.
    const token = signToken({ id: req.user.sub, org_id: org.id, role: 'TRAINER', name: req.user.name, email: req.user.email });
    setAuthCookie(res, token);
    res.json({ ok: true, gym: { id: org.id, name: org.name }, token });
  });

  return r;
}
