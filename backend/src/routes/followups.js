// ============================================================
// AI COMMUNICATION API (follow-up calls, AI conversations, SMS, WhatsApp).
// docs/FOLLOWUPS.md has the design.
//
//   followupPublicRoutes  /api/followups/hooks/*, /audio/*, /cron/tick --
//                         providers and the scheduler; authenticated by
//                         signed tokens, webhook signatures or CRON_SECRET,
//                         never by a session
//   followupRoutes        /api/followups/* -- the gym owner's API, plus
//                         /me (a member's own preferences) and
//                         /trainer/callbacks (a trainer's assigned callbacks)
//
// Owners never see costs, margins or provider credentials; members see
// only their own preferences; trainers only callbacks assigned to them.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { id, now } from '../ids.js';
import { cronAuthorized } from '../services/access/tick.js';
import { dayKey, getOrgTzCached, shiftDayKey } from '../utils/time.js';
import { setupStatus, verify, readJobToken, sign, publicBase } from '../services/followups/config.js';
import { languageList, isLanguage, defaultLines, starterFor, LANGUAGE_CODES } from '../services/followups/languages.js';
import { RULE_DEFAULTS, normalizeConfig, describeSchedule } from '../services/followups/schedule.js';
import { normalizePhone, unknownPlaceholders, PLACEHOLDERS, smsSegments } from '../services/followups/render.js';
import { recordConsent, updatePreferences, getPrefs, reachableOn, REASONS } from '../services/followups/consent.js';
import {
  getPriceBook, catalogue, getWallet, pendingHolds, usageSince, lineCapacity, grantTrialOnce, unitCosts, unitsOf, tierOf,
} from '../services/followups/wallet.js';
import * as providers from '../services/followups/providers/index.js';
import { createOrder, verifyOrder, cancelOrder, listOrders } from '../services/followups/orders.js';
import {
  listScripts, saveScript, approveScript, scriptVersions, draftScript, translateScript, saveAgent, updateCallback, CALLBACK_STATUSES,
} from '../services/followups/studio.js';
import * as engine from '../services/followups/engine.js';
import { ensureAudio, readAudio } from '../services/followups/audio.js';
import * as exotel from '../services/followups/providers/exotel.js';
import { usableNumbers } from '../services/followups/numbers.js';

const KINDS = ['missed_visits', 'membership_ending', 'payment_due', 'onboarding'];
const CHANNELS = ['call', 'agent', 'sms', 'whatsapp'];
const lang = z.string().refine(isLanguage, 'Unsupported language');
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/);
const dayKeyRe = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Please try again.' });
const productList = (book) => unitsOf(book).map((u) => ({ ...u, available: !u.tier || providers.tierAvailable(u.product, tierOf(book, u.product, u.tier)) }));
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };

/* ═══════════════════════════ PUBLIC: providers & scheduler ═══════════════════════════ */

export function followupPublicRoutes(db) {
  const r = Router();
  const hookLimit = rateLimit({ windowMs: 60_000, max: 1200, keyFn: () => 'followup-hooks' });

  const cron = wrap(async (req, res) => {
    const auth = cronAuthorized(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 503 ? 'Scheduler not configured.' : 'Unauthorized.' });
    res.json(await engine.runAll(db));
  });
  r.get('/cron/tick', cron);
  r.post('/cron/tick', cron);

  // Audio for Exotel to play. Signed URL; nothing else can fetch it.
  r.get('/audio/:file', hookLimit, wrap(async (req, res) => {
    const audioId = String(req.params.file).replace(/\.wav$/, '');
    if (!verify(audioId, String(req.query.t || ''))) return res.status(403).end();
    const buf = await readAudio(db, audioId);
    if (!buf) return res.status(404).end();
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=600' }).send(buf);
  }));

  const audioUrl = (aid) => `${publicBase()}/api/followups/audio/${aid}.wav?t=${sign(aid)}`;
  const jobFromReq = async (req) => {
    const token = req.query.CustomField || req.body?.CustomField || req.query.j || req.body?.j;
    const jobId = readJobToken(token);
    if (jobId) return db.q1('SELECT * FROM followup_jobs WHERE id = ?', [jobId]);
    return null;
  };

  // Exotel Programmable Gather: what to play. First pass plays the message
  // and menu; after a key press (the flow's second gather) the thank-you line.
  r.get('/hooks/exotel/gather', hookLimit, wrap(async (req, res) => {
    const job = await jobFromReq(req);
    const audio = job?.audio_json ? JSON.parse(job.audio_json) : null;
    if (!job || !audio) return res.status(404).json({ error: 'unknown call' });
    if (job.digits && audio.after?.[job.digits]) {
      return res.json({ gather_prompt: { audio_url: audioUrl(audio.after[job.digits]) }, max_input_digits: 1, input_timeout: 1, repeat_menu: 0 });
    }
    res.json({
      gather_prompt: { audio_url: audioUrl(audio.main) }, max_input_digits: 1, finish_on_key: '#', input_timeout: 6,
      repeat_menu: 1, repeat_gather_prompt: { audio_url: audioUrl(audio.menu) },
    });
  }));

  // Exotel Passthru: the key the member pressed.
  r.all('/hooks/exotel/keypress', hookLimit, wrap(async (req, res) => {
    const job = await jobFromReq(req);
    if (!job) return res.status(200).end();
    const digit = exotel.parseDigits(req.query.digits ?? req.body?.digits);
    if (digit) await engine.applyKeypress(db, job, digit);
    res.status(200).end();
  }));

  // Exotel call status (answered / terminal).
  r.post('/hooks/exotel/status', hookLimit, wrap(async (req, res) => {
    const job = await jobFromReq(req);
    if (!job) return res.status(200).json({ ok: false });
    const s = exotel.parseCallStatus({ ...req.query, ...(req.body || {}) });
    if (s.ref && job.provider_ref && s.ref !== job.provider_ref) return res.status(200).json({ ok: false });
    await engine.applyCallStatus(db, job, { status: s.status, duration: s.duration });
    res.json({ ok: true });
  }));

  // Exotel SMS delivery report.
  r.post('/hooks/exotel/sms', hookLimit, wrap(async (req, res) => {
    const job = await jobFromReq(req);
    if (!job) return res.status(200).json({ ok: false });
    const s = exotel.parseSmsStatus({ ...req.query, ...(req.body || {}) });
    if (s.status) await engine.applyMessageStatus(db, job, s.status);
    res.json({ ok: true });
  }));

  // Exotel WhatsApp: delivery statuses and member replies. The URL carries a
  // signed key the operator copies from the admin console.
  r.post('/hooks/exotel/whatsapp', hookLimit, wrap(async (req, res) => {
    if (!verify('whatsapp-inbound', String(req.query.k || ''))) return res.status(403).end();
    const body = req.body || {};
    const items = [].concat(body?.whatsapp?.messages || [], body?.messages || [], body?.statuses || [], body?.whatsapp?.statuses || []);
    for (const m of items.length ? items : [body]) {
      const ref = m.sid || m.id || m.message_id || m?.data?.sid;
      const raw = String(m.status || m.exo_status_code || m?.data?.status || '').toLowerCase();
      if (ref && raw) {
        const job = await db.q1(`SELECT * FROM followup_jobs WHERE provider_ref = ? AND channel = 'whatsapp'`, [ref]);
        const mapped = /read/.test(raw) ? 'read' : /deliver/.test(raw) ? 'delivered' : /fail|undeliv|reject/.test(raw) ? 'failed' : /sent/.test(raw) ? 'sent' : null;
        if (job && mapped) await engine.applyMessageStatus(db, job, mapped);
      }
      const from = m.from || m?.content?.from;
      const text = m?.content?.text?.body || m?.content?.button?.text || m?.content?.interactive?.button_reply?.title || m.text || m.body;
      if (from && text) await engine.applyWhatsAppReply(db, { from, text });
    }
    res.json({ ok: true });
  }));

  // AI conversation results, from whichever provider ran the call. Each
  // adapter verifies its own signature over the raw body and parses its own
  // payload (providers/index.js); this route only applies the result.
  const agentHook = (providerId) => wrap(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
    let conv;
    try { conv = providers.conversationProvider(providerId); } catch { return res.status(404).end(); }
    if (!conv.verifyWebhook(raw, req.headers)) return res.status(401).json({ error: 'bad signature' });
    const result = conv.parseResult(raw);
    if (!result) return res.json({ ok: true, ignored: true });
    const jobId = readJobToken(result.token);
    const job = jobId ? await db.q1('SELECT * FROM followup_jobs WHERE id = ?', [jobId])
      : (result.ref ? await db.q1(`SELECT * FROM followup_jobs WHERE provider_ref = ? AND channel = 'agent'`, [result.ref]) : null);
    if (!job) return res.json({ ok: false });
    await engine.applyAgentResult(db, job, result);
    res.json({ ok: true });
  });
  r.post('/hooks/elevenlabs', hookLimit, agentHook('elevenlabs'));
  r.post('/hooks/agent/:provider', hookLimit, (req, res, next) => (['http'].includes(req.params.provider) ? agentHook(req.params.provider)(req, res, next) : res.status(404).end()));

  return r;
}

