// ============================================================
// ADMIN CONSOLE API — platform-operator surface, deliberately
// SEPARATE from every existing gym-owner-facing route. Mounted at
// /api/console (never /api/admin or /api/business -- both of those
// are already fully owned by admin.js's 14 owner-facing, org-scoped
// routes; see that file's own header comment).
//
// SUPER_ADMIN only, gated the SAME way as everywhere else in this
// codebase (requireAuth + requireRole -- see auth.js) rather than a
// second, parallel auth mechanism: SUPER_ADMIN has zero existing
// bootstrap path anywhere (see scripts/create-super-admin.js, the
// ONLY way such an account can ever be created), so reusing the
// proven JWT/requireAuth machinery is the safer choice over inventing
// a genuinely separate admin session system this pass doesn't have
// time to harden as thoroughly.
//
// Every SENSITIVE (mutating) action here writes an admin_audit_logs
// row via writeAuditLog() below -- the ONLY thing in this codebase
// that inserts into that table. Read-only routes (dashboard, lists,
// detail views) do not.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { id, now } from '../ids.js';
import { dayKey } from '../utils/time.js';
import { runReconciliationSweep, listReconciliationIssues, resolveReconciliationIssue } from '../services/payments/reconciliation.js';
import { initiateRefund, listRefunds } from '../services/payments/refunds.js';
import { listTicketsPlatformWide, getTicket, listMessages, addMessage, updateTicketStatus, updateTicketPriority, assignTicket } from '../services/support/tickets.js';
import {
  getFoodIntelligenceOverview, getActivityTimeSeries, getProviderPerformance,
  getTopFoods, getMostCorrectedFoods, getReviewQueue, verifyFoodEstimate, rejectFoodEstimatePromotion, getDataQuality,
} from '../services/intelligence/foodIntelligenceDashboard.js';
import { runRiskScan, listRiskEvents, markReviewing, resolveRiskEvent } from '../services/risk/riskEngine.js';
import { getMlMonitoringOverview, getEstimateStats, getEstimateActivity, getMlHealth } from '../services/intelligence/mlMonitoringDashboard.js';
import { listFeatureFlags, createFeatureFlag, updateFeatureFlag, deleteFeatureFlag } from '../services/platform/featureFlags.js';
import { listAnnouncements, listActiveAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement } from '../services/platform/announcements.js';
import { listPlatformErrors, getSystemHealth } from '../services/platform/systemHealth.js';
import { toCsv } from '../services/platform/csv.js';

const safeParse = (json) => { try { return JSON.parse(json || 'null'); } catch { return null; } };

