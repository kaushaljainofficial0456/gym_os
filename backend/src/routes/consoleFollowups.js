// ============================================================
// ADMIN CONSOLE -- AI COMMUNICATION (platform operator only).
//
// Mounted from routes/console.js behind its SUPER_ADMIN gate and rate
// limit; every change is written to admin_audit_logs through the same
// writeAuditLog, in the same transaction where the change is one write.
//
//   GET  /pricing                 the current price book + every pack's cost, price, markup
//   GET  /pricing/versions        history (orders keep the version they were sold at)
//   PUT  /pricing                 save a NEW version
//   GET  /gyms                    per gym: balances, unearned value, usage revenue, provider cost, margin
//   GET  /gyms/:orgId             one gym: numbers, line capacity, settings, recent ledger
//   POST /gyms/:orgId/numbers     assign a caller number (rented by the platform)
//   PUT  /numbers/:id             retire / flag / relabel / connect to ElevenLabs
//   PUT  /gyms/:orgId/whatsapp    set the gym's WhatsApp sender
//   POST /gyms/:orgId/adjust      grant or remove units (support, goodwill), with a reason
//   GET/PUT /platform             pause all outbound, or one channel
//   GET  /setup                   provider configuration status and the webhook URLs to paste
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../validate.js';
import { id, now } from '../ids.js';
import { setupStatus, sign, publicBase } from '../services/followups/config.js';
import { getPriceBook, savePriceBook, evaluatePack, unitCosts, getWallet, lineCapacity, creditUnits, usageSince, unitKeys, unearnedValue } from '../services/followups/wallet.js';
import * as providers from '../services/followups/providers/index.js';
import { normalizePhone } from '../services/followups/render.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export default function consoleFollowupRoutes(db, { writeAuditLog }) {
  const r = Router();

  r.get('/setup', wrap(async (req, res) => {
    const base = publicBase();
    res.json({
      status: setupStatus(),
      capabilities: providers.capabilities(),
      webhooks: {
        exotel_gather: `${base}/api/followups/hooks/exotel/gather`,
        exotel_keypress: `${base}/api/followups/hooks/exotel/keypress`,
        exotel_whatsapp: `${base}/api/followups/hooks/exotel/whatsapp?k=${sign('whatsapp-inbound')}`,
        elevenlabs_post_call: `${base}/api/followups/hooks/elevenlabs`,
        your_agent_server_results: `${base}/api/followups/hooks/agent/http`,
        cron: `${base}/api/followups/cron/tick`,
      },
    });
  }));

  r.get('/pricing', wrap(async (req, res) => {
    const book = await getPriceBook(db);
    res.json({ book, unit_costs: unitCosts(book), packs: book.packs.map((p) => ({ ...p, economics: evaluatePack(p, book) })), tiers_live: Object.fromEntries(['voice', 'agent'].map((pr) => [pr, (book.tiers[pr] || []).map((t) => ({ id: t.id, available: providers.tierAvailable(pr, t) }))])) });
  }));
  r.get('/pricing/versions', wrap(async (req, res) => {
    res.json({ versions: (await db.q('SELECT v.version, v.created_at, u.name AS created_by FROM followup_price_versions v LEFT JOIN users u ON u.id = v.created_by ORDER BY v.version DESC LIMIT 100')) });
  }));
  r.put('/pricing', wrap(async (req, res) => {
    const before = await getPriceBook(db);
    try {
      const book = await savePriceBook(db, req.body, req.user.sub);
      await writeAuditLog(db, req, { action: 'ai_comms_pricing_saved', entityType: 'followup_price_versions', entityId: String(book.version), before: { version: before.version }, after: { version: book.version, margin_pct: book.margin_pct } });
      res.json({ book, packs: book.packs.map((p) => ({ ...p, economics: evaluatePack(p, book) })) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save' });
    }
  }));

  r.get('/gyms', wrap(async (req, res) => {
    const since = String(req.query.since || new Date(Date.now() - 30 * 86_400_000).toISOString());
    const gyms = await db.q(`SELECT o.id, o.name FROM organizations o WHERE o.id IN (SELECT org_id FROM followup_settings UNION SELECT org_id FROM followup_balances UNION SELECT org_id FROM followup_numbers) ORDER BY o.name`);
    const book = await getPriceBook(db);
    const out = [];
    for (const g of gyms) {
      const w = await getWallet(db, g.id, book);
      const usage = await usageSince(db, g.id, since, book);
      const sales = await db.q1(`SELECT SUM(amount) AS gross, SUM(tax_amount) AS tax, COUNT(*) AS n FROM followup_orders WHERE org_id = ? AND status = 'SUCCESS' AND created_at >= ?`, [g.id, since]);
      const revenue = Object.values(usage).reduce((s, u) => s + u.spent, 0);
      const cost = Object.values(usage).reduce((s, u) => s + u.cost, 0);
      const numbers = await db.q1(`SELECT COUNT(*) AS n FROM followup_numbers WHERE org_id = ? AND status = 'active'`, [g.id]);
      const cap = await lineCapacity(db, g.id);
      const s = await db.q1('SELECT enabled FROM followup_settings WHERE org_id = ?', [g.id]);
      out.push({
        id: g.id, name: g.name, enabled: !!Number(s?.enabled),
        balances: w,
        unearned: await unearnedValue(db, g.id),
        sales_gross: Number(sales?.gross || 0), sales_tax: Number(sales?.tax || 0), purchases: Number(sales?.n || 0),
        usage_revenue: Math.round(revenue * 100) / 100, provider_cost: Math.round(cost * 100) / 100, contribution: Math.round((revenue - cost) * 100) / 100,
        numbers_active: Number(numbers?.n || 0), lines_paid: cap.lines, lines_until: cap.until,
      });
    }
    const totals = out.reduce((t, g) => ({
      sales_gross: t.sales_gross + g.sales_gross, sales_tax: t.sales_tax + g.sales_tax, usage_revenue: t.usage_revenue + g.usage_revenue,
      provider_cost: t.provider_cost + g.provider_cost, unearned: t.unearned + g.unearned,
    }), { sales_gross: 0, sales_tax: 0, usage_revenue: 0, provider_cost: 0, unearned: 0 });
    totals.contribution = Math.round((totals.usage_revenue - totals.provider_cost) * 100) / 100;
    res.json({ since, gyms: out, totals });
  }));

  r.get('/gyms/:orgId', wrap(async (req, res) => {
    const org = await db.q1('SELECT id, name FROM organizations WHERE id = ?', [req.params.orgId]);
    if (!org) return res.status(404).json({ error: 'Gym not found' });
    res.json({
      gym: org,
      wallet: await getWallet(db, org.id, await getPriceBook(db)),
      lines: await lineCapacity(db, org.id),
      numbers: await db.q('SELECT * FROM followup_numbers WHERE org_id = ? ORDER BY is_primary DESC, created_at', [org.id]),
      settings: await db.q1('SELECT enabled, whatsapp_from, sms_header, dlt_entity_id, compliance_json FROM followup_settings WHERE org_id = ?', [org.id]),
      ledger: await db.q(`SELECT unit, delta, reason, charge_inr, cost_estimate, pricing_version, note, created_at FROM followup_ledger WHERE org_id = ? ORDER BY created_at DESC LIMIT 100`, [org.id]),
      orders: await db.q(`SELECT id, pack_id, quantity, amount, tax_amount, pricing_version, status, invoice_number, created_at FROM followup_orders WHERE org_id = ? ORDER BY created_at DESC LIMIT 50`, [org.id]),
    });
  }));

  r.post('/gyms/:orgId/numbers', validate(z.object({
    number: z.string().min(6).max(20), label: z.string().max(40).optional(), number_type: z.string().max(30).optional(),
    agent_phone_id: z.string().max(80).optional(), branch_id: z.string().max(40).nullable().optional(), is_primary: z.boolean().optional(),
  })), wrap(async (req, res) => {
    const org = await db.q1('SELECT id FROM organizations WHERE id = ?', [req.params.orgId]);
    if (!org) return res.status(404).json({ error: 'Gym not found' });
    const number = req.body.number.startsWith('+') ? normalizePhone(req.body.number) : (normalizePhone(req.body.number) || req.body.number.replace(/\s/g, ''));
    if (!number) return res.status(422).json({ error: 'Enter the number in full' });
    const other = await db.q1('SELECT org_id FROM followup_numbers WHERE number = ? AND org_id != ? AND status = ?', [number, org.id, 'active']);
    if (other) return res.status(409).json({ error: 'This number is already in use by another gym' });
    const nid = id('fn');
    const ts = now();
    await db.tx(async (tx) => {
      if (req.body.is_primary) await tx.run('UPDATE followup_numbers SET is_primary = 0 WHERE org_id = ?', [org.id]);
      await tx.run(`INSERT INTO followup_numbers (id, org_id, branch_id, number, label, number_type, agent_phone_id, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [nid, org.id, req.body.branch_id || null, number, req.body.label || null, req.body.number_type || null, req.body.agent_phone_id || null, req.body.is_primary ? 1 : 0, ts, ts]);
      await writeAuditLog(tx, req, { action: 'ai_comms_number_assigned', entityType: 'followup_numbers', entityId: nid, after: { orgId: org.id, number } });
    });
    res.json({ number: await db.q1('SELECT * FROM followup_numbers WHERE id = ?', [nid]) });
  }));

  r.put('/numbers/:id', validate(z.object({
    status: z.enum(['active', 'retired']).optional(), health: z.enum(['ok', 'flagged']).optional(), label: z.string().max(40).nullable().optional(),
    agent_phone_id: z.string().max(80).nullable().optional(), number_type: z.string().max(30).nullable().optional(),
  })), wrap(async (req, res) => {
    const n = await db.q1('SELECT * FROM followup_numbers WHERE id = ?', [req.params.id]);
    if (!n) return res.status(404).json({ error: 'Number not found' });
    const cols = Object.keys(req.body).filter((k) => req.body[k] !== undefined);
    if (!cols.length) return res.json({ number: n });
    await db.tx(async (tx) => {
      await tx.run(`UPDATE followup_numbers SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...cols.map((k) => req.body[k]), now(), n.id]);
      // A retired or flagged line: its members are re-matched to another line on their next call.
      if (req.body.status === 'retired' || req.body.health === 'flagged') await tx.run('UPDATE followup_member_prefs SET number_id = NULL WHERE number_id = ?', [n.id]);
      await writeAuditLog(tx, req, { action: 'ai_comms_number_updated', entityType: 'followup_numbers', entityId: n.id, before: { status: n.status, health: n.health }, after: req.body });
    });
    res.json({ number: await db.q1('SELECT * FROM followup_numbers WHERE id = ?', [n.id]) });
  }));

  r.put('/gyms/:orgId/whatsapp', validate(z.object({ whatsapp_from: z.string().max(20).nullable() })), wrap(async (req, res) => {
    const org = await db.q1('SELECT id FROM organizations WHERE id = ?', [req.params.orgId]);
    if (!org) return res.status(404).json({ error: 'Gym not found' });
    const exists = await db.q1('SELECT org_id FROM followup_settings WHERE org_id = ?', [org.id]);
    if (!exists) await db.run('INSERT INTO followup_settings (org_id, updated_at) VALUES (?, ?)', [org.id, now()]);
    await db.run('UPDATE followup_settings SET whatsapp_from = ?, updated_at = ? WHERE org_id = ?', [req.body.whatsapp_from ? normalizePhone(req.body.whatsapp_from) || req.body.whatsapp_from : null, now(), org.id]);
    await writeAuditLog(db, req, { action: 'ai_comms_whatsapp_sender', entityType: 'organizations', entityId: org.id, after: req.body });
    res.json({ ok: true });
  }));

  r.post('/gyms/:orgId/adjust', validate(z.object({
    unit: z.string().min(2).max(40), delta: z.number().int().min(-100000).max(100000).refine((v) => v !== 0), reason: z.string().trim().min(5).max(200),
  })), wrap(async (req, res) => {
    const org = await db.q1('SELECT id FROM organizations WHERE id = ?', [req.params.orgId]);
    if (!org) return res.status(404).json({ error: 'Gym not found' });
    const book = await getPriceBook(db);
    if (!unitKeys(book).includes(req.body.unit)) return res.status(422).json({ error: 'Unknown product' });
    const w = await getWallet(db, org.id, book);
    if (req.body.delta < 0 && w[req.body.unit] + req.body.delta < 0) return res.status(422).json({ error: 'That would take the balance below zero' });
    await db.tx(async (tx) => {
      await creditUnits(db, org.id, { [req.body.unit]: req.body.delta }, { reason: 'adjustment', note: req.body.reason, tx });
      await writeAuditLog(tx, req, { action: 'ai_comms_adjustment', entityType: 'followup_balances', entityId: org.id, before: { [req.body.unit]: w[req.body.unit] }, after: req.body });
    }, { orgId: org.id });
    res.json({ wallet: await getWallet(db, org.id, book) });
  }));

  r.get('/platform', wrap(async (req, res) => {
    const row = await db.q1(`SELECT * FROM followup_platform WHERE id = 'current'`);
    res.json({ paused: !!Number(row?.paused), paused_channels: row?.paused_channels ? JSON.parse(row.paused_channels) : [] });
  }));
  r.put('/platform', validate(z.object({ paused: z.boolean(), paused_channels: z.array(z.enum(['call', 'agent', 'sms', 'whatsapp'])).max(4) })), wrap(async (req, res) => {
    const row = await db.q1(`SELECT * FROM followup_platform WHERE id = 'current'`);
    if (row) await db.run(`UPDATE followup_platform SET paused = ?, paused_channels = ?, updated_by = ?, updated_at = ? WHERE id = 'current'`, [req.body.paused ? 1 : 0, JSON.stringify(req.body.paused_channels), req.user.sub, now()]);
    else await db.run(`INSERT INTO followup_platform (id, paused, paused_channels, updated_by, updated_at) VALUES ('current', ?, ?, ?, ?)`, [req.body.paused ? 1 : 0, JSON.stringify(req.body.paused_channels), req.user.sub, now()]);
    await writeAuditLog(db, req, { action: 'ai_comms_platform_switch', entityType: 'followup_platform', entityId: 'current', before: row ? { paused: !!Number(row.paused) } : null, after: req.body });
    res.json({ ok: true });
  }));

  return r;
}
