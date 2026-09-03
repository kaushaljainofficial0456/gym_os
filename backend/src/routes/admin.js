import { Router } from 'express';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { z } from 'zod';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { id, now } from '../ids.js';
import { dayKey, addDays } from '../utils/time.js';
import { track } from '../services/events.js';
import { computeOccupancy } from '../services/occupancy.js';
import { transitionMembership } from '../services/enterprise/membershipLifecycle.js';
import { runReconciliationSweep, listReconciliationIssues, resolveReconciliationIssue } from '../services/payments/reconciliation.js';
import { initiateRefund, listRefunds } from '../services/payments/refunds.js';
import { requirePermission } from '../permissions.js';
import { createTicket, listTicketsForOrg, getTicket, listMessages, addMessage } from '../services/support/tickets.js';

export default function adminRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('GYM_OWNER', 'SUPER_ADMIN'), orgScope);

  // subscriptions/payments/attendance all take a client_id straight from the
  // request body (not the URL, so resolveClient's usual path-param flow
  // doesn't apply) and, unlike every other client_id-bearing write route in
  // this codebase, were never checking it belongs to the authenticated org
  // before using it — an owner in one org could hand-craft a client_id
  // belonging to a DIFFERENT org and the INSERT would silently attach a
  // subscription/payment/attendance row to it. Client ids are unguessable
  // random strings (see ids.js), so this was low practical exploitability,
  // not a live incident — but it's exactly the tenant-isolation gap this
  // audit exists to close, and every other write route in the app already
  // enforces it. Real behavior for every legitimate caller is unchanged:
  // the frontend only ever sends client ids from this org's own client list.
  // Returns the client row if it belongs to this org, else writes a 404
  // and returns null (mirrors resolveClient's not-found shape in auth.js).
  async function requireOrgClient(req, res, clientId) {
    const client = await db.q1('SELECT * FROM clients WHERE id = ? AND org_id = ?', [clientId, req.orgId]);
    if (!client) { res.status(404).json({ error: 'Client not found' }); return null; }
    return client;
  }

  const safeParse = (json) => { try { return JSON.parse(json || 'null'); } catch { return null; } };

  r.get('/overview', async (req, res) => {
    const orgId = req.orgId;
    const clients = await db.q('SELECT * FROM clients WHERE org_id = ?', [orgId]);
    const today = dayKey();
    const monthStart = today.slice(0, 7) + '-01';
    // First day of the month 5 months back -- e.g. today in 2026-09 -> 2026-04-01.
    // Widened from `monthStart` alone: a real bug, found live while auditing
    // this route -- `payments` used to be fetched ONLY from `monthStart`
    // onward, then the loop below tried to build a "last 6 months" trend by
    // filtering THAT SAME month-scoped array. Every month except the
    // current one could only ever match zero rows, so the Business
    // dashboard's "Revenue · 6 months" chart silently showed 0 for the 5
    // prior months regardless of actual payment history -- and, worse,
    // fell into the "No revenue recorded yet" empty state whenever the
    // CURRENT month happened to have no payments yet, even for a gym with
    // a real revenue history. Fixing the query window is the actual fix;
    // `monthlyRevenue` below is now filtered back down to just this month
    // from the wider set, so it keeps reporting exactly what it did before.
    const trendStart = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 5); return d.toISOString().slice(0, 10); })();

    const [payments, subs, renewalsDue, overdue, attendance, packages, activeSubs] = await Promise.all([
      db.q('SELECT amount, paid_at FROM payments WHERE org_id = ? AND paid_at >= ?', [orgId, trendStart]),
      db.q(`SELECT * FROM subscriptions WHERE org_id = ?`, [orgId]),
      db.q(`SELECT COUNT(*) AS n FROM subscriptions WHERE org_id = ? AND renewal_date <= ? AND status = 'active'`,
        [orgId, addDays(new Date(), 30).toISOString().slice(0, 10)]),
      db.q(`SELECT COUNT(*) AS n FROM subscriptions WHERE org_id = ? AND status = 'overdue'`, [orgId]),
      db.q('SELECT COUNT(*) AS n FROM attendance WHERE org_id = ? AND date = ?', [orgId, today]),
      db.q('SELECT * FROM packages WHERE org_id = ?', [orgId]),
      db.q(`SELECT s.*, u.name AS client_name FROM subscriptions s
             JOIN clients c ON c.id = s.client_id
             JOIN users u ON u.id = c.user_id
            WHERE s.org_id = ? ORDER BY s.end_date DESC LIMIT 50`, [orgId])
    ]);

    // `payments` now spans the full 6-month trend window (see trendStart
    // above) -- monthlyRevenue must filter back down to just the CURRENT
    // month itself, or it would silently start summing the whole window.
    const monthlyRevenue = payments.filter(p => (p.paid_at || '').slice(0, 7) === monthStart.slice(0, 7))
      .reduce((s, p) => s + Number(p.amount), 0);
    // revenue trend: last 6 months by payment month
    const trend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setUTCMonth(d.getUTCMonth() - i);
      const key = d.toISOString().slice(0, 7);
      const total = payments.filter(p => (p.paid_at || '').slice(0, 7) === key).reduce((s, p) => s + Number(p.amount), 0);
      trend.push({ month: key, total });
    }

    res.json({
      activeMembers: clients.filter(c => c.status !== 'INACTIVE').length,
      totalMembers: clients.length,
      monthlyRevenue,
      renewalsThisMonth: Number(renewalsDue[0]?.n || 0),
      overdue: Number(overdue[0]?.n || 0),
      attendanceToday: Number(attendance[0]?.n || 0),
      revenueTrend: trend,
      packages,
      activeSubscriptions: activeSubs,
      recentPayments: payments.slice(-8).reverse()
    });
  });

  r.get('/packages', async (req, res) => {
    res.json({ packages: await db.q('SELECT * FROM packages WHERE org_id = ?', [req.orgId]) });
  });

  r.post('/packages', validate(z.object({
    name: z.string().min(1).max(80),
    amount: z.number().positive(),
    currency: z.string().default('INR'),
    period_days: z.number().int().min(1).default(30),
    features: z.string().max(500).optional()
  })), async (req, res) => {
    const b = req.body;
    const pId = id('pkg');
    await db.run(
      `INSERT INTO packages (id, org_id, name, amount, currency, period_days, features)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [pId, req.orgId, b.name, b.amount, b.currency, b.period_days, b.features || null]);
    res.status(201).json({ id: pId });
  });

  r.post('/subscriptions', validate(z.object({
    client_id: z.string().min(1),
    package_id: z.string().min(1),
    start_date: z.string().optional()
  })), async (req, res) => {
    const client = await requireOrgClient(req, res, req.body.client_id);
    if (!client) return;
    const pkg = await db.q1('SELECT * FROM packages WHERE id = ? AND org_id = ?', [req.body.package_id, req.orgId]);
    if (!pkg) return res.status(404).json({ error: 'Package not found' });
    const start = req.body.start_date || dayKey();
    const end = addDays(new Date(start + 'T00:00:00Z'), pkg.period_days).toISOString().slice(0, 10);
    const subId = id('sub');
    // Was two sequential db.run() calls: a failure on the second insert left
    // an 'active, paid' subscription committed with no matching payment
    // row -- a real bookkeeping gap for a money-related flow. Same db.tx()
    // pattern already used in clients.js's client-creation route for the
    // identical class of bug (a users row committed with no clients row).
    await db.tx(async (tx) => {
      await tx.run(
        `INSERT INTO subscriptions (id, org_id, client_id, package_id, plan_name, amount, currency, start_date, end_date, renewal_date, status, payment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'paid')`,
        [subId, req.orgId, req.body.client_id, pkg.id, pkg.name, pkg.amount, pkg.currency, start, end, end]);
      await tx.run(
        `INSERT INTO payments (id, org_id, client_id, subscription_id, amount, currency, method, status, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, 'cash', 'paid', ?)`,
        [id('pay'), req.orgId, req.body.client_id, subId, pkg.amount, pkg.currency, now()]);
    });
    await track(db, { orgId: req.orgId, userId: req.user.sub, type: 'subscription_renewed', data: { subscriptionId: subId, amount: pkg.amount } });
    res.status(201).json({ id: subId });
  });

  r.post('/payments', validate(z.object({
    client_id: z.string().min(1),
    amount: z.number().positive(),
    method: z.string().max(30).default('cash'),
    subscription_id: z.string().optional()
  })), async (req, res) => {
    const client = await requireOrgClient(req, res, req.body.client_id);
    if (!client) return;
    const b = req.body;
    await db.run(
      `INSERT INTO payments (id, org_id, client_id, subscription_id, amount, currency, method, status, paid_at)
       VALUES (?, ?, ?, ?, ?, 'INR', ?, 'paid', ?)`,
      [id('pay'), req.orgId, b.client_id, b.subscription_id || null, b.amount, b.method, now()]);
    res.status(201).json({ ok: true });
  });

  r.get('/attendance', async (req, res) => {
    const d = req.query.date || dayKey();
    const rows = await db.q(
      `SELECT a.*, u.name AS client_name FROM attendance a
         JOIN clients c ON c.id = a.client_id
         JOIN users u ON u.id = c.user_id
        WHERE a.org_id = ? AND a.date = ?`, [req.orgId, d]);
    res.json({ attendance: rows });
  });

  r.post('/attendance', validate(z.object({
    client_id: z.string().min(1),
    present: z.boolean().default(true)
  })), async (req, res) => {
    const client = await requireOrgClient(req, res, req.body.client_id);
    if (!client) return;
    const d = dayKey();
    const existing = await db.q1('SELECT id FROM attendance WHERE org_id = ? AND client_id = ? AND date = ?',
      [req.orgId, req.body.client_id, d]);
    if (existing) {
      await db.run('UPDATE attendance SET present = ? WHERE id = ?', [req.body.present ? 1 : 0, existing.id]);
    } else {
      await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?, ?, ?, ?, ?)',
        [id('att'), req.orgId, req.body.client_id, d, req.body.present ? 1 : 0]);
    }
    res.status(201).json({ ok: true });
  });

  r.get('/members', async (req, res) => {
    const rows = await db.q(
      `SELECT c.id, u.name, c.status, c.goal, c.current_weight, s.id AS subscription_id, s.plan_name, s.start_date, s.end_date, s.payment_status, s.lifecycle_status
         FROM clients c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN subscriptions s ON s.client_id = c.id AND s.status = 'active'
        WHERE c.org_id = ? ORDER BY u.name`, [req.orgId]);
    res.json({ members: rows });
  });

  // ---- membership lifecycle actions (suspend / resume / cancel) ----
  // "Dangerous actions require confirmation" (spec) is a frontend
  // concern; the backend's own guard is transitionMembership's explicit
  // state graph -- an invalid jump (e.g. cancel -> resume) is rejected
  // outright, never silently applied.
  const membershipActionLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });
  const MEMBERSHIP_ACTIONS = { suspend: 'SUSPENDED', resume: 'ACTIVE', pause: 'PAUSED', cancel: 'CANCELLED' };
  r.post('/members/:clientId/membership/:action', membershipActionLimit, validate(z.object({ reason: z.string().max(500).optional() })), async (req, res) => {
    const toStatus = MEMBERSHIP_ACTIONS[req.params.action];
    if (!toStatus) return res.status(400).json({ error: 'Unknown membership action' });
    const client = await requireOrgClient(req, res, req.params.clientId);
    if (!client) return;
    const subscription = await db.q1('SELECT * FROM subscriptions WHERE client_id = ? ORDER BY end_date DESC LIMIT 1', [client.id]);
    if (!subscription) return res.status(404).json({ error: 'No membership found for this client' });
    const result = await transitionMembership(db, {
      subscriptionId: subscription.id, orgId: req.orgId, toStatus, reason: req.body.reason || null, changedBy: req.user.sub,
    });
    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404 : 409;
      return res.status(code).json({ error: result.reason, from: result.from, to: result.to });
    }
    res.json({ ok: true, subscription: result.subscription });
  });

  // ---- refunds (Phase 1 production hardening) ----
  // Deliberately its OWN route, not folded into MEMBERSHIP_ACTIONS above
  // -- a refund needs an orderId + optional amount, which the other 4
  // actions (suspend/resume/pause/cancel) never take. See refunds.js's
  // own header comment for why orderId is required rather than
  // "whichever payment is most recent" -- a client can have several
  // (join + renewals) and guessing wrong would refund the wrong one.
  const refundLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/members/:clientId/membership/refund', refundLimit, requirePermission('billing.refund'), validate(z.object({
    orderId: z.string().min(1), amount: z.number().positive().optional(), reason: z.string().max(500).optional(),
  })), async (req, res) => {
    const client = await requireOrgClient(req, res, req.params.clientId);
    if (!client) return;
    const order = await db.q1('SELECT * FROM payment_orders WHERE id = ? AND org_id = ?', [req.body.orderId, req.orgId]);
    if (!order) return res.status(404).json({ error: 'Payment order not found' });
    if (order.client_id && order.client_id !== client.id) {
      return res.status(409).json({ error: 'That payment order does not belong to this client' });
    }
    const result = await initiateRefund(db, {
      orderId: order.id, orgId: req.orgId, amount: req.body.amount, reason: req.body.reason, initiatedBy: req.user.sub,
    });
    if (!result.ok) return res.status(409).json({ error: result.reason, ...result });
    res.json(result);
  });

  r.get('/members/:clientId/membership/refunds', async (req, res) => {
    const client = await requireOrgClient(req, res, req.params.clientId);
    if (!client) return;
    const all = await listRefunds(db, { orgId: req.orgId });
    res.json({ refunds: all.filter((r) => r.client_id === client.id) });
  });

  r.get('/members/:clientId/membership/history', async (req, res) => {
    const client = await requireOrgClient(req, res, req.params.clientId);
    if (!client) return;
    const subscription = await db.q1('SELECT id FROM subscriptions WHERE client_id = ? ORDER BY end_date DESC LIMIT 1', [client.id]);
    if (!subscription) return res.json({ history: [] });
    const history = await db.q('SELECT * FROM membership_status_history WHERE subscription_id = ? AND org_id = ? ORDER BY created_at DESC', [subscription.id, req.orgId]);
    res.json({ history });
  });

  // ---- gym settings (branding, crowd capacity, default client permissions) ----
  r.get('/settings', async (req, res) => {
    const s = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId]);
    res.json({ settings: s || { org_id: req.orgId, brand_name: 'SK OS', tagline: 'Your fitness OS.', crowd_capacity: 150, crowd_enabled: 1, workout_mode_default: 'hybrid', allow_substitute: 1, allow_add_exercise: 1, allow_edit_targets: 1, community_enabled: 1, community_leaderboard_enabled: 1 } });
  });

  r.put('/settings', async (req, res) => {
    const { brand_name, tagline, crowd_capacity, crowd_enabled, workout_mode_default, allow_substitute, allow_add_exercise, allow_edit_targets,
      community_enabled, community_leaderboard_enabled,
      contact_email, contact_phone, address, city, country, logo_url, website, instagram_url, description } = req.body || {};
    const existing = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId]);
    // Gym PROFILE fields (spec: "Do not allow owner to edit: gym_id,
    // organization_id..." -- everything else, including these, IS
    // editable) -- partial-update semantics like every other settings
    // field here: omit a field to leave it unchanged, explicit null/''
    // to clear it. Never touches organizations.id/slug.
    const pick = (incoming, current) => (incoming !== undefined ? (incoming === null || incoming === '' ? null : String(incoming).slice(0, 300)) : (current ?? null));
    await db.run(
      `INSERT INTO gym_settings (org_id, brand_name, tagline, crowd_capacity, crowd_enabled, workout_mode_default, allow_substitute, allow_add_exercise, allow_edit_targets,
         community_enabled, community_leaderboard_enabled,
         contact_email, contact_phone, address, city, country, logo_url, website, instagram_url, description, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(org_id) DO UPDATE SET brand_name=excluded.brand_name, tagline=excluded.tagline,
         crowd_capacity=excluded.crowd_capacity, crowd_enabled=excluded.crowd_enabled,
         workout_mode_default=excluded.workout_mode_default, allow_substitute=excluded.allow_substitute,
         allow_add_exercise=excluded.allow_add_exercise, allow_edit_targets=excluded.allow_edit_targets,
         community_enabled=excluded.community_enabled, community_leaderboard_enabled=excluded.community_leaderboard_enabled,
         contact_email=excluded.contact_email, contact_phone=excluded.contact_phone, address=excluded.address,
         city=excluded.city, country=excluded.country, logo_url=excluded.logo_url, website=excluded.website,
         instagram_url=excluded.instagram_url, description=excluded.description,
         updated_at=excluded.updated_at`,
      [req.orgId,
       String(brand_name ?? existing?.brand_name ?? 'SK OS').slice(0, 40),
       String(tagline ?? existing?.tagline ?? 'Your fitness OS.').slice(0, 80),
       Math.max(1, Math.min(2000, parseInt(crowd_capacity, 10) || existing?.crowd_capacity || 150)),
       crowd_enabled === false || crowd_enabled === 0 ? 0 : (crowd_enabled === undefined ? (existing?.crowd_enabled ?? 1) : 1),
       ['prescribed','custom','hybrid'].includes(workout_mode_default) ? workout_mode_default : (existing?.workout_mode_default || 'hybrid'),
       allow_substitute === false || allow_substitute === 0 ? 0 : (allow_substitute === undefined ? (existing?.allow_substitute ?? 1) : 1),
       allow_add_exercise === false || allow_add_exercise === 0 ? 0 : (allow_add_exercise === undefined ? (existing?.allow_add_exercise ?? 1) : 1),
       allow_edit_targets === false || allow_edit_targets === 0 ? 0 : (allow_edit_targets === undefined ? (existing?.allow_edit_targets ?? 1) : 1),
       community_enabled === false || community_enabled === 0 ? 0 : (community_enabled === undefined ? (existing?.community_enabled ?? 1) : 1),
       community_leaderboard_enabled === false || community_leaderboard_enabled === 0 ? 0 : (community_leaderboard_enabled === undefined ? (existing?.community_leaderboard_enabled ?? 1) : 1),
       pick(contact_email, existing?.contact_email), pick(contact_phone, existing?.contact_phone), pick(address, existing?.address),
       pick(city, existing?.city), pick(country, existing?.country), pick(logo_url, existing?.logo_url),
       pick(website, existing?.website), pick(instagram_url, existing?.instagram_url), pick(description, existing?.description),
       now()]);
    track(db, 'gym_settings_updated', req.orgId, req.user.sub, {});
    res.json({ ok: true });
  });

  // ---- live crowd (attendance events → occupancy engine) ----
  r.get('/crowd', async (req, res) => {
    const settings = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId]);
    const snapshot = await computeOccupancy(db, req.orgId, req.tz, settings);
    res.json(snapshot);
  });

  // ---- payment reconciliation (Phase 1 production hardening) ----
  // Owner-triggered, org-scoped only -- see reconciliation.js's own
  // header comment for why this is a sweep, not a background worker
  // (no cron infra exists in this codebase), and why it never silently
  // rewrites a financial record.
  const reconciliationLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/reconciliation/run', reconciliationLimit, async (req, res) => {
    const summary = await runReconciliationSweep(db, { orgId: req.orgId });
    await track(db, { type: 'reconciliation_swept', orgId: req.orgId, userId: req.user.sub, data: summary }).catch(() => {});
    res.json(summary);
  });

  r.get('/reconciliation', async (req, res) => {
    const status = ['OPEN', 'RESOLVED', 'DISMISSED'].includes(req.query.status) ? req.query.status : null;
    const issues = await listReconciliationIssues(db, { orgId: req.orgId, status });
    res.json({ issues: issues.map((i) => ({ ...i, expected_json: safeParse(i.expected_json), actual_json: safeParse(i.actual_json) })) });
  });

  r.post('/reconciliation/:id/resolve', validate(z.object({ note: z.string().max(500).optional(), dismiss: z.boolean().optional() })), async (req, res) => {
    const ok = await resolveReconciliationIssue(db, {
      orgId: req.orgId, issueId: req.params.id, resolvedBy: req.user.sub, note: req.body.note, dismiss: !!req.body.dismiss,
    });
    if (!ok) return res.status(409).json({ error: 'Issue not found or already resolved' });
    res.json({ ok: true });
  });

  // ---- branches (Phase 2 production hardening) ----
  // Architecture-ready, not UI-forced -- a single-branch gym never has
  // to touch this. Demonstrates requirePermission() layered alongside
  // this router's existing requireRole('GYM_OWNER','SUPER_ADMIN') gate
  // (see permissions.js's own comment on why that's additive, not a
  // replacement): MANAGER-level gym_memberships holders will be able to
  // view branches once a MANAGER can authenticate as themselves (a
  // later pass), but creating/editing one stays GYM_OWNER/SUPER_ADMIN-
  // only per the permission matrix.
  r.get('/branches', requirePermission('branches.view'), async (req, res) => {
    const branches = await db.q('SELECT * FROM branches WHERE org_id = ? ORDER BY created_at', [req.orgId]);
    res.json({ branches });
  });

  r.post('/branches', requirePermission('branches.manage'), validate(z.object({
    name: z.string().min(1).max(120), address: z.string().max(300).optional(), phone: z.string().max(30).optional(), timezone: z.string().max(60).optional(),
  })), async (req, res) => {
    const branchId = id('brch');
    await db.run(
      `INSERT INTO branches (id, org_id, name, address, phone, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [branchId, req.orgId, req.body.name, req.body.address || null, req.body.phone || null, req.body.timezone || null, now(), now()]);
    await track(db, { type: 'branch_created', orgId: req.orgId, userId: req.user.sub, data: { branchId } }).catch(() => {});
    res.status(201).json({ id: branchId });
  });

  r.post('/branches/:id/status', requirePermission('branches.manage'), validate(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) })), async (req, res) => {
    const result = await db.run(`UPDATE branches SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [req.body.status, now(), req.params.id, req.orgId]);
    if (result.changes === 0) return res.status(404).json({ error: 'Branch not found' });
    res.json({ ok: true });
  });

  // ---- support tickets (Phase 3b) ----
  // Owner-facing: this org's own tickets only. Every read here goes
  // through listMessages(..., { includeInternal: false }) -- an admin's
  // internal note must never reach this surface, not just be hidden by
  // the frontend (see tickets.js's own header comment).
  r.post('/support', validate(z.object({
    category: z.enum(['PAYMENT', 'SUBSCRIPTION', 'QR', 'CLIENT', 'TRAINER', 'ACCOUNT', 'TECHNICAL', 'BILLING', 'OTHER']),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(4000),
  })), async (req, res) => {
    const ticket = await createTicket(db, { orgId: req.orgId, createdBy: req.user.sub, category: req.body.category, priority: req.body.priority, subject: req.body.subject, body: req.body.body });
    res.status(201).json({ ticket });
  });

  r.get('/support', async (req, res) => {
    const status = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_GYM', 'RESOLVED', 'CLOSED'].includes(req.query.status) ? req.query.status : null;
    const tickets = await listTicketsForOrg(db, { orgId: req.orgId, status });
    res.json({ tickets });
  });

  r.get('/support/:id', async (req, res) => {
    const ticket = await getTicket(db, { ticketId: req.params.id, orgId: req.orgId });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const messages = await listMessages(db, { ticketId: ticket.id, includeInternal: false });
    res.json({ ticket, messages });
  });

  r.post('/support/:id/messages', validate(z.object({ body: z.string().min(1).max(4000) })), async (req, res) => {
    const ticket = await getTicket(db, { ticketId: req.params.id, orgId: req.orgId });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const message = await addMessage(db, { ticketId: ticket.id, authorId: req.user.sub, body: req.body.body, internal: false });
    res.status(201).json({ message });
  });

  // ---- recent errors, backend + frontend (real observability, no external service) ----
  // Two sources land here: the global error handler (src/index.js)
  // persists every unhandled REQUEST failure as 'server_error'; the
  // frontend's ErrorBoundary (clientError.js) persists every RENDER
  // crash as 'client_error'. Both are org-scoped where known, message
  // already truncated and never containing a raw stack trace or secret.
  // Without this route the only way to see what actually broke on a live
  // deployment was direct DB access -- this is the same "what's actually
  // happening in production" question that took a full manual debugging
  // session to answer for the food-AI provider config; this route
  // answers the general version of it going forward.
  r.get('/errors', async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await db.q(
      `SELECT id, type, user_id, data_json, created_at FROM events
        WHERE org_id = ? AND type IN ('server_error', 'client_error')
        ORDER BY created_at DESC LIMIT ?`,
      [req.orgId, limit]);
    const errors = rows.map((r) => {
      let data = {};
      try { data = JSON.parse(r.data_json || '{}'); } catch { /* leave empty */ }
      return { id: r.id, source: r.type === 'client_error' ? 'client' : 'server', user_id: r.user_id, created_at: r.created_at, ...data };
    });
    res.json({ errors, count: errors.length });
  });

  return r;
}
