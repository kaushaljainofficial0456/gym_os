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
//   GET  /health                  queue, scheduler, failures, 24h volumes and money, ledger reconciliation, alerts
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../validate.js';
import { id, now } from '../ids.js';
import { setupStatus, sign, publicBase } from '../services/followups/config.js';
import { getPriceBook, savePriceBook, evaluatePack, unitCosts, getWallet, lineCapacity, creditUnits, usageSince, unitKeys, unearnedValue } from '../services/followups/wallet.js';
import * as providers from '../services/followups/providers/index.js';
import { normalizePhone } from '../services/followups/render.js';
import { recentOwnerChanges } from '../services/followups/audit.js';
import { usageReport, usageTrend } from '../services/followups/usageReport.js';

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

  /*
   * OPERATIONS HEALTH -- what is happening right now, without opening the
   * database: queue depth and age, calls that never reported back, failures
   * by reason, the scheduler's heartbeat, the last 24 hours by channel, money
   * in and out, and a reconciliation of every balance against its ledger.
   * Each problem becomes an alert with the action to take. Counts and reasons
   * only: no member names, numbers or message text.
   */
  r.get('/health', wrap(async (req, res) => {
    const nowMs = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const since24 = iso(nowMs - 86_400_000);
    const n = (v) => Number(v || 0);
    const [platformRow, queue, stuck, awaiting, byChannel, failures, ticks, money, timing, ledgerSums, balances] = await Promise.all([
      db.q1(`SELECT paused, paused_channels FROM followup_platform WHERE id = 'current'`),
      db.q1(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM followup_jobs WHERE status = 'queued'`),
      db.q1(`SELECT COUNT(*) AS n FROM followup_jobs WHERE status IN ('dialing','answered') AND dialed_at < ?`, [iso(nowMs - 30 * 60_000)]),
      db.q1(`SELECT COUNT(*) AS n, MIN(ended_at) AS oldest FROM followup_jobs WHERE status = 'completed' AND units_held > 0`),
      db.q(`SELECT channel, status, COUNT(*) AS n FROM followup_jobs WHERE created_at >= ? AND is_test = 0 GROUP BY channel, status`, [since24]),
      db.q(`SELECT error, COUNT(*) AS n FROM followup_jobs WHERE status IN ('failed','skipped') AND created_at >= ? AND error IS NOT NULL GROUP BY error ORDER BY COUNT(*) DESC LIMIT 10`, [since24]),
      db.q1(`SELECT COUNT(*) AS n, MAX(last_tick_at) AS last FROM followup_settings WHERE enabled = 1`),
      db.q(`SELECT reason, SUM(charge_inr) AS v, SUM(COALESCE(cost_estimate, 0)) AS c, COUNT(*) AS n FROM followup_ledger WHERE created_at >= ? AND reason IN ('usage','refund') GROUP BY reason`, [since24]),
      db.q(`SELECT created_at, dialed_at FROM followup_jobs WHERE created_at >= ? AND dialed_at IS NOT NULL AND is_test = 0 ORDER BY created_at DESC LIMIT 2000`, [since24]),
      db.q(`SELECT org_id, unit, SUM(delta) AS s FROM followup_ledger GROUP BY org_id, unit`),
      db.q(`SELECT org_id, unit, balance FROM followup_balances`),
    ]);

    const channels = {};
    for (const r of byChannel) { (channels[r.channel] ||= {})[r.status] = n(r.n); }
    const total = (ch, states) => states.reduce((s, st) => s + n(channels[ch]?.[st]), 0);
    const placedCalls = total('call', ['completed', 'no_answer', 'busy', 'failed']) + total('agent', ['completed', 'no_answer', 'busy', 'failed']);
    const failedCalls = total('call', ['failed']) + total('agent', ['failed']);
    const sentMsgs = total('sms', ['sent', 'delivered', 'failed']) + total('whatsapp', ['sent', 'delivered', 'read', 'failed']);
    const failedMsgs = total('sms', ['failed']) + total('whatsapp', ['failed']);
    const usage = money.find((m) => m.reason === 'usage') || {};
    const refund = money.find((m) => m.reason === 'refund') || {};
    const revenue = Math.round((n(usage.v) - n(refund.v)) * 100) / 100;
    const cost = Math.round(n(usage.c) * 100) / 100;
    const waits = timing.map((t) => Date.parse(t.dialed_at) - Date.parse(t.created_at)).filter((ms) => Number.isFinite(ms) && ms >= 0);
    const avgWaitSec = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 1000) : null;

    // Every balance must equal the sum of its ledger rows.
    const sums = new Map(ledgerSums.map((r) => [`${r.org_id}|${r.unit}`, n(r.s)]));
    const discrepancies = [];
    for (const b of balances) {
      const k = `${b.org_id}|${b.unit}`;
      const diff = Math.round((n(b.balance) - (sums.get(k) || 0)) * 1000) / 1000;
      if (Math.abs(diff) > 0.001) discrepancies.push({ org_id: b.org_id, unit: b.unit, balance: n(b.balance), ledger: sums.get(k) || 0, diff });
      sums.delete(k);
    }
    for (const [k, s] of sums) if (Math.abs(s) > 0.001) { const [orgId, unit] = k.split('|'); discrepancies.push({ org_id: orgId, unit, balance: 0, ledger: s, diff: -s }); }

    const status = setupStatus();
    const tickAgeMin = ticks?.last ? Math.round((nowMs - Date.parse(ticks.last)) / 60_000) : null;
    const queueAgeMin = queue?.oldest ? Math.round((nowMs - Date.parse(queue.oldest)) / 60_000) : null;
    const credentialErrors = failures.filter((f) => /\b(401|403)\b|not configured|unauthori[sz]ed|authentication|invalid (api )?key/i.test(String(f.error))).reduce((s, f) => s + n(f.n), 0);
    const noResult = failures.filter((f) => /^No result from the provider/.test(String(f.error))).reduce((s, f) => s + n(f.n), 0);
    const alerts = [];
    const alert = (level, code, text, action) => alerts.push({ level, code, text, action });
    if (n(platformRow?.paused)) alert('info', 'platform_paused', 'All automated contact is paused by the platform switch.', 'Turn it off in Setup when the incident is over.');
    if (discrepancies.length) alert('critical', 'credit_discrepancy', `${discrepancies.length} balance${discrepancies.length === 1 ? ' does' : 's do'} not match the ledger.`, 'Do not adjust by hand. Compare the gym\'s ledger with its balances and the audit log; a mismatch means a write happened outside wallet.js.');
    if (n(ticks?.n) > 0 && status.mode !== 'off' && (tickAgeMin === null || tickAgeMin > 15)) alert('critical', 'scheduler_stopped', tickAgeMin === null ? 'Gyms are switched on but the scheduler has never run.' : `The scheduler last ran ${tickAgeMin} minutes ago.`, 'Check the job that calls GET /api/followups/cron/tick every 5 minutes with the CRON_SECRET bearer token.');
    if (credentialErrors > 0) alert('critical', 'provider_credentials', `${credentialErrors} contact${credentialErrors === 1 ? '' : 's'} failed on provider authentication or configuration in the last 24 hours.`, 'Check the provider keys in the environment (Setup lists what is missing) and the provider dashboards.');
    if (n(stuck?.n) > 0) alert('warning', 'jobs_stuck', `${n(stuck.n)} call${n(stuck.n) === 1 ? ' has' : 's have'} not reported back for over 30 minutes.`, 'The sweep reconciles these from the provider every 5 minutes. If the number keeps growing, check the status callback URL in the Exotel flow.');
    if (n(awaiting?.n) > 0 && awaiting.oldest && nowMs - Date.parse(awaiting.oldest) > 60 * 60_000) alert('warning', 'duration_missing', `${n(awaiting.n)} answered call${n(awaiting.n) === 1 ? ' is' : 's are'} still waiting for the provider to report a duration.`, 'They are charged the 1-minute minimum after an hour. If this is frequent, confirm Exotel sends ConversationDuration or that the Call Details API is reachable.');
    if (noResult >= 5) alert('warning', 'callbacks_missing', `${noResult} contacts got no result from the provider in the last 24 hours.`, 'Provider webhooks may not be reaching the server: compare the URLs in Setup with the ones configured at the provider.');
    if (n(queue?.n) > 500 || (queueAgeMin !== null && queueAgeMin > 45)) alert('warning', 'queue_backlog', `${n(queue.n)} contacts queued; the oldest has waited ${queueAgeMin} minutes.`, 'Dispatch places 25 per gym per tick. A long backlog means ticks are failing or a gym has far more due members than one window allows.');
    if (placedCalls >= 20 && failedCalls / placedCalls > 0.2) alert('warning', 'call_failures', `${Math.round((failedCalls / placedCalls) * 100)}% of calls failed in the last 24 hours.`, 'See the failure reasons below; a sudden rise usually means a provider outage or a blocked caller line.');
    if (sentMsgs >= 20 && failedMsgs / sentMsgs > 0.2) alert('warning', 'message_failures', `${Math.round((failedMsgs / sentMsgs) * 100)}% of messages failed in the last 24 hours.`, 'Failed messages are refunded automatically. Check template approval and DLT registration.');

    res.json({
      at: iso(nowMs), mode: status.mode,
      platform: { paused: !!n(platformRow?.paused), channels: platformRow?.paused_channels ? JSON.parse(platformRow.paused_channels) : [] },
      queue: { queued: n(queue?.n), oldest_minutes: queueAgeMin, stuck: n(stuck?.n), awaiting_duration: n(awaiting?.n), avg_wait_seconds: avgWaitSec },
      scheduler: { gyms_on: n(ticks?.n), last_tick: ticks?.last || null, minutes_ago: tickAgeMin },
      last_24h: {
        channels, failures: failures.map((f) => ({ reason: f.error, count: n(f.n) })),
        calls: { placed: placedCalls, completed: total('call', ['completed']) + total('agent', ['completed']), failed: failedCalls },
        messages: { sent: sentMsgs, delivered: total('sms', ['delivered']) + total('whatsapp', ['delivered', 'read']), failed: failedMsgs },
        revenue, cost, margin: Math.round((revenue - cost) * 100) / 100, cost_per_contact: (placedCalls + sentMsgs) ? Math.round((cost / (placedCalls + sentMsgs)) * 100) / 100 : null,
      },
      discrepancies: discrepancies.slice(0, 20),
      alerts: alerts.sort((a, b) => ['critical', 'warning', 'info'].indexOf(a.level) - ['critical', 'warning', 'info'].indexOf(b.level)),
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

  // Usage by calling mode, campaign, gym and month; call-back counts.
  // ?period=YYYY-MM (default this month), ?org=<id> for one gym.
  r.get('/usage', wrap(async (req, res) => {
    const orgId = req.query.org ? String(req.query.org) : null;
    res.json({ report: await usageReport(db, { orgId, period: req.query.period }), trend: await usageTrend(db, { orgId, months: 6 }) });
  }));

  r.get('/gyms/:orgId', wrap(async (req, res) => {
    const org = await db.q1('SELECT id, name FROM organizations WHERE id = ?', [req.params.orgId]);
    if (!org) return res.status(404).json({ error: 'Gym not found' });
    res.json({
      usage: await usageReport(db, { orgId: org.id, period: req.query.period }),
      gym: org,
      wallet: await getWallet(db, org.id, await getPriceBook(db)),
      lines: await lineCapacity(db, org.id),
      numbers: await db.q('SELECT * FROM followup_numbers WHERE org_id = ? ORDER BY is_primary DESC, created_at', [org.id]),
      settings: await db.q1('SELECT enabled, whatsapp_from, sms_header, dlt_entity_id, compliance_json FROM followup_settings WHERE org_id = ?', [org.id]),
      ledger: await db.q(`SELECT unit, delta, reason, charge_inr, cost_estimate, pricing_version, note, created_at FROM followup_ledger WHERE org_id = ? ORDER BY created_at DESC LIMIT 100`, [org.id]),
      orders: await db.q(`SELECT id, pack_id, quantity, amount, tax_amount, pricing_version, status, invoice_number, created_at FROM followup_orders WHERE org_id = ? ORDER BY created_at DESC LIMIT 50`, [org.id]),
      owner_changes: await recentOwnerChanges(db, org.id, 50),
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