/* ═══════════════════════════ AUTHENTICATED ═══════════════════════════ */

export default function followupRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);

  /* ---------------- members: their own preferences ---------------- */
  const me = Router();
  me.use(requireRole('CLIENT'));
  const myClient = async (req) => db.q1('SELECT id, org_id FROM clients WHERE user_id = ?', [req.user.sub]);
  me.get('/', wrap(async (req, res) => {
    const c = await myClient(req);
    if (!c) return res.json({ available: false });
    const prefs = await getPrefs(db, c.org_id, c.id);
    const settings = await engine.getSettings(db, c.org_id);
    const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [c.org_id]);
    const langs = [...new Set(Object.values(settings.languages).flat())];
    res.json({
      available: true, gym: settings.gym_display_name || org?.name,
      channels: {
        call: prefs.call_consent === 'granted' && !prefs.call_opted_out_at,
        sms: prefs.sms_consent === 'granted' && !prefs.sms_opted_out_at,
        whatsapp: prefs.wa_consent === 'granted' && !prefs.wa_opted_out_at,
      },
      human_only: !!Number(prefs.human_only), language: prefs.language, window_start: prefs.window_start, window_end: prefs.window_end,
      languages: languageList().filter((l) => langs.includes(l.code)),
      history: await db.q(`SELECT channel, action, source, created_at FROM followup_consent_log WHERE client_id = ? ORDER BY created_at DESC LIMIT 10`, [c.id]),
    });
  }));
  me.put('/', validate(z.object({
    call: z.boolean().optional(), sms: z.boolean().optional(), whatsapp: z.boolean().optional(),
    human_only: z.boolean().optional(), language: lang.nullable().optional(),
    window_start: hhmm.nullable().optional(), window_end: hhmm.nullable().optional(),
  })), wrap(async (req, res) => {
    const c = await myClient(req);
    if (!c) return res.status(404).json({ error: 'Not a gym member' });
    const b = req.body;
    for (const ch of ['call', 'sms', 'whatsapp']) {
      if (b[ch] === true) await recordConsent(db, { orgId: c.org_id, clientId: c.id, channels: [ch], action: 'opted_in', source: 'member', evidence: 'Turned on in the app', actorId: req.user.sub });
      if (b[ch] === false) await recordConsent(db, { orgId: c.org_id, clientId: c.id, channels: [ch], action: 'opted_out', source: 'member', evidence: 'Turned off in the app', actorId: req.user.sub });
    }
    const patch = {};
    if (b.human_only !== undefined) patch.human_only = b.human_only ? 1 : 0;
    if (b.language !== undefined) patch.language = b.language;
    if (b.window_start !== undefined) patch.window_start = b.window_start;
    if (b.window_end !== undefined) patch.window_end = b.window_end;
    await updatePreferences(db, { orgId: c.org_id, clientId: c.id, patch });
    res.json({ ok: true });
  }));
  r.use('/me', me);

  /* ---------------- trainers: callbacks assigned to them ---------------- */
  const trainer = Router();
  trainer.use(requireRole('TRAINER'));
  trainer.get('/callbacks', wrap(async (req, res) => {
    res.json({
      callbacks: await db.q(
        `SELECT cb.*, u.name AS member_name FROM followup_callbacks cb JOIN clients c ON c.id = cb.client_id JOIN users u ON u.id = c.user_id
          WHERE cb.org_id = ? AND cb.assigned_to = ? AND cb.status IN ('new','assigned','in_progress') ORDER BY cb.created_at DESC`, [req.orgId, req.user.sub]),
    });
  }));
  trainer.put('/callbacks/:id', validate(z.object({ status: z.enum(['in_progress', 'completed', 'unreachable']).optional(), note: z.string().max(1000).optional() })),
    wrap(async (req, res) => {
      try { res.json({ callback: await updateCallback(db, req.orgId, req.params.id, req.body, { trainerId: req.user.sub }) }); } catch (e) { fail(res, e); }
    }));
  r.use('/trainer', trainer);

  /* ---------------- owners ---------------- */
  const o = Router();
  o.use(requireRole('GYM_OWNER', 'SUPER_ADMIN'));
  o.use(rateLimit({ windowMs: 60_000, max: 240, keyFn: (req) => req.user?.sub || 'anon' }));
  const providerLimit = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => `fu-provider:${req.orgId}` });

  // ---- overview ----
  o.get('/overview', wrap(async (req, res) => {
    const orgId = req.orgId;
    await grantTrialOnce(db, orgId);
    const status = setupStatus();
    const book = await getPriceBook(db);
    let tick = null;
    try { tick = status.mode === 'test' ? await engine.maybeTick(db, orgId) : null; } catch { tick = null; }
    const settings = await engine.getSettings(db, orgId);
    const tz = await getOrgTzCached(db, orgId);
    const todayKey = dayKey(new Date(), tz);
    const [wallet, holds, usage, lines, rules, callbacks, todayRows, members, orders] = await Promise.all([
      getWallet(db, orgId, book), pendingHolds(db, orgId), usageSince(db, orgId, monthStart(), book), lineCapacity(db, orgId), engine.loadRules(db, orgId),
      db.q(`SELECT COUNT(*) AS n FROM followup_callbacks WHERE org_id = ? AND status IN ('new','assigned','in_progress')`, [orgId]),
      db.q(`SELECT channel, status, outcome FROM followup_jobs WHERE org_id = ? AND day_key = ? AND is_test = 0`, [orgId, todayKey]),
      engine.loadMembers(db, orgId, tz),
      db.q(`SELECT COUNT(*) AS n FROM followup_orders WHERE org_id = ? AND status = 'SUCCESS'`, [orgId]),
    ]);
    const today = {
      calls: todayRows.filter((j) => j.channel === 'call' || j.channel === 'agent').length,
      connected: todayRows.filter((j) => (j.channel === 'call' || j.channel === 'agent') && j.status === 'completed').length,
      messages: todayRows.filter((j) => j.channel === 'sms' || j.channel === 'whatsapp').length,
      delivered: todayRows.filter((j) => ['delivered', 'read'].includes(j.status)).length,
      queued: todayRows.filter((j) => ['queued', 'dialing', 'answered'].includes(j.status)).length,
      responses: todayRows.filter((j) => j.outcome).length,
    };
    const reach = { total: members.length, call: 0, sms: 0, whatsapp: 0, no_phone: 0, no_permission: 0, opted_out: 0 };
    for (const m of members) {
      if (!m.phone) { reach.no_phone += 1; continue; }
      const on = reachableOn(m.prefs, m.phone);
      for (const ch of ['call', 'sms', 'whatsapp']) if (on[ch]) reach[ch] += 1;
      if (m.prefs?.call_opted_out_at || m.prefs?.sms_opted_out_at || m.prefs?.wa_opted_out_at) reach.opted_out += 1;
      else if (!on.call && !on.sms && !on.whatsapp) reach.no_permission += 1;
    }
    res.json({
      setup: status, settings: publicSettings(settings), wallet, holds, usage, lines, today, products: productList(book),
      campaigns: rules.map(publicRule), callbacks_open: Number(callbacks[0]?.n || 0), reach, purchases: Number(orders[0]?.n || 0),
      in_hours: engine.inCallingHours(settings, tz), tick: tick ? { queued: tick.queued, placed: tick.placed } : null,
    });
  }));

  // ---- settings ----
  o.get('/settings', wrap(async (req, res) => {
    const s = await engine.getSettings(db, req.orgId);
    res.json({ settings: publicSettings(s), languages: languageList(), default_lines: Object.fromEntries(LANGUAGE_CODES.map((c) => [c, defaultLines(c)])), placeholders: PLACEHOLDERS });
  }));
  o.put('/settings', validate(z.object({
    enabled: z.boolean().optional(),
    window_start: hhmm.optional(), window_end: hhmm.optional(),
    days_mask: z.string().regex(/^[01]{7}$/).optional(),
    max_per_day: z.number().int().min(1).max(3).optional(),
    max_per_week: z.number().int().min(1).max(21).optional(),
    language: lang.optional(),
    languages: z.object({ voice: z.array(lang).max(10), agent: z.array(lang).max(10), sms: z.array(lang).max(10), whatsapp: z.array(lang).max(10) }).partial().optional(),
    voices: z.record(z.string(), z.string().max(80)).optional(),
    lines: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    gym_display_name: z.string().trim().max(60).nullable().optional(),
    sms_header: z.string().trim().max(11).nullable().optional(),
    dlt_entity_id: z.string().trim().max(30).nullable().optional(),
    monthly_cap_inr: z.number().min(0).max(10_000_000).nullable().optional(),
  })), wrap(async (req, res) => {
    const b = req.body;
    await engine.getSettings(db, req.orgId);
    const sets = [];
    const vals = [];
    const put = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    if (b.enabled !== undefined) put('enabled', b.enabled ? 1 : 0);
    for (const k of ['window_start', 'window_end', 'days_mask', 'max_per_day', 'max_per_week', 'language', 'gym_display_name', 'sms_header', 'dlt_entity_id', 'monthly_cap_inr']) if (b[k] !== undefined) put(k, b[k]);
    if (b.languages) put('languages_json', JSON.stringify(b.languages));
    if (b.voices) put('voices_json', JSON.stringify(b.voices));
    if (b.lines) put('lines_json', JSON.stringify(b.lines));
    if (sets.length) await db.run(`UPDATE followup_settings SET ${sets.join(', ')}, updated_at = ? WHERE org_id = ?`, [...vals, now(), req.orgId]);
    res.json({ settings: publicSettings(await engine.getSettings(db, req.orgId)) });
  }));

  // Compliance confirmations: what the owner states about their registrations
  // and the basis for contacting members. Required before going live.
  o.put('/compliance', validate(z.object({
    business_registered: z.boolean(), consent_basis: z.string().trim().min(5).max(400), dlt_registered: z.boolean().optional(),
    whatsapp_optin_collected: z.boolean().optional(), accepted_terms: z.literal(true),
  })), wrap(async (req, res) => {
    const record = { ...req.body, by: req.user.sub, at: now(), version: '2026-11' };
    await engine.getSettings(db, req.orgId);
    await db.run('UPDATE followup_settings SET compliance_json = ?, updated_at = ? WHERE org_id = ?', [JSON.stringify(record), now(), req.orgId]);
    res.json({ compliance: record });
  }));

  // ---- buying capacity ----
  o.get('/catalogue', wrap(async (req, res) => {
    const book = await getPriceBook(db);
    res.json({ packs: catalogue(book, (product, tier) => providers.tierAvailable(product, tier)), products: productList(book), version: book.version, wallet: await getWallet(db, req.orgId, book), lines: await lineCapacity(db, req.orgId) });
  }));
  o.post('/orders', rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.user?.sub || 'anon' }),
    validate(z.object({ packId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(20).optional() })),
    wrap(async (req, res) => {
      try { res.json({ order: await createOrder(db, { orgId: req.orgId, userId: req.user.sub, packId: req.body.packId, quantity: req.body.quantity }) }); } catch (e) { fail(res, e); }
    }));
  o.post('/orders/:id/verify', validate(z.object({ providerPaymentId: z.string().min(1), signature: z.string().min(1) })), wrap(async (req, res) => {
    try { res.json({ order: await verifyOrder(db, { orgId: req.orgId, orderId: req.params.id, ...req.body }) }); } catch (e) { fail(res, e); }
  }));
  o.post('/orders/:id/cancel', wrap(async (req, res) => { await cancelOrder(db, req.orgId, req.params.id); res.json({ ok: true }); }));
  o.get('/orders', wrap(async (req, res) => res.json({ orders: (await listOrders(db, req.orgId)).map((x) => ({ ...x, pack: JSON.parse(x.pack_json), pack_json: undefined })) })));

  // ---- usage & billing ----
  o.get('/usage', wrap(async (req, res) => {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const daily = await db.q(
      `SELECT substr(created_at, 1, 10) AS day, unit, SUM(-delta) AS used, SUM(charge_inr) AS spent
         FROM followup_ledger WHERE org_id = ? AND reason = 'usage' AND created_at >= ? GROUP BY substr(created_at, 1, 10), unit ORDER BY day`, [req.orgId, since]);
    const byCampaign = await db.q(
      `SELECT l.rule_id, r.name, l.unit, SUM(-l.delta) AS used, SUM(l.charge_inr) AS spent
         FROM followup_ledger l LEFT JOIN followup_rules r ON r.id = l.rule_id
        WHERE l.org_id = ? AND l.reason = 'usage' AND l.created_at >= ? GROUP BY l.rule_id, r.name, l.unit`, [req.orgId, since]);
    const ledger = await db.q(
      `SELECT id, unit, delta, reason, job_id, order_id, rule_id, charge_inr, note, created_at FROM followup_ledger
        WHERE org_id = ? AND reason != 'hold' AND reason != 'release' ORDER BY created_at DESC LIMIT 200`, [req.orgId]);
    const book = await getPriceBook(db);
    res.json({ days, totals: await usageSince(db, req.orgId, since, book), products: productList(book), daily, byCampaign, ledger, wallet: await getWallet(db, req.orgId, book), holds: await pendingHolds(db, req.orgId) });
  }));

  // ---- campaigns ----
  const sequence = z.array(z.object({ channel: z.enum(CHANNELS), after_hours: z.number().int().min(0).max(12).optional() })).min(1).max(4);
  const campaign = z.object({
    name: z.string().trim().min(2).max(60),
    kind: z.enum(KINDS),
    branch_id: z.string().max(40).nullable().optional(),
    config: z.record(z.string(), z.any()).optional(),
    sequence,
    per_day: z.number().int().min(1).max(3).optional(),
    gap_hours: z.number().int().min(1).max(12).optional(),
    language: lang.optional(),
    voice_tier: z.string().max(30).optional(),
    agent_tier: z.string().max(30).optional(),
    voice_id: z.string().max(120).nullable().optional(),
    script_group_id: z.string().max(40).nullable().optional(),
    sms_group_id: z.string().max(40).nullable().optional(),
    template_group_id: z.string().max(40).nullable().optional(),
    agent_id: z.string().max(40).nullable().optional(),
    ends_on: dayKeyRe.nullable().optional(),
    budget: z.object({ voice: z.number().min(0), agent: z.number().min(0), sms: z.number().min(0), whatsapp: z.number().min(0) }).partial().optional(),
  });
  const checkCampaign = async (orgId, b) => {
    const channels = new Set(b.sequence.map((s) => s.channel));
    if (channels.size !== b.sequence.length) return 'Each channel can appear once in the sequence';
    if (channels.has('call') && channels.has('agent')) return 'Choose either a voice message call or an AI conversation, not both';
    if (channels.has('call') && !b.script_group_id) return 'Pick the message the call will read';
    if (channels.has('agent') && !b.agent_id) return 'Pick the AI agent for the conversation';
    if (channels.has('sms') && !b.sms_group_id) return 'Pick the SMS template';
    if (channels.has('whatsapp') && !b.template_group_id) return 'Pick the WhatsApp template';
    const book = await getPriceBook(db);
    if (channels.has('call') && !tierOf(book, 'voice', b.voice_tier || 'standard')) return 'Pick a call quality';
    if (channels.has('agent') && !tierOf(book, 'agent', b.agent_tier || 'advanced')) return 'Pick a conversation quality';
    const owns = async (table, col, v) => !v || !!(await db.q1(`SELECT 1 AS ok FROM ${table} WHERE ${col} = ? AND org_id = ? LIMIT 1`, [v, orgId]));
    if (!(await owns('followup_scripts', 'group_id', b.script_group_id)) || !(await owns('followup_sms_templates', 'group_id', b.sms_group_id))
      || !(await owns('followup_templates', 'group_id', b.template_group_id)) || !(await owns('followup_agents', 'id', b.agent_id))
      || !(await owns('branches', 'id', b.branch_id))) return 'Something you picked does not belong to this gym';
    return null;
  };
  const ruleCols = (b) => ({
    name: b.name, kind: b.kind, branch_id: b.branch_id || null, config_json: JSON.stringify(normalizeConfig(b.kind, b.config || {})), sequence_json: JSON.stringify(b.sequence),
    per_day: b.per_day ?? 1, gap_hours: b.gap_hours ?? 3, language: b.language || 'en', voice_tier: b.voice_tier || 'standard', agent_tier: b.agent_tier || 'advanced', voice_id: b.voice_id || null,
    script_group_id: b.script_group_id || null, sms_group_id: b.sms_group_id || null, template_group_id: b.template_group_id || null,
    agent_id: b.agent_id || null, ends_on: b.ends_on || null, budget_json: b.budget ? JSON.stringify(b.budget) : null,
  });
  o.get('/rules', wrap(async (req, res) => res.json({ campaigns: (await engine.loadRules(db, req.orgId)).map(publicRule), defaults: RULE_DEFAULTS })));
  o.post('/rules', validate(campaign), wrap(async (req, res) => {
    const problem = await checkCampaign(req.orgId, req.body);
    if (problem) return res.status(422).json({ error: problem });
    const c = ruleCols(req.body);
    const rid = id('fr');
    const ts = now();
    await db.run(`INSERT INTO followup_rules (id, org_id, ${Object.keys(c).join(', ')}, status, created_by, created_at, updated_at) VALUES (?, ?, ${Object.keys(c).map(() => '?').join(', ')}, 'paused', ?, ?, ?)`,
      [rid, req.orgId, ...Object.values(c), req.user.sub, ts, ts]);
    res.json({ campaign: publicRule(engine.parseRule(await db.q1('SELECT * FROM followup_rules WHERE id = ?', [rid]))) });
  }));
  o.put('/rules/:id', validate(campaign), wrap(async (req, res) => {
    const cur = await db.q1('SELECT id FROM followup_rules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!cur) return res.status(404).json({ error: 'Campaign not found' });
    const problem = await checkCampaign(req.orgId, req.body);
    if (problem) return res.status(422).json({ error: problem });
    const c = ruleCols(req.body);
    await db.run(`UPDATE followup_rules SET ${Object.keys(c).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...Object.values(c), now(), cur.id]);
    res.json({ campaign: publicRule(engine.parseRule(await db.q1('SELECT * FROM followup_rules WHERE id = ?', [cur.id]))) });
  }));
  o.post('/rules/:id/status', validate(z.object({ status: z.enum(['active', 'paused']) })), wrap(async (req, res) => {
    const cur = await db.q1('SELECT * FROM followup_rules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!cur) return res.status(404).json({ error: 'Campaign not found' });
    if (req.body.status === 'active') {
      const s = await engine.getSettings(db, req.orgId);
      if (!s.compliance?.accepted_terms) return res.status(409).json({ error: 'Confirm the compliance checklist in Settings before starting a campaign', code: 'compliance_required' });
    }
    await db.run('UPDATE followup_rules SET status = ?, updated_at = ? WHERE id = ?', [req.body.status, now(), cur.id]);
    if (req.body.status === 'paused') {
      await db.run(`UPDATE followup_jobs SET status = 'skipped', error = 'Campaign paused', ended_at = ?, updated_at = ? WHERE rule_id = ? AND status = 'queued'`, [now(), now(), cur.id]);
    }
    res.json({ ok: true });
  }));
  o.delete('/rules/:id', wrap(async (req, res) => {
    await db.run(`UPDATE followup_jobs SET status = 'skipped', error = 'Campaign deleted', ended_at = ?, updated_at = ? WHERE rule_id = ? AND org_id = ? AND status = 'queued'`, [now(), now(), req.params.id, req.orgId]);
    const r2 = await db.run('DELETE FROM followup_rules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    res.json({ ok: r2.changes === 1 });
  }));
  // Who it would reach today and what that would use -- before it is switched on.
  o.post('/rules/preview', validate(campaign.partial({ name: true })), wrap(async (req, res) => {
    const preview = await engine.previewRule(db, req.orgId, { ...req.body, config: normalizeConfig(req.body.kind, req.body.config || {}), name: req.body.name || 'Preview' });
    const book = await getPriceBook(db);
    const est = {};
    for (const m of preview.members) {
      const unit = engine.unitFor(m.channel, req.body);
      est[unit] = (est[unit] || 0) + (m.channel === 'agent' ? 2 : 1);
    }
    res.json({ ...preview, schedule: describeSchedule(req.body.kind, req.body.config || {}), estimate: est, products: productList(book), held_reasons: REASONS });
  }));

  // ---- Script Studio ----
  o.get('/scripts', wrap(async (req, res) => res.json({ groups: await listScripts(db, req.orgId), placeholders: PLACEHOLDERS })));
  o.post('/scripts', validate(z.object({
    group_id: z.string().max(40).nullable().optional(), name: z.string().trim().min(2).max(80).optional(),
    purpose: z.enum([...KINDS, 'general']).optional(), channel_type: z.enum(['voice', 'text']).optional(),
    language: lang, body: z.string().min(1).max(1200), approve: z.boolean().optional(),
  })), wrap(async (req, res) => {
    try {
      const b = req.body;
      res.json({ script: await saveScript(db, req.orgId, req.user.sub, { groupId: b.group_id || null, name: b.name, purpose: b.purpose, channelType: b.channel_type, language: b.language, body: b.body, approve: b.approve !== false }) });
    } catch (e) { fail(res, e); }
  }));
  o.post('/scripts/:id/approve', wrap(async (req, res) => { try { await approveScript(db, req.orgId, req.user.sub, req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); } }));
  o.get('/scripts/:id/versions', wrap(async (req, res) => res.json({ versions: await scriptVersions(db, req.orgId, req.params.id) })));
  o.delete('/scripts/:id', wrap(async (req, res) => { await db.run('DELETE FROM followup_scripts WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]); res.json({ ok: true }); }));
  o.get('/starters', wrap(async (req, res) => res.json({ starters: Object.fromEntries(KINDS.map((k) => [k, starterFor(String(req.query.language || 'en'), k)])) })));
  o.post('/scripts/draft', providerLimit, validate(z.object({ purpose: z.string().min(3).max(200), channel_type: z.enum(['voice', 'text']), language: lang, notes: z.string().max(400).optional() })),
    wrap(async (req, res) => { try { res.json(await draftScript({ purpose: req.body.purpose, channelType: req.body.channel_type, language: req.body.language, notes: req.body.notes })); } catch (e) { fail(res, e); } }));
  o.post('/scripts/translate', providerLimit, validate(z.object({ body: z.string().min(2).max(1200), from: lang, to: lang })),
    wrap(async (req, res) => { try { res.json({ text: await translateScript(req.body) }); } catch (e) { fail(res, e); } }));
  o.post('/preview-text', validate(z.object({ channel: z.enum(['call', 'sms', 'whatsapp']), body: z.string().max(1200), language: lang, kind: z.enum(KINDS).optional() })),
    wrap(async (req, res) => {
      const s = await engine.getSettings(db, req.orgId);
      const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [req.orgId]);
      res.json({ ...engine.previewText({ ...req.body, kind: req.body.kind || 'missed_visits', settings: s, gym: s.gym_display_name || org?.name }), unknown: unknownPlaceholders(req.body.body) });
    }));

  // ---- voices ----
  o.get('/voices', wrap(async (req, res) => {
    const saved = await db.q(`SELECT id, provider_voice_id, provider, name, source, description, created_at FROM followup_voices WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at`, [req.orgId]);
    const engines = providers.speechProviders();
    let library = [];
    let errors = [];
    if (engines.length) ({ voices: library, errors } = await providers.listAllVoices());
    const book = await getPriceBook(db);
    res.json({
      saved, library, library_available: engines.length > 0, library_error: errors.join(' · ') || null,
      engines: engines.map((p) => ({ id: p.id, label: p.label, features: p.features })),
      tiers: (book.tiers.voice || []).map((t) => ({ id: t.id, name: t.name, tagline: t.tagline, provider: t.provider, available: providers.tierAvailable('voice', t) })),
      can_design: !!providers.speechWith('design'), can_clone: !!providers.speechWith('clone'),
    });
  }));
  o.post('/voices', validate(z.object({ provider_voice_id: z.string().min(3).max(120), name: z.string().trim().min(1).max(60), description: z.string().max(200).optional() })), wrap(async (req, res) => {
    const ref = providers.parseVoiceRef(req.body.provider_voice_id);
    try {
      await db.run('INSERT INTO followup_voices (id, org_id, provider_voice_id, provider, name, source, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id('fv'), req.orgId, providers.voiceRef(ref.providerId, ref.voiceId), ref.providerId, req.body.name, 'library', req.body.description || null, now()]);
    } catch (e) { if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e; }
    res.json({ ok: true });
  }));
  o.post('/voices/design', providerLimit, validate(z.object({ description: z.string().trim().min(20).max(1000), text: z.string().max(1000).optional() })), wrap(async (req, res) => {
    const p = providers.speechWith('design');
    if (!p) return res.status(503).json({ error: 'Designing voices is not available on this server' });
    try { res.json({ previews: await p.designVoice(req.body), provider: p.id }); } catch (e) { fail(res, e); }
  }));
  o.post('/voices/design/save', providerLimit, validate(z.object({ generated_voice_id: z.string().min(3), name: z.string().trim().min(1).max(60), description: z.string().max(1000) })), wrap(async (req, res) => {
    const p = providers.speechWith('design');
    if (!p) return res.status(503).json({ error: 'Designing voices is not available on this server' });
    try {
      const vid = await p.saveDesignedVoice({ generatedVoiceId: req.body.generated_voice_id, name: req.body.name, description: req.body.description });
      const ref = providers.voiceRef(p.id, vid);
      await db.run('INSERT INTO followup_voices (id, org_id, provider_voice_id, provider, name, source, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id('fv'), req.orgId, ref, p.id, req.body.name, 'designed', req.body.description, now()]);
      res.json({ provider_voice_id: ref });
    } catch (e) { fail(res, e); }
  }));
  // Cloning only with the speaker's recorded authorization.
  o.post('/voices/clone', providerLimit, validate(z.object({
    name: z.string().trim().min(1).max(60),
    speaker: z.enum(['self', 'staff_with_consent']),
    speaker_name: z.string().trim().min(2).max(80),
    statement: z.literal(true),
    sample_base64: z.string().min(1000).max(8_000_000),
    sample_type: z.enum(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/mp4']),
  })), wrap(async (req, res) => {
    const p = providers.speechWith('clone');
    if (!p) return res.status(503).json({ error: 'Using a real voice is not available on this server' });
    try {
      const b = req.body;
      const vid = await p.cloneVoice({ name: b.name, description: `Authorized by ${b.speaker_name}`, files: [{ buffer: Buffer.from(b.sample_base64, 'base64'), type: b.sample_type, name: 'sample' }] });
      const ref = providers.voiceRef(p.id, vid);
      const auth = { speaker: b.speaker, speaker_name: b.speaker_name, statement: 'I am this speaker, or I have their written consent, to create and use an AI copy of this voice for this gym only.', version: '2026-11', by: req.user.sub, at: now() };
      await db.run('INSERT INTO followup_voices (id, org_id, provider_voice_id, provider, name, source, description, authorization_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id('fv'), req.orgId, ref, p.id, b.name, 'cloned', `Voice of ${b.speaker_name}`, JSON.stringify(auth), now()]);
      res.json({ provider_voice_id: ref });
    } catch (e) { fail(res, e); }
  }));
  o.delete('/voices/:id', wrap(async (req, res) => {
    const v = await db.q1('SELECT * FROM followup_voices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!v) return res.status(404).json({ error: 'Voice not found' });
    if (v.source !== 'library') {
      const ref = providers.parseVoiceRef(v.provider_voice_id);
      try { await ref.provider.deleteVoice?.(ref.voiceId); } catch { /* recorded as deleted either way */ }
    }
    await db.run('UPDATE followup_voices SET deleted_at = ? WHERE id = ?', [now(), v.id]);
    res.json({ ok: true });
  }));
  // "Hear it": real speech in the chosen voice, by whichever engine owns it. Cached; rate limited.
  o.post('/hear', providerLimit, validate(z.object({ voice_id: z.string().min(3).max(120), text: z.string().min(2).max(1500), language: lang })), wrap(async (req, res) => {
    if (!providers.speechProviders().length) return res.status(503).json({ error: 'Listening needs a voice provider on this server.' });
    try {
      const a = await ensureAudio(db, req.orgId, { voiceId: req.body.voice_id, language: req.body.language, text: req.body.text });
      res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(await readAudio(db, a.id));
    } catch (e) { fail(res, e); }
  }));

  // ---- WhatsApp templates ----
  o.get('/templates', wrap(async (req, res) => res.json({ templates: await db.q('SELECT * FROM followup_templates WHERE org_id = ? ORDER BY name, language', [req.orgId]) })));
  o.post('/templates', validate(z.object({
    group_id: z.string().max(40).nullable().optional(), name: z.string().trim().min(2).max(60), purpose: z.enum([...KINDS, 'general']).optional(),
    body: z.string().trim().min(10).max(900), language: lang, category: z.enum(['UTILITY', 'MARKETING']).optional(),
  })), wrap(async (req, res) => {
    const b = req.body;
    const unknown = unknownPlaceholders(b.body);
    if (unknown.length) return res.status(422).json({ error: `Unknown details: ${unknown.map((u) => `{${u}}`).join(', ')}` });
    const tid = id('ft');
    const ts = now();
    await db.run(`INSERT INTO followup_templates (id, org_id, group_id, name, purpose, body, language, category, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      [tid, req.orgId, b.group_id || id('ftg'), b.name, b.purpose || 'general', b.body, b.language, b.category || (b.purpose === 'missed_visits' || b.purpose === 'onboarding' ? 'MARKETING' : 'UTILITY'), ts, ts]);
    res.json({ template: await db.q1('SELECT * FROM followup_templates WHERE id = ?', [tid]) });
  }));
  o.post('/templates/:id/submit', providerLimit, wrap(async (req, res) => {
    const t = await db.q1('SELECT * FROM followup_templates WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    if (!['draft', 'rejected'].includes(t.status)) return res.status(409).json({ error: 'Already submitted' });
    const providerName = `g${req.orgId.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase()}_${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}_${t.language}_${Date.now().toString(36)}`;
    try {
      const { quickRepliesFor } = await import('../services/followups/languages.js');
      const q = quickRepliesFor(t.language, t.purpose === 'general' ? 'missed_visits' : t.purpose);
      let status;
      {
        const r2 = await providers.whatsapp().createTemplate({ name: providerName, language: t.language, category: t.category, body: t.body,
          examples: { name: 'Rahul', gym: 'Iron Forge', branch: 'Main', plan: 'Quarterly', end_date: '12 November', days_left: '3', days_absent: '7', days_since_joining: '3', amount_due: '₹1,500', gym_phone: '+91 98765 43210', trainer: 'Asha', owner: 'Vikram', app_link: 'https://barbell.app' },
          quickReplies: [q.callMe, q.onIt, q.stop] });
        status = r2.status;
      }
      await db.run('UPDATE followup_templates SET provider_name = ?, status = ?, submitted_at = ?, rejection_reason = NULL, updated_at = ? WHERE id = ?', [providerName, status, now(), now(), t.id]);
      res.json({ template: await db.q1('SELECT * FROM followup_templates WHERE id = ?', [t.id]) });
    } catch (e) { fail(res, e); }
  }));
  o.post('/templates/:id/refresh', providerLimit, wrap(async (req, res) => {
    const t = await db.q1('SELECT * FROM followup_templates WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!t || !t.provider_name) return res.status(404).json({ error: 'Template not found' });
    try {
      const s = await providers.whatsapp().templateStatus({ name: t.provider_name });
      await db.run('UPDATE followup_templates SET status = ?, rejection_reason = ?, updated_at = ? WHERE id = ?', [s.status, s.reason, now(), t.id]);
      res.json({ template: await db.q1('SELECT * FROM followup_templates WHERE id = ?', [t.id]) });
    } catch (e) { fail(res, e); }
  }));
  o.delete('/templates/:id', wrap(async (req, res) => { await db.run('DELETE FROM followup_templates WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]); res.json({ ok: true }); }));

  // ---- SMS templates (DLT) ----
  o.get('/sms-templates', wrap(async (req, res) => {
    const rows = await db.q('SELECT * FROM followup_sms_templates WHERE org_id = ? ORDER BY name, language', [req.orgId]);
    res.json({ templates: rows.map((t) => ({ ...t, ...smsSegments(t.body) })) });
  }));
  const smsTemplate = z.object({
    group_id: z.string().max(40).nullable().optional(), name: z.string().trim().min(2).max(60), purpose: z.enum([...KINDS, 'general']).optional(),
    body: z.string().trim().min(5).max(600), language: lang, dlt_template_id: z.string().trim().max(30).nullable().optional(),
    sms_type: z.enum(['transactional', 'promotional']).optional(), status: z.enum(['draft', 'active', 'disabled']).optional(),
  });
  o.post('/sms-templates', validate(smsTemplate), wrap(async (req, res) => {
    const b = req.body;
    const unknown = unknownPlaceholders(b.body);
    if (unknown.length) return res.status(422).json({ error: `Unknown details: ${unknown.map((u) => `{${u}}`).join(', ')}` });
    if (b.status === 'active' && setupStatus().mode === 'live' && !b.dlt_template_id) return res.status(422).json({ error: 'Enter the DLT template id before turning this on' });
    const tid = id('fst');
    const ts = now();
    await db.run(`INSERT INTO followup_sms_templates (id, org_id, group_id, name, purpose, body, language, dlt_template_id, sms_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tid, req.orgId, b.group_id || id('fsmg'), b.name, b.purpose || 'general', b.body, b.language, b.dlt_template_id || null, b.sms_type || 'transactional', b.status || 'active', ts, ts]);
    res.json({ template: await db.q1('SELECT * FROM followup_sms_templates WHERE id = ?', [tid]) });
  }));
  o.put('/sms-templates/:id', validate(smsTemplate.partial()), wrap(async (req, res) => {
    const t = await db.q1('SELECT * FROM followup_sms_templates WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    const b = req.body;
    if (b.body && unknownPlaceholders(b.body).length) return res.status(422).json({ error: 'Unknown details in the message' });
    const cols = ['name', 'body', 'language', 'dlt_template_id', 'sms_type', 'status'].filter((k) => b[k] !== undefined);
    if (cols.length) await db.run(`UPDATE followup_sms_templates SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...cols.map((k) => b[k]), now(), t.id]);
    res.json({ template: await db.q1('SELECT * FROM followup_sms_templates WHERE id = ?', [t.id]) });
  }));
  o.delete('/sms-templates/:id', wrap(async (req, res) => { await db.run('DELETE FROM followup_sms_templates WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]); res.json({ ok: true }); }));

  // ---- AI agents ----
  o.get('/agents', wrap(async (req, res) => res.json({ agents: (await db.q(`SELECT * FROM followup_agents WHERE org_id = ? AND status = 'active' ORDER BY created_at`, [req.orgId])).map((a) => ({ ...a, faqs: JSON.parse(a.faqs_json || '[]'), faqs_json: undefined, provider_agent_id: undefined, provider_hash: undefined })) })));
  const agentInput = z.object({
    name: z.string().trim().min(2).max(60), language: lang, voice_id: z.string().max(80).nullable().optional(), greeting: z.string().max(300).nullable().optional(),
    purpose: z.string().trim().min(10).max(600), knowledge: z.string().max(4000).optional(), faqs: z.array(z.object({ q: z.string().max(200), a: z.string().max(500) })).max(30).optional(),
  });
  o.post('/agents', validate(agentInput), wrap(async (req, res) => { try { res.json({ agent: await saveAgent(db, req.orgId, req.user.sub, req.body) }); } catch (e) { fail(res, e); } }));
  o.put('/agents/:id', validate(agentInput), wrap(async (req, res) => { try { res.json({ agent: await saveAgent(db, req.orgId, req.user.sub, { ...req.body, id: req.params.id }) }); } catch (e) { fail(res, e); } }));
  o.get('/agents/:id/versions', wrap(async (req, res) => res.json({ versions: (await db.q('SELECT version, snapshot_json, created_by, created_at FROM followup_agent_versions WHERE agent_id = ? AND org_id = ? ORDER BY version DESC', [req.params.id, req.orgId])).map((v) => ({ ...v, snapshot: JSON.parse(v.snapshot_json), snapshot_json: undefined })) })));
  o.delete('/agents/:id', wrap(async (req, res) => { await db.run(`UPDATE followup_agents SET status = 'archived', updated_at = ? WHERE id = ? AND org_id = ?`, [now(), req.params.id, req.orgId]); res.json({ ok: true }); }));

  // ---- numbers ----
  o.get('/numbers', wrap(async (req, res) => {
    const rows = await db.q(`SELECT n.id, n.number, n.label, n.branch_id, b.name AS branch_name, n.number_type, n.is_primary, n.health, n.status, n.created_at,
                                    (SELECT COUNT(*) FROM followup_member_prefs p WHERE p.number_id = n.id) AS members
                               FROM followup_numbers n LEFT JOIN branches b ON b.id = n.branch_id WHERE n.org_id = ? ORDER BY n.is_primary DESC, n.created_at`, [req.orgId]);
    const usable = new Set((await usableNumbers(db, req.orgId)).map((n) => n.id));
    res.json({ numbers: rows.map((n) => ({ ...n, in_use: usable.has(n.id) })), capacity: await lineCapacity(db, req.orgId), shared_line: setupStatus().platformLine, branches: await db.q(`SELECT id, name FROM branches WHERE org_id = ? AND status = 'ACTIVE' ORDER BY name`, [req.orgId]) });
  }));
  o.put('/numbers/:id', validate(z.object({ label: z.string().max(40).nullable().optional(), branch_id: z.string().max(40).nullable().optional(), is_primary: z.boolean().optional() })), wrap(async (req, res) => {
    const n = await db.q1('SELECT * FROM followup_numbers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!n) return res.status(404).json({ error: 'Number not found' });
    if (req.body.branch_id && !(await db.q1('SELECT id FROM branches WHERE id = ? AND org_id = ?', [req.body.branch_id, req.orgId]))) return res.status(422).json({ error: 'Unknown branch' });
    if (req.body.is_primary) await db.run('UPDATE followup_numbers SET is_primary = 0 WHERE org_id = ?', [req.orgId]);
    const cols = ['label', 'branch_id'].filter((k) => req.body[k] !== undefined);
    const vals = cols.map((k) => req.body[k]);
    if (req.body.is_primary !== undefined) { cols.push('is_primary'); vals.push(req.body.is_primary ? 1 : 0); }
    if (cols.length) await db.run(`UPDATE followup_numbers SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now(), n.id]);
    res.json({ ok: true });
  }));

  // ---- members: permission and limits ----
  o.get('/members', wrap(async (req, res) => {
    const tz = await getOrgTzCached(db, req.orgId);
    const members = await engine.loadMembers(db, req.orgId, tz);
    res.json({
      members: members.map((m) => ({
        id: m.id, name: m.name, phone_ok: !!m.phone, branch: m.branchName, reach: m.phone ? reachableOn(m.prefs, m.phone) : { call: false, sms: false, whatsapp: false },
        consent: { call: m.prefs?.call_consent || null, sms: m.prefs?.sms_consent || null, whatsapp: m.prefs?.wa_consent || null },
        opted_out: { call: !!m.prefs?.call_opted_out_at, sms: !!m.prefs?.sms_opted_out_at, whatsapp: !!m.prefs?.wa_opted_out_at },
        human_only: !!Number(m.prefs?.human_only), language: m.prefs?.language || null, paused_until: m.prefs?.paused_until || null, max_per_day: m.prefs?.max_per_day || null,
      })),
    });
  }));
  // The owner records that members gave permission, with the evidence. A
  // member's own "stop" is never overridden here (consent.js).
  o.post('/members/consent', validate(z.object({
    client_ids: z.array(z.string().max(40)).max(5000), channels: z.array(z.enum(['call', 'sms', 'whatsapp'])).min(1),
    action: z.enum(['granted', 'withdrawn']), evidence: z.string().trim().min(5).max(300), attest: z.literal(true),
  })), wrap(async (req, res) => {
    const owned = new Set((await db.q('SELECT id FROM clients WHERE org_id = ?', [req.orgId])).map((c) => c.id));
    let changed = 0;
    let kept = 0;
    for (const cid of req.body.client_ids) {
      if (!owned.has(cid)) continue;
      const done = await recordConsent(db, { orgId: req.orgId, clientId: cid, channels: req.body.channels, action: req.body.action, source: 'owner', evidence: req.body.evidence, actorId: req.user.sub });
      if (done.length) changed += 1; else kept += 1;
    }
    res.json({ changed, kept_member_choice: kept });
  }));
  o.put('/members/:id/prefs', validate(z.object({ paused_until: dayKeyRe.nullable().optional(), max_per_day: z.number().int().min(1).max(3).nullable().optional(), language: lang.nullable().optional() })), wrap(async (req, res) => {
    const c = await db.q1('SELECT id FROM clients WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!c) return res.status(404).json({ error: 'Member not found' });
    await updatePreferences(db, { orgId: req.orgId, clientId: c.id, patch: req.body });
    res.json({ ok: true });
  }));
  o.get('/members/:id/history', wrap(async (req, res) => {
    const c = await db.q1('SELECT id FROM clients WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!c) return res.status(404).json({ error: 'Member not found' });
    res.json({
      jobs: await db.q(`SELECT j.id, j.channel, j.status, j.outcome, j.digits, j.summary, j.duration_secs, j.language, j.created_at, r.name AS campaign FROM followup_jobs j LEFT JOIN followup_rules r ON r.id = j.rule_id WHERE j.client_id = ? ORDER BY j.created_at DESC LIMIT 100`, [c.id]),
      consent: await db.q('SELECT channel, action, source, evidence, created_at FROM followup_consent_log WHERE client_id = ? ORDER BY created_at DESC LIMIT 50', [c.id]),
    });
  }));

  // ---- activity ----
  o.get('/activity', wrap(async (req, res) => {
    const where = ['j.org_id = ?'];
    const vals = [req.orgId];
    if (CHANNELS.includes(req.query.channel)) { where.push('j.channel = ?'); vals.push(req.query.channel); }
    if (req.query.rule) { where.push('j.rule_id = ?'); vals.push(String(req.query.rule)); }
    if (req.query.before) { where.push('j.created_at < ?'); vals.push(String(req.query.before)); }
    if (req.query.outcome === 'responses') where.push('j.outcome IS NOT NULL');
    const rows = await db.q(
      `SELECT j.id, j.channel, j.status, j.outcome, j.digits, j.summary, j.message_text, j.duration_secs, j.units, j.unit, j.segments, j.language, j.is_test, j.error,
              j.created_at, j.ended_at, j.day_key, u.name AS member_name, j.client_id, r.name AS campaign, j.from_number
         FROM followup_jobs j LEFT JOIN clients c ON c.id = j.client_id LEFT JOIN users u ON u.id = c.user_id LEFT JOIN followup_rules r ON r.id = j.rule_id
        WHERE ${where.join(' AND ')} ORDER BY j.created_at DESC LIMIT 60`, vals);
    res.json({ items: rows });
  }));

  // Upcoming: who each active campaign will contact on the next days.
  o.get('/calendar', wrap(async (req, res) => {
    const tz = await getOrgTzCached(db, req.orgId);
    const rules = (await engine.loadRules(db, req.orgId)).filter((x) => x.active);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const at = new Date(Date.now() + i * 86_400_000);
      let count = 0;
      const byCampaign = [];
      for (const rule of rules) {
        const p = await engine.previewRule(db, req.orgId, { ...rule, config: rule.config, sequence: rule.sequence }, { at, limit: 0 });
        count += p.count;
        if (p.count) byCampaign.push({ id: rule.id, name: rule.name, count: p.count });
      }
      days.push({ day: dayKey(at, tz), count, campaigns: byCampaign });
    }
    res.json({ days });
  }));

  // ---- callbacks ----
  o.get('/callbacks', wrap(async (req, res) => {
    const status = CALLBACK_STATUSES.includes(req.query.status) ? [req.query.status] : ['new', 'assigned', 'in_progress'];
    res.json({
      callbacks: await db.q(
        `SELECT cb.*, u.name AS member_name, a.name AS assignee_name, r.name AS campaign FROM followup_callbacks cb
           JOIN clients c ON c.id = cb.client_id JOIN users u ON u.id = c.user_id
           LEFT JOIN users a ON a.id = cb.assigned_to LEFT JOIN followup_rules r ON r.id = cb.rule_id
          WHERE cb.org_id = ? AND cb.status IN (${status.map(() => '?').join(',')}) ORDER BY cb.priority DESC, cb.created_at DESC LIMIT 200`, [req.orgId, ...status]),
      staff: await db.q(`SELECT id, name FROM users WHERE org_id = ? AND role IN ('TRAINER','GYM_OWNER') AND active = 1 ORDER BY name`, [req.orgId]),
    });
  }));
  o.put('/callbacks/:id', validate(z.object({ status: z.enum(CALLBACK_STATUSES).optional(), note: z.string().max(1000).optional(), assigned_to: z.string().max(40).nullable().optional() })), wrap(async (req, res) => {
    if (req.body.assigned_to && !(await db.q1(`SELECT id FROM users WHERE id = ? AND org_id = ?`, [req.body.assigned_to, req.orgId]))) return res.status(422).json({ error: 'Unknown staff member' });
    try { res.json({ callback: await updateCallback(db, req.orgId, req.params.id, req.body) }); } catch (e) { fail(res, e); }
  }));

  // ---- a test to the owner's own phone ----
  o.post('/test', providerLimit, validate(z.object({
    channel: z.enum(CHANNELS), language: lang, script_id: z.string().max(40).optional(), sms_template_id: z.string().max(40).optional(),
    template_id: z.string().max(40).optional(), agent_id: z.string().max(40).optional(), voice_id: z.string().max(120).nullable().optional(), kind: z.enum(KINDS).optional(),
    voice_tier: z.string().max(30).optional(), agent_tier: z.string().max(30).optional(),
  })), wrap(async (req, res) => {
    const b = req.body;
    const me2 = await db.q1('SELECT phone FROM users WHERE id = ?', [req.user.sub]);
    const kind = b.kind || 'missed_visits';
    let body = null;
    let rule = { kind, voice_id: b.voice_id || null, voice_tier: b.voice_tier || 'standard', agent_tier: b.agent_tier || 'advanced' };
    let agent = null;
    if (b.channel === 'call') {
      const s = b.script_id && await db.q1('SELECT body, language FROM followup_scripts WHERE id = ? AND org_id = ?', [b.script_id, req.orgId]);
      body = s?.body || starterFor(b.language, kind);
    } else if (b.channel === 'sms') {
      const s = b.sms_template_id && await db.q1('SELECT * FROM followup_sms_templates WHERE id = ? AND org_id = ?', [b.sms_template_id, req.orgId]);
      if (!s) return res.status(422).json({ error: 'Pick an SMS template' });
      body = s.body; rule = { ...rule, dlt_template_id: s.dlt_template_id };
    } else if (b.channel === 'whatsapp') {
      const t = b.template_id && await db.q1('SELECT * FROM followup_templates WHERE id = ? AND org_id = ?', [b.template_id, req.orgId]);
      if (!t || t.status !== 'approved') return res.status(422).json({ error: 'Pick an approved WhatsApp template' });
      body = t.body; rule = { ...rule, provider_name: t.provider_name };
    } else {
      agent = b.agent_id && await db.q1(`SELECT * FROM followup_agents WHERE id = ? AND org_id = ? AND status = 'active'`, [b.agent_id, req.orgId]);
      if (!agent) return res.status(422).json({ error: 'Pick an AI agent' });
    }
    try {
      const job = await engine.testContact(db, req.orgId, { phone: me2?.phone, channel: b.channel, rule, body, agent, language: b.language });
      res.json({ job });
    } catch (e) { fail(res, e); }
  }));

  // ---- analytics: what happened, and what happened after (association only) ----
  o.get('/analytics', wrap(async (req, res) => {
    const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
    const tz = await getOrgTzCached(db, req.orgId);
    const since = shiftDayKey(dayKey(new Date(), tz), -days);
    const rows = await db.q(
      `SELECT j.rule_id, r.name, j.channel, j.status, j.outcome, j.client_id, j.day_key, j.units, j.unit
         FROM followup_jobs j LEFT JOIN followup_rules r ON r.id = j.rule_id WHERE j.org_id = ? AND j.day_key >= ? AND j.is_test = 0`, [req.orgId, since]);
    const visits = await db.q(`SELECT client_id, date FROM attendance WHERE org_id = ? AND present = 1 AND date >= ?`, [req.orgId, since]);
    const renewals = await db.q(`SELECT client_id, start_date FROM subscriptions WHERE org_id = ? AND start_date >= ?`, [req.orgId, since]);
    const spent = await db.q(`SELECT rule_id, SUM(charge_inr) AS v FROM followup_ledger WHERE org_id = ? AND reason = 'usage' AND created_at >= ? GROUP BY rule_id`, [req.orgId, `${since}T00:00:00.000Z`]);
    const spentBy = new Map(spent.map((s) => [s.rule_id, Number(s.v) || 0]));
    const camp = new Map();
    for (const j of rows) {
      const k = j.rule_id || 'test';
      if (!camp.has(k)) camp.set(k, { id: j.rule_id, name: j.name || 'Deleted campaign', calls: 0, connected: 0, messages: 0, delivered: 0, responses: 0, callbacks: 0, opt_outs: 0, members: new Map() });
      const c = camp.get(k);
      if (j.channel === 'call' || j.channel === 'agent') { c.calls += 1; if (j.status === 'completed') c.connected += 1; } else { c.messages += 1; if (['delivered', 'read'].includes(j.status)) c.delivered += 1; }
      if (j.outcome) c.responses += 1;
      if (j.outcome === 'callback') c.callbacks += 1;
      if (j.outcome === 'opted_out') c.opt_outs += 1;
      const first = c.members.get(j.client_id);
      if (!first || j.day_key < first) c.members.set(j.client_id, j.day_key);
    }
    const out = [...camp.values()].filter((c) => c.id).map((c) => {
      let visitedAfter = 0;
      let renewedAfter = 0;
      for (const [cid, first] of c.members) {
        const until = shiftDayKey(first, 7);
        if (visits.some((v) => v.client_id === cid && v.date >= first && v.date <= until)) visitedAfter += 1;
        if (renewals.some((s) => s.client_id === cid && String(s.start_date).slice(0, 10) >= first && String(s.start_date).slice(0, 10) <= shiftDayKey(first, 14))) renewedAfter += 1;
      }
      const members = c.members.size;
      const spend = Math.round((spentBy.get(c.id) || 0) * 100) / 100;
      return { id: c.id, name: c.name, members, calls: c.calls, connected: c.connected, messages: c.messages, delivered: c.delivered, responses: c.responses, callbacks: c.callbacks, opt_outs: c.opt_outs, visited_within_7d: visitedAfter, renewed_within_14d: renewedAfter, spend, cost_per_return: visitedAfter ? Math.round((spend / visitedAfter) * 100) / 100 : null };
    });
    res.json({ days, campaigns: out, note: 'Visits and renewals after contact are shown as association, not proof that the contact caused them.' });
  }));

  r.use(o);
  return r;
}

/* ---------------- shapes the owner sees ---------------- */

function publicSettings(s) {
  return {
    enabled: s.enabled, window_start: s.window_start, window_end: s.window_end, days_mask: s.days_mask, max_per_day: s.max_per_day, max_per_week: s.max_per_week,
    language: s.language, languages: s.languages, voices: s.voices, lines: s.lines, gym_display_name: s.gym_display_name, whatsapp_from: s.whatsapp_from,
    sms_header: s.sms_header, dlt_entity_id: s.dlt_entity_id, monthly_cap_inr: s.monthly_cap_inr, compliance: s.compliance, effective_window: engine.callingWindow(s),
  };
}

function publicRule(r) {
  return {
    id: r.id, name: r.name, kind: r.kind, status: r.status, branch_id: r.branch_id, config: r.config, sequence: r.sequence, per_day: r.per_day, gap_hours: r.gap_hours,
    language: r.language, voice_tier: r.voice_tier, agent_tier: r.agent_tier, voice_id: r.voice_id, script_group_id: r.script_group_id, sms_group_id: r.sms_group_id, template_group_id: r.template_group_id,
    agent_id: r.agent_id, ends_on: r.ends_on, budget: r.budget, schedule: describeSchedule(r.kind, r.config), created_at: r.created_at, updated_at: r.updated_at,
  };
}

export const _unitCostsForConsole = unitCosts;