export default function consoleRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('SUPER_ADMIN'));
  // Stronger baseline than the ordinary owner-facing routers -- the
  // Admin Console is the most sensitive surface in this codebase (spec:
  // "Admin endpoints need stronger protections than ordinary user
  // endpoints").
  r.use(rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => req.user?.sub || 'anon' }));

  // Takes an explicit db-like handle (a `tx` when called inside
  // db.tx(), the plain `db` otherwise) rather than always closing over
  // the outer `db` -- a mutation + its audit record must land in the
  // SAME transaction wherever the mutation is itself a single atomic
  // write, so a failure writing the audit row rolls the mutation back
  // too instead of leaving a dangerous action applied with no trail and
  // the caller told it failed (caught live: suspending a gym succeeded
  // at the DB but the whole request 500'd on a stale-schema audit
  // insert, silently desyncing "what happened" from "what the admin was
  // told happened").
  async function writeAuditLog(dbLike, req, { action, entityType = null, entityId = null, before = null, after = null }) {
    await dbLike.run(
      `INSERT INTO admin_audit_logs (id, admin_id, action, entity_type, entity_id, before_json, after_json, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('aal'), req.user.sub, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, req.ip || null, now()]);
  }

  // ---- dashboard: real aggregate KPIs, never fabricated -- an empty
  // platform shows zeros, not example numbers (spec: "NEVER hardcode... if
  // no data exists, show 'No data yet' rather than fake numbers") ----
  r.get('/dashboard', async (req, res) => {
    const todayStart = dayKey() + 'T00:00:00.000Z';
    const monthStart = dayKey().slice(0, 7) + '-01T00:00:00.000Z';
    const [gyms, activeGyms, clients, trainers, activeMemberships, revenueToday, revenueMonth, refunds, openIssues, failuresToday, openTickets] = await Promise.all([
      db.q1(`SELECT COUNT(*) AS n FROM organizations WHERE type = 'gym'`),
      db.q1(`SELECT COUNT(*) AS n FROM org_billing_state WHERE status = 'ACTIVE'`),
      db.q1(`SELECT COUNT(*) AS n FROM clients`),
      db.q1(`SELECT COUNT(*) AS n FROM trainers`),
      db.q1(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'`),
      db.q1(`SELECT COALESCE(SUM(amount), 0) AS total FROM payment_orders WHERE status = 'SUCCESS' AND created_at >= ?`, [todayStart]),
      db.q1(`SELECT COALESCE(SUM(amount), 0) AS total FROM payment_orders WHERE status = 'SUCCESS' AND created_at >= ?`, [monthStart]),
      db.q1(`SELECT COUNT(*) AS n FROM refunds WHERE status = 'SUCCESS'`),
      db.q1(`SELECT COUNT(*) AS n FROM reconciliation_issues WHERE status = 'OPEN'`),
      db.q1(`SELECT COUNT(*) AS n FROM payment_orders WHERE status = 'FAILED' AND created_at >= ?`, [todayStart]),
      db.q1(`SELECT COUNT(*) AS n FROM support_tickets WHERE status IN ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_GYM')`),
    ]);
    res.json({
      totalGyms: Number(gyms?.n || 0),
      activeGyms: Number(activeGyms?.n || 0),
      totalClients: Number(clients?.n || 0),
      totalTrainers: Number(trainers?.n || 0),
      activeMemberships: Number(activeMemberships?.n || 0),
      revenueToday: Number(revenueToday?.total || 0),
      revenueThisMonth: Number(revenueMonth?.total || 0),
      totalRefunds: Number(refunds?.n || 0),
      openReconciliationIssues: Number(openIssues?.n || 0),
      paymentFailuresToday: Number(failuresToday?.n || 0),
      openSupportTickets: Number(openTickets?.n || 0),
    });
  });

  // ---- gyms ----
  r.get('/gyms', async (req, res) => {
    const search = req.query.search ? `%${String(req.query.search).slice(0, 100)}%` : null;
    const rows = await db.q(
      `SELECT o.id, o.name, o.slug, o.type, o.created_at, bs.status AS billing_status,
              (SELECT COUNT(*) FROM clients c WHERE c.org_id = o.id) AS client_count,
              (SELECT COUNT(*) FROM trainers t WHERE t.org_id = o.id) AS trainer_count
         FROM organizations o LEFT JOIN org_billing_state bs ON bs.org_id = o.id
        WHERE o.type = 'gym' ${search ? 'AND o.name LIKE ?' : ''}
        ORDER BY o.created_at DESC LIMIT 200`,
      search ? [search] : []);
    res.json({ gyms: rows.map((g) => ({ ...g, client_count: Number(g.client_count || 0), trainer_count: Number(g.trainer_count || 0) })) });
  });

  r.get('/gyms/:id', async (req, res) => {
    const org = await db.q1('SELECT * FROM organizations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Gym not found' });
    const [billing, subscription, owner, clientCount, trainerCount, branches] = await Promise.all([
      db.q1('SELECT * FROM org_billing_state WHERE org_id = ?', [org.id]),
      db.q1(`SELECT * FROM org_subscriptions WHERE org_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`, [org.id]),
      db.q1(`SELECT id, name, email FROM users WHERE org_id = ? AND role = 'GYM_OWNER' LIMIT 1`, [org.id]),
      db.q1('SELECT COUNT(*) AS n FROM clients WHERE org_id = ?', [org.id]),
      db.q1('SELECT COUNT(*) AS n FROM trainers WHERE org_id = ?', [org.id]),
      db.q('SELECT * FROM branches WHERE org_id = ?', [org.id]),
    ]);
    res.json({
      org, billing, subscription, owner, branches,
      clientCount: Number(clientCount?.n || 0), trainerCount: Number(trainerCount?.n || 0),
    });
  });

  const dangerousGymAction = rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.user?.sub || 'anon' });

  r.post('/gyms/:id/suspend', dangerousGymAction, validate(z.object({ reason: z.string().max(500).optional() })), async (req, res) => {
    const before = await db.q1('SELECT * FROM org_billing_state WHERE org_id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Gym not found' });
    await db.tx(async (tx) => {
      await tx.run(`UPDATE org_billing_state SET status = 'SUSPENDED', updated_at = ? WHERE org_id = ?`, [now(), req.params.id]);
      await writeAuditLog(tx, req, { action: 'gym_suspended', entityType: 'organization', entityId: req.params.id, before, after: { status: 'SUSPENDED', reason: req.body.reason || null } });
    });
    res.json({ ok: true });
  });

  r.post('/gyms/:id/reactivate', dangerousGymAction, async (req, res) => {
    const before = await db.q1('SELECT * FROM org_billing_state WHERE org_id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Gym not found' });
    await db.tx(async (tx) => {
      await tx.run(`UPDATE org_billing_state SET status = 'ACTIVE', updated_at = ? WHERE org_id = ?`, [now(), req.params.id]);
      await writeAuditLog(tx, req, { action: 'gym_reactivated', entityType: 'organization', entityId: req.params.id, before, after: { status: 'ACTIVE' } });
    });
    res.json({ ok: true });
  });

  // ---- payments (platform-wide -- the one place this legitimately
  // reads across every org at once) ----
  r.get('/payments', async (req, res) => {
    const rows = await db.q(
      `SELECT p.*, o.name AS org_name FROM payment_orders p JOIN organizations o ON o.id = p.org_id ORDER BY p.created_at DESC LIMIT 200`);
    res.json({ payments: rows });
  });

  // ---- gym's OWN SK OS payment refund (ORG_PACKAGE / ORG_CAPACITY_ADDON
  // only -- a CLIENT_MEMBERSHIP refund is the owner's own call to make
  // about their own client and already has its route in admin.js;
  // refunding what the GYM paid SK OS is a platform decision, so it
  // lives here instead). initiateRefund() itself is subject-type-
  // agnostic (see refunds.js) -- the restriction below is deliberate
  // scope, not a technical limitation.
  //
  // NOT wrapped in db.tx() with its audit entry, unlike suspend/
  // reactivate above -- initiateRefund() makes a real network call to
  // the payment provider partway through its own sequence of writes
  // (see refunds.js), and holding a DB transaction open across that
  // network round-trip is exactly the kind of long-held-lock mistake
  // this codebase avoids elsewhere (same reasoning admin.js's own
  // CLIENT_MEMBERSHIP refund route already follows). Each of
  // initiateRefund's own writes is independently durable by the time it
  // returns, so -- like the reconciliation sweep's own audit entry just
  // above -- this is a best-effort summary record, not paired atomically
  // with a single mutation. ----
  r.post('/gyms/:id/payments/:orderId/refund', dangerousGymAction, validate(z.object({
    amount: z.number().positive().optional(), reason: z.string().max(500).optional(),
  })), async (req, res) => {
    const order = await db.q1('SELECT * FROM payment_orders WHERE id = ? AND org_id = ?', [req.params.orderId, req.params.id]);
    if (!order) return res.status(404).json({ error: 'Payment order not found for this gym' });
    if (!['ORG_PACKAGE', 'ORG_CAPACITY_ADDON'].includes(order.subject_type)) {
      return res.status(400).json({ error: 'not_an_org_payment', message: 'Client membership refunds are issued by the gym owner, not the platform console.' });
    }
    const result = await initiateRefund(db, { orderId: order.id, orgId: req.params.id, amount: req.body.amount, reason: req.body.reason, initiatedBy: req.user.sub });
    if (!result.ok) return res.status(422).json({ error: result.reason, ...result });
    await writeAuditLog(db, req, {
      action: 'org_payment_refunded', entityType: 'payment_order', entityId: order.id,
      before: { status: order.status }, after: { status: result.orderStatus, refundId: result.refund.id, amount: result.refund.amount, orgSubscriptionCancelled: result.orgSubscriptionCancelled },
    });
    res.json(result);
  });

  r.get('/gyms/:id/payments/:orderId/refunds', async (req, res) => {
    const order = await db.q1('SELECT id FROM payment_orders WHERE id = ? AND org_id = ?', [req.params.orderId, req.params.id]);
    if (!order) return res.status(404).json({ error: 'Payment order not found for this gym' });
    res.json({ refunds: await listRefunds(db, { orgId: req.params.id, orderId: order.id }) });
  });

  // ---- refunds, platform-wide (the Refunds nav item -- separate from
  // the per-gym history above, which is scoped to one order). Same
  // shape as /payments: no pagination, matching that route's own
  // existing choice, capped at a sane LIMIT. Joins the initiating
  // admin's name in for the "Requested by" column -- initiated_by is
  // NULL for a gym-owner-initiated CLIENT_MEMBERSHIP refund (that flow
  // lives in admin.js, not here), so the LEFT JOIN degrades to null
  // rather than dropping the row. ----
  r.get('/refunds', async (req, res) => {
    const status = ['REQUESTED', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED'].includes(req.query.status) ? req.query.status : null;
    const rows = await db.q(
      `SELECT rf.*, o.name AS org_name, u.name AS initiated_by_name
         FROM refunds rf
         JOIN organizations o ON o.id = rf.org_id
         LEFT JOIN users u ON u.id = rf.initiated_by
        ${status ? 'WHERE rf.status = ?' : ''}
        ORDER BY rf.created_at DESC LIMIT 200`,
      status ? [status] : []);
    res.json({ refunds: rows });
  });

  // ---- reconciliation (platform-wide -- reuses Phase 1's engine
  // completely unchanged, just without an org filter) ----
  r.post('/reconciliation/run', async (req, res) => {
    // The sweep itself already commits each order's outcome independently
    // (see reconciliation.js) -- by the time a summary exists, every
    // underlying write is already durable, so this audit entry is a
    // best-effort SUMMARY record, not paired atomically with a single
    // mutation the way suspend/reactivate/resolve are below.
    const summary = await runReconciliationSweep(db, { orgId: null });
    await writeAuditLog(db, req, { action: 'platform_reconciliation_run', after: summary });
    res.json(summary);
  });

  r.get('/reconciliation', async (req, res) => {
    const status = ['OPEN', 'RESOLVED', 'DISMISSED'].includes(req.query.status) ? req.query.status : null;
    const issues = await listReconciliationIssues(db, { orgId: null, status });
    res.json({ issues: issues.map((i) => ({ ...i, expected_json: safeParse(i.expected_json), actual_json: safeParse(i.actual_json) })) });
  });

  r.post('/reconciliation/:id/resolve', validate(z.object({ note: z.string().max(500).optional(), dismiss: z.boolean().optional() })), async (req, res) => {
    let ok = false;
    await db.tx(async (tx) => {
      ok = await resolveReconciliationIssue(tx, { orgId: null, issueId: req.params.id, resolvedBy: req.user.sub, note: req.body.note, dismiss: !!req.body.dismiss });
      if (ok) await writeAuditLog(tx, req, { action: req.body.dismiss ? 'reconciliation_issue_dismissed' : 'reconciliation_issue_resolved', entityType: 'reconciliation_issue', entityId: req.params.id });
    });
    if (!ok) return res.status(409).json({ error: 'Issue not found or already resolved' });
    res.json({ ok: true });
  });

  // ---- support tickets (Phase 3b) -- platform-wide, INCLUDING internal
  // admin notes (the owner-facing route in admin.js always passes
  // includeInternal: false; this is the one caller allowed to see them) ----
  r.get('/support', async (req, res) => {
    const status = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_GYM', 'RESOLVED', 'CLOSED'].includes(req.query.status) ? req.query.status : null;
    const priority = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(req.query.priority) ? req.query.priority : null;
    const tickets = await listTicketsPlatformWide(db, { status, priority });
    res.json({ tickets });
  });

  r.get('/support/:id', async (req, res) => {
    const ticket = await getTicket(db, { ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    // getTicket() itself never joins org_name (the owner-facing caller
    // in admin.js already knows its own org and doesn't need it) --
    // the console UI's ticket header/detail panel does, same as the
    // platform-wide list already provides via listTicketsPlatformWide().
    const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [ticket.org_id]);
    const messages = await listMessages(db, { ticketId: ticket.id, includeInternal: true });
    res.json({ ticket: { ...ticket, org_name: org?.name || null }, messages });
  });

  r.post('/support/:id/messages', validate(z.object({ body: z.string().min(1).max(4000), internal: z.boolean().optional() })), async (req, res) => {
    const ticket = await getTicket(db, { ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const message = await addMessage(db, { ticketId: ticket.id, authorId: req.user.sub, body: req.body.body, internal: !!req.body.internal });
    res.status(201).json({ message });
  });

  r.post('/support/:id/status', validate(z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_FOR_GYM', 'RESOLVED', 'CLOSED']) })), async (req, res) => {
    const before = await getTicket(db, { ticketId: req.params.id });
    if (!before) return res.status(404).json({ error: 'Ticket not found' });
    await db.tx(async (tx) => {
      await updateTicketStatus(tx, { ticketId: req.params.id, status: req.body.status });
      await writeAuditLog(tx, req, { action: 'support_ticket_status_changed', entityType: 'support_ticket', entityId: req.params.id, before: { status: before.status }, after: { status: req.body.status } });
    });
    res.json({ ok: true });
  });

  r.post('/support/:id/priority', validate(z.object({ priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']) })), async (req, res) => {
    const before = await getTicket(db, { ticketId: req.params.id });
    if (!before) return res.status(404).json({ error: 'Ticket not found' });
    let ok = false;
    await db.tx(async (tx) => {
      ok = await updateTicketPriority(tx, { ticketId: req.params.id, priority: req.body.priority });
      if (ok) await writeAuditLog(tx, req, { action: 'support_ticket_priority_changed', entityType: 'support_ticket', entityId: req.params.id, before: { priority: before.priority }, after: { priority: req.body.priority } });
    });
    res.json({ ok: true });
  });

  // adminId nullable -- an empty selection unassigns the ticket rather
  // than being rejected, matching the "Unassigned" option the picker
  // itself offers.
  r.post('/support/:id/assign', validate(z.object({ adminId: z.string().min(1).nullable() })), async (req, res) => {
    const before = await getTicket(db, { ticketId: req.params.id });
    if (!before) return res.status(404).json({ error: 'Ticket not found' });
    if (req.body.adminId) {
      const admin = await db.q1(`SELECT id FROM users WHERE id = ? AND role = 'SUPER_ADMIN'`, [req.body.adminId]);
      if (!admin) return res.status(422).json({ error: 'adminId must be an existing SUPER_ADMIN' });
    }
    let ok = false;
    await db.tx(async (tx) => {
      ok = await assignTicket(tx, { ticketId: req.params.id, adminId: req.body.adminId });
      if (ok) await writeAuditLog(tx, req, { action: req.body.adminId ? 'support_ticket_assigned' : 'support_ticket_unassigned', entityType: 'support_ticket', entityId: req.params.id, before: { assignedAdminId: before.assigned_admin_id }, after: { assignedAdminId: req.body.adminId } });
    });
    res.json({ ok: true });
  });

  // ---- SUPER_ADMIN roster -- for the support-ticket assignment picker.
  // Never returns password_hash or anything beyond the three fields the
  // picker actually needs. ----
  r.get('/admins', async (req, res) => {
    const admins = await db.q(`SELECT id, name, email FROM users WHERE role = 'SUPER_ADMIN' AND active = 1 ORDER BY name`);
    res.json({ admins });
  });

  // ---- Food Intelligence dashboard (Phase 3b) -- see
  // foodIntelligenceDashboard.js's own header comment for exactly which
  // real tables/events back every number here. Read-only except the
  // review-queue actions, which are the one human-verification step
  // this codebase's own food-feedback design has always reserved. ----
  r.get('/intelligence/food/overview', async (req, res) => {
    res.json(await getFoodIntelligenceOverview(db));
  });

  r.get('/intelligence/food/activity', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    res.json({ days: await getActivityTimeSeries(db, { days }) });
  });

  r.get('/intelligence/food/providers', async (req, res) => {
    res.json({ providers: await getProviderPerformance(db) });
  });

  r.get('/intelligence/food/top-foods', async (req, res) => {
    res.json({ foods: await getTopFoods(db, { limit: 30 }) });
  });

  r.get('/intelligence/food/most-corrected', async (req, res) => {
    res.json({ foods: await getMostCorrectedFoods(db, { limit: 30 }) });
  });

  r.get('/intelligence/food/review-queue', async (req, res) => {
    res.json({ items: await getReviewQueue(db) });
  });

  r.post('/intelligence/food/review-queue/:canonicalKey/verify', async (req, res) => {
    const ok = await verifyFoodEstimate(db, { canonicalKey: req.params.canonicalKey });
    if (!ok) return res.status(409).json({ error: 'Not a pending review candidate (already resolved or not found)' });
    await writeAuditLog(db, req, { action: 'food_estimate_verified', entityType: 'ai_food_estimate', entityId: req.params.canonicalKey });
    res.json({ ok: true });
  });

  r.post('/intelligence/food/review-queue/:canonicalKey/reject', async (req, res) => {
    const ok = await rejectFoodEstimatePromotion(db, { canonicalKey: req.params.canonicalKey });
    if (!ok) return res.status(409).json({ error: 'Not a pending review candidate (already resolved or not found)' });
    await writeAuditLog(db, req, { action: 'food_estimate_promotion_rejected', entityType: 'ai_food_estimate', entityId: req.params.canonicalKey });
    res.json({ ok: true });
  });

  r.get('/intelligence/food/data-quality', async (req, res) => {
    res.json(await getDataQuality(db));
  });

  // ---- ML monitoring (calorie model) -- see mlMonitoringDashboard.js's
  // own header for exactly which real tables/events back every number
  // here (persisted `workouts` columns for what actually ran, plus two
  // new event types this pass added for fallback/quality telemetry that
  // simply didn't exist to aggregate before). Read-only -- there is
  // nothing here to verify/reject/act on, unlike the food review queue. ----
  r.get('/intelligence/ml/overview', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    res.json(await getMlMonitoringOverview(db, { days }));
  });

  r.get('/intelligence/ml/estimates', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    res.json(await getEstimateStats(db, { days }));
  });

  r.get('/intelligence/ml/activity', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    res.json({ days: await getEstimateActivity(db, { days }) });
  });

  r.get('/intelligence/ml/health', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    res.json(await getMlHealth(db, { days }));
  });

  // ---- Fraud / risk monitoring (Phase 3b) -- see riskEngine.js's own
  // header comment for exactly which (honest, actually-collected)
  // signals this scans, and why "same device/IP" is deliberately not
  // one of them. Flags for review ONLY -- nothing here ever
  // suspends/bans/revokes automatically. ----
  r.post('/risk/scan', async (req, res) => {
    const summary = await runRiskScan(db, { orgId: null });
    await writeAuditLog(db, req, { action: 'risk_scan_run', after: summary });
    res.json(summary);
  });

  r.get('/risk', async (req, res) => {
    const status = ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'].includes(req.query.status) ? req.query.status : null;
    const events = await listRiskEvents(db, { orgId: null, status });
    res.json({ events: events.map((e) => ({ ...e, detail_json: safeParse(e.detail_json) })) });
  });

  r.post('/risk/:id/review', async (req, res) => {
    const ok = await markReviewing(db, { eventId: req.params.id });
    if (!ok) return res.status(409).json({ error: 'Not an open risk event' });
    res.json({ ok: true });
  });

  r.post('/risk/:id/resolve', validate(z.object({ note: z.string().max(500).optional(), dismiss: z.boolean().optional() })), async (req, res) => {
    let ok = false;
    await db.tx(async (tx) => {
      ok = await resolveRiskEvent(tx, { eventId: req.params.id, resolvedBy: req.user.sub, note: req.body.note, dismiss: !!req.body.dismiss });
      if (ok) await writeAuditLog(tx, req, { action: req.body.dismiss ? 'risk_event_dismissed' : 'risk_event_resolved', entityType: 'risk_event', entityId: req.params.id });
    });
    if (!ok) return res.status(409).json({ error: 'Risk event not found or already resolved' });
    res.json({ ok: true });
  });

  // ---- feature flags (Phase 3c) -- global on/off, percentage rollout,
  // and an explicit per-org allow-list; see featureFlags.js's own header
  // for exactly what isFeatureEnabled() evaluates. This pass builds the
  // store + evaluation function only -- no EXISTING feature checks a
  // flag yet, matching that file's stated scope. ----
  r.get('/features', async (req, res) => {
    res.json({ flags: await listFeatureFlags(db) });
  });

  r.post('/features', validate(z.object({
    key: z.string().min(1).max(100).regex(/^[a-z0-9_.-]+$/, 'lowercase letters, digits, underscore, dot, dash only'),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
  })), async (req, res) => {
    const result = await createFeatureFlag(db, { key: req.body.key, name: req.body.name, description: req.body.description, createdBy: req.user.sub });
    if (!result.ok) return res.status(409).json({ error: 'A flag with this key already exists' });
    await writeAuditLog(db, req, { action: 'feature_flag_created', entityType: 'feature_flag', entityId: result.id, after: { key: req.body.key, name: req.body.name } });
    res.status(201).json({ id: result.id });
  });

  r.post('/features/:id', validate(z.object({
    enabled: z.boolean().optional(),
    rolloutPercentage: z.number().int().min(0).max(100).optional(),
    enabledOrgIds: z.array(z.string()).optional(),
  })), async (req, res) => {
    let result;
    await db.tx(async (tx) => {
      result = await updateFeatureFlag(tx, { id: req.params.id, enabled: req.body.enabled, rolloutPercentage: req.body.rolloutPercentage, enabledOrgIds: req.body.enabledOrgIds });
      if (result.ok) await writeAuditLog(tx, req, { action: 'feature_flag_updated', entityType: 'feature_flag', entityId: req.params.id, before: result.before, after: result.after });
    });
    if (!result.ok) return res.status(404).json({ error: 'Flag not found' });
    res.json({ flag: result.after });
  });

  r.delete('/features/:id', async (req, res) => {
    const existing = await db.q1('SELECT * FROM feature_flags WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Flag not found' });
    await db.tx(async (tx) => {
      await deleteFeatureFlag(tx, { id: req.params.id });
      await writeAuditLog(tx, req, { action: 'feature_flag_deleted', entityType: 'feature_flag', entityId: req.params.id, before: existing });
    });
    res.json({ ok: true });
  });

  // ---- platform announcements (Phase 3c) -- CRUD + an "active right
  // now" preview reusing the exact lazy-window check any future
  // consumer (a frontend/ banner, none exists yet) would call. ----
  r.get('/announcements', async (req, res) => {
    res.json({ announcements: await listAnnouncements(db) });
  });

  r.get('/announcements/active', async (req, res) => {
    const audience = ['ALL', 'OWNERS', 'TRAINERS', 'CLIENTS'].includes(req.query.audience) ? req.query.audience : 'ALL';
    res.json({ announcements: await listActiveAnnouncements(db, { audience }) });
  });

  const announcementBody = {
    title: z.string().min(1).max(200),
    message: z.string().min(1).max(4000),
    audience: z.enum(['ALL', 'OWNERS', 'TRAINERS', 'CLIENTS']).optional(),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
    startsAt: z.string().nullable().optional(),
    endsAt: z.string().nullable().optional(),
  };

  r.post('/announcements', validate(z.object(announcementBody)), async (req, res) => {
    const announcementId = await createAnnouncement(db, { ...req.body, createdBy: req.user.sub });
    await writeAuditLog(db, req, { action: 'announcement_created', entityType: 'platform_announcement', entityId: announcementId, after: req.body });
    res.status(201).json({ id: announcementId });
  });

  r.post('/announcements/:id', validate(z.object({ ...announcementBody, title: announcementBody.title.optional(), message: announcementBody.message.optional() })), async (req, res) => {
    let updated;
    await db.tx(async (tx) => {
      updated = await updateAnnouncement(tx, { id: req.params.id, ...req.body });
      if (updated) await writeAuditLog(tx, req, { action: 'announcement_updated', entityType: 'platform_announcement', entityId: req.params.id, after: req.body });
    });
    if (!updated) return res.status(404).json({ error: 'Announcement not found' });
    res.json({ announcement: updated });
  });

  r.delete('/announcements/:id', async (req, res) => {
    const existing = await db.q1('SELECT * FROM platform_announcements WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Announcement not found' });
    await db.tx(async (tx) => {
      await deleteAnnouncement(tx, { id: req.params.id });
      await writeAuditLog(tx, req, { action: 'announcement_deleted', entityType: 'platform_announcement', entityId: req.params.id, before: existing });
    });
    res.json({ ok: true });
  });

  // ---- system health + error center (Phase 3c) -- see
  // systemHealth.js's own header for exactly which signals are real
  // (DB round-trip, real config summaries, real error counts) vs
  // deliberately absent (no external uptime probe exists). ----
  r.get('/system/health', async (req, res) => {
    res.json(await getSystemHealth(db));
  });

  r.get('/system/errors', async (req, res) => {
    const type = ['server_error', 'client_error'].includes(req.query.type) ? req.query.type : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ errors: await listPlatformErrors(db, { type, limit }) });
  });

  // ---- data export (Phase 3c) -- CSV, explicit column allow-listing
  // only (see csv.js's own header comment) so a secret/hash column can
  // never leak through here regardless of what a table later gains. ----
  function sendCsv(res, filename, csv) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  r.get('/export/gyms', async (req, res) => {
    const rows = await db.q(
      `SELECT o.id, o.name, o.slug, o.created_at, bs.status AS billing_status,
              (SELECT COUNT(*) FROM clients c WHERE c.org_id = o.id) AS client_count,
              (SELECT COUNT(*) FROM trainers t WHERE t.org_id = o.id) AS trainer_count
         FROM organizations o LEFT JOIN org_billing_state bs ON bs.org_id = o.id
        WHERE o.type = 'gym' ORDER BY o.created_at DESC`);
    const csv = toCsv(rows, [
      { header: 'id', value: 'id' }, { header: 'name', value: 'name' }, { header: 'slug', value: 'slug' },
      { header: 'billing_status', value: 'billing_status' }, { header: 'client_count', value: 'client_count' },
      { header: 'trainer_count', value: 'trainer_count' }, { header: 'created_at', value: 'created_at' },
    ]);
    await writeAuditLog(db, req, { action: 'data_export', entityType: 'export', after: { export: 'gyms', rowCount: rows.length } });
    sendCsv(res, 'gyms.csv', csv);
  });

  r.get('/export/payments', async (req, res) => {
    const rows = await db.q(
      `SELECT p.id, p.org_id, o.name AS org_name, p.subject_type, p.amount, p.currency, p.status, p.created_at
         FROM payment_orders p JOIN organizations o ON o.id = p.org_id ORDER BY p.created_at DESC LIMIT 5000`);
    const csv = toCsv(rows, [
      { header: 'id', value: 'id' }, { header: 'org_id', value: 'org_id' }, { header: 'org_name', value: 'org_name' },
      { header: 'subject_type', value: 'subject_type' }, { header: 'amount', value: 'amount' }, { header: 'currency', value: 'currency' },
      { header: 'status', value: 'status' }, { header: 'created_at', value: 'created_at' },
    ]);
    await writeAuditLog(db, req, { action: 'data_export', entityType: 'export', after: { export: 'payments', rowCount: rows.length } });
    sendCsv(res, 'payments.csv', csv);
  });

  r.get('/export/refunds', async (req, res) => {
    const rows = await db.q(
      `SELECT rf.id, rf.org_id, o.name AS org_name, rf.payment_order_id, rf.type, rf.amount, rf.currency, rf.status, rf.reason, rf.created_at
         FROM refunds rf JOIN organizations o ON o.id = rf.org_id ORDER BY rf.created_at DESC LIMIT 5000`);
    const csv = toCsv(rows, [
      { header: 'id', value: 'id' }, { header: 'org_id', value: 'org_id' }, { header: 'org_name', value: 'org_name' },
      { header: 'payment_order_id', value: 'payment_order_id' }, { header: 'type', value: 'type' }, { header: 'amount', value: 'amount' },
      { header: 'currency', value: 'currency' }, { header: 'status', value: 'status' }, { header: 'reason', value: 'reason' }, { header: 'created_at', value: 'created_at' },
    ]);
    await writeAuditLog(db, req, { action: 'data_export', entityType: 'export', after: { export: 'refunds', rowCount: rows.length } });
    sendCsv(res, 'refunds.csv', csv);
  });

  // ---- audit log viewer -- filterable + paginated. `q` is a plain
  // substring match against action/entity_type/entity_id (no full-text
  // index exists for this table, and its row volume doesn't warrant
  // one yet) -- good enough for "find the suspend on gym X" without
  // needing to scroll a 200-row page. ----
  r.get('/audit', async (req, res) => {
    const conds = []; const params = [];
    if (req.query.adminId) { conds.push('a.admin_id = ?'); params.push(req.query.adminId); }
    if (req.query.action) { conds.push('a.action = ?'); params.push(req.query.action); }
    if (req.query.entityType) { conds.push('a.entity_type = ?'); params.push(req.query.entityType); }
    if (req.query.since) { conds.push('a.created_at >= ?'); params.push(req.query.since); }
    if (req.query.until) { conds.push('a.created_at <= ?'); params.push(req.query.until); }
    if (req.query.q) { conds.push('(a.action LIKE ? OR a.entity_type LIKE ? OR a.entity_id LIKE ?)'); const like = `%${req.query.q}%`; params.push(like, like, like); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const [rows, totalRow] = await Promise.all([
      db.q(`SELECT a.*, u.name AS admin_name, u.email AS admin_email FROM admin_audit_logs a JOIN users u ON u.id = a.admin_id ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      db.q1(`SELECT COUNT(*) AS n FROM admin_audit_logs a ${where}`, params),
    ]);
    res.json({
      logs: rows.map((l) => ({ ...l, before_json: safeParse(l.before_json), after_json: safeParse(l.after_json) })),
      total: Number(totalRow?.n || 0), limit, offset,
    });
  });

  return r;
}
