import { Router } from 'express';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { z } from 'zod';
import { validate } from '../validate.js';
import { id, now } from '../ids.js';
import { dayKey, addDays } from '../utils/time.js';
import { track } from '../services/events.js';
import { computeOccupancy } from '../services/occupancy.js';

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

  r.get('/overview', async (req, res) => {
    const orgId = req.orgId;
    const clients = await db.q('SELECT * FROM clients WHERE org_id = ?', [orgId]);
    const today = dayKey();
    const monthStart = today.slice(0, 7) + '-01';

    const [payments, subs, renewalsDue, overdue, attendance, packages, activeSubs] = await Promise.all([
      db.q('SELECT amount, paid_at FROM payments WHERE org_id = ? AND paid_at >= ?', [orgId, monthStart]),
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

    const monthlyRevenue = payments.reduce((s, p) => s + Number(p.amount), 0);
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
      `SELECT c.id, u.name, c.status, c.goal, c.current_weight, s.plan_name, s.end_date, s.payment_status
         FROM clients c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN subscriptions s ON s.client_id = c.id AND s.status = 'active'
        WHERE c.org_id = ? ORDER BY u.name`, [req.orgId]);
    res.json({ members: rows });
  });

  // ---- gym settings (branding, crowd capacity, default client permissions) ----
  r.get('/settings', async (req, res) => {
    const s = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId]);
    res.json({ settings: s || { org_id: req.orgId, brand_name: 'SK OS', tagline: 'Your fitness OS.', crowd_capacity: 150, crowd_enabled: 1, workout_mode_default: 'hybrid', allow_substitute: 1, allow_add_exercise: 1, allow_edit_targets: 1 } });
  });

  r.put('/settings', async (req, res) => {
    const { brand_name, tagline, crowd_capacity, crowd_enabled, workout_mode_default, allow_substitute, allow_add_exercise, allow_edit_targets } = req.body || {};
    await db.run(
      `INSERT INTO gym_settings (org_id, brand_name, tagline, crowd_capacity, crowd_enabled, workout_mode_default, allow_substitute, allow_add_exercise, allow_edit_targets, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(org_id) DO UPDATE SET brand_name=excluded.brand_name, tagline=excluded.tagline,
         crowd_capacity=excluded.crowd_capacity, crowd_enabled=excluded.crowd_enabled,
         workout_mode_default=excluded.workout_mode_default, allow_substitute=excluded.allow_substitute,
         allow_add_exercise=excluded.allow_add_exercise, allow_edit_targets=excluded.allow_edit_targets,
         updated_at=excluded.updated_at`,
      [req.orgId,
       String(brand_name ?? 'SK OS').slice(0, 40),
       String(tagline ?? 'Your fitness OS.').slice(0, 80),
       Math.max(1, Math.min(2000, parseInt(crowd_capacity, 10) || 150)),
       crowd_enabled === false || crowd_enabled === 0 ? 0 : 1,
       ['prescribed','custom','hybrid'].includes(workout_mode_default) ? workout_mode_default : 'hybrid',
       allow_substitute === false || allow_substitute === 0 ? 0 : 1,
       allow_add_exercise === false || allow_add_exercise === 0 ? 0 : 1,
       allow_edit_targets === false || allow_edit_targets === 0 ? 0 : 1,
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
