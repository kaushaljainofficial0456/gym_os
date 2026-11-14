// ============================================================
// AI COMMUNICATION ENGINE -- who to contact, when, how; and what happened.
//
//   tickOrg()      sweep stale jobs -> plan who is due -> dispatch
//   planOrg()      for every active campaign and member: is a step due
//                  (schedule.js)? which channel of its sequence is next? do
//                  consent, caps, budget and content allow it? -> a queued job
//   dispatchOrg()  claim queued jobs, re-check consent, hold or charge
//                  capacity, make the audio, place the call / send the
//                  message (or simulate it in test mode)
//   apply*()       outcomes from providers' webhooks (or the simulator)
//
// A campaign step is one contact DAY. On it the campaign's channel SEQUENCE
// runs in order -- e.g. WhatsApp, then (if no reply after 4 hours) a call --
// stopping at the first response. A step is never revisited on a later day;
// when steps were missed, the latest one due is used, so a member never gets
// a burst of catch-ups.
//
// Every gate is checked when planning AND again at dispatch:
//   platform not paused; feature on; campaign active and not past its end
//   date; inside calling hours (09:00-21:00 at most) on an allowed day
//   consent.evaluate() for the member and channel (permission, opt-outs,
//   human-only, pauses, wrong number, pending callback, their own preferred
//   time, daily and weekly caps -- across ALL campaigns)
//   content in a language the member chose (else held for review), and no
//   detail the message needs is missing (never a blank)
//   capacity in the right product; the campaign's budget; the owner's
//   monthly spending cap
// ============================================================
import { id, now } from '../../ids.js';
import { config as appConfig } from '../../config.js';
import { dayKey, getOrgTzCached, shiftDayKey } from '../../utils/time.js';
import { setupStatus, jobToken, publicBase, exotelEnv } from './config.js';
import * as providers from './providers/index.js';
import { dueStep, normalizeConfig } from './schedule.js';
import { quickRepliesFor, spokenLines, isLanguage, LANGUAGE_CODES } from './languages.js';
import { normalizePhone, firstName, buildVoiceMessage, buildText, formatVariables, missingDetails, smsSegments, fill, toMetaBody } from './render.js';
import { evaluate, recordConsent, consentKey, REASONS } from './consent.js';
import { getWallet, holdUnits, settleJob, chargeMessage, refundJob, attachProviderRef, unitCosts, getPriceBook, spentSince, tierOf } from './wallet.js';
import { lineFor } from './numbers.js';
import { ensureAudio } from './audio.js';
import { pickVariant, agentPrompt, agentHash, openCallback } from './studio.js';

const HARD_START = 9 * 60;
const HARD_END = 21 * 60;
export const AGENT_MAX_MIN = 3;                    // an AI call's hold, and its length limit
const POSITIVE = new Set(['on_it', 'coming_back', 'renewing', 'will_pay']);
const FINAL = new Set(['completed', 'no_answer', 'busy', 'failed', 'skipped', 'sent', 'delivered', 'read']);
const CALLISH = new Set(['call', 'agent']);
/** The balance a channel spends, for this campaign's tier. */
export const unitFor = (channel, rule) => (channel === 'call' ? `voice:${rule?.voice_tier || 'standard'}` : channel === 'agent' ? `agent:${rule?.agent_tier || 'advanced'}` : channel);
const productOf = (unit) => String(unit).split(':')[0];
const CHANNEL_LANG_KEY = { call: 'voice', agent: 'agent', sms: 'sms', whatsapp: 'whatsapp' };

const err = (msg, status = 422) => Object.assign(new Error(msg), { status });
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/* ---------------- settings, clock, platform switches ---------------- */

const hhmm = (s, dflt) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])) : dflt;
};

export async function getSettings(db, orgId) {
  let s = await db.q1('SELECT * FROM followup_settings WHERE org_id = ?', [orgId]);
  if (!s) {
    try { await db.run('INSERT INTO followup_settings (org_id, updated_at) VALUES (?, ?)', [orgId, now()]); } catch (e) { if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e; }
    s = await db.q1('SELECT * FROM followup_settings WHERE org_id = ?', [orgId]);
  }
  const language = isLanguage(s.language) ? s.language : 'en';
  const langs = parse(s.languages_json, {});
  const enabled = {};
  for (const ch of ['voice', 'agent', 'sms', 'whatsapp']) {
    const list = Array.isArray(langs[ch]) ? langs[ch].filter(isLanguage) : [];
    enabled[ch] = list.length ? list : [language];
  }
  return {
    ...s,
    enabled: !!Number(s.enabled),
    language,
    languages: enabled,
    voices: parse(s.voices_json, {}),
    lines: parse(s.lines_json, null),
    compliance: parse(s.compliance_json, {}),
    max_per_day: Math.min(3, Math.max(1, Number(s.max_per_day) || 2)),
    max_per_week: Math.min(21, Math.max(1, Number(s.max_per_week) || 6)),
  };
}

export function callingWindow(settings) {
  const start = Math.max(HARD_START, hhmm(settings.window_start, 10 * 60));
  const end = Math.min(HARD_END, hhmm(settings.window_end, 19 * 60 + 30));
  return { start, end: Math.max(start, end) };
}

export function localClock(tz, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')), weekday: wd < 0 ? 0 : wd };
}

export function inCallingHours(settings, tz, at = new Date()) {
  const { start, end } = callingWindow(settings);
  const { minutes, weekday } = localClock(tz, at);
  return String(settings.days_mask || '1111110').padEnd(7, '0')[weekday] === '1' && minutes >= start && minutes < end;
}

export async function platformSwitches(db) {
  const row = await db.q1(`SELECT paused, paused_channels FROM followup_platform WHERE id = 'current'`);
  return { paused: !!Number(row?.paused), channels: new Set(parse(row?.paused_channels, [])) };
}

async function gymDetails(db, orgId, settings) {
  const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [orgId]);
  const owner = await db.q1(`SELECT name FROM users WHERE org_id = ? AND role = 'GYM_OWNER' ORDER BY created_at LIMIT 1`, [orgId]);
  const primary = await db.q1(`SELECT number FROM followup_numbers WHERE org_id = ? AND status = 'active' ORDER BY is_primary DESC, created_at LIMIT 1`, [orgId]);
  return { gym: settings?.gym_display_name || org?.name || 'your gym', owner: firstName(owner?.name), primaryNumber: primary?.number || null };
}

/* ---------------- members ---------------- */

/**
 * Members with the facts their schedules run on. `clientIds` narrows it to a
 * few members (dispatch re-checks only the ones it is about to contact).
 */
export async function loadMembers(db, orgId, tz, { clientIds = null } = {}) {
  const ids = clientIds ? [...new Set(clientIds.filter(Boolean))] : null;
  if (ids && !ids.length) return [];
  const only = (col) => (ids ? ` AND ${col} IN (${ids.map(() => '?').join(',')})` : '');
  const p = (...head) => (ids ? [...head, ...ids] : head);
  const members = await db.q(
    `SELECT c.id, c.created_at, c.trainer_id, u.name, u.phone, gm.branch_id, b.name AS branch_name, b.phone AS branch_phone, t.name AS trainer_name
       FROM clients c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN gym_memberships gm ON gm.user_id = u.id AND gm.org_id = c.org_id
       LEFT JOIN branches b ON b.id = gm.branch_id
       LEFT JOIN users t ON t.id = c.trainer_id
      WHERE c.org_id = ? AND u.active = 1${only('c.id')}`, p(orgId));
  const subs = await db.q(`SELECT id, client_id, plan_name, start_date, end_date, status, payment_status, amount FROM subscriptions WHERE org_id = ? AND status != 'cancelled'${only('client_id')}`, p(orgId));
  const paid = await db.q(`SELECT subscription_id, SUM(amount) AS paid FROM payments WHERE org_id = ? AND status = 'paid' AND subscription_id IS NOT NULL${only('client_id')} GROUP BY subscription_id`, p(orgId));
  const visits = await db.q(`SELECT client_id, MAX(date) AS last FROM attendance WHERE org_id = ? AND present = 1${only('client_id')} GROUP BY client_id`, p(orgId));
  const entries = await db.q(`SELECT client_id, MAX(ts) AS last FROM attendance_events WHERE org_id = ? AND direction = 'entry'${only('client_id')} GROUP BY client_id`, p(orgId));
  const prefs = await db.q(`SELECT * FROM followup_member_prefs WHERE org_id = ?${only('client_id')}`, p(orgId));

  const paidBy = new Map(paid.map((p) => [p.subscription_id, Number(p.paid) || 0]));
  const lastVisit = new Map(visits.map((v) => [v.client_id, String(v.last).slice(0, 10)]));
  for (const e of entries) {
    const k = dayKey(new Date(e.last), tz);
    if (!lastVisit.has(e.client_id) || k > lastVisit.get(e.client_id)) lastVisit.set(e.client_id, k);
  }
  const subsBy = new Map();
  for (const s of subs) { if (!subsBy.has(s.client_id)) subsBy.set(s.client_id, []); subsBy.get(s.client_id).push(s); }
  const prefBy = new Map(prefs.map((p) => [p.client_id, p]));

  return members.map((m) => {
    const list = (subsBy.get(m.id) || []).sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)));
    const cur = list[0] || null;
    const unpaid = list.find((s) => ['pending', 'overdue'].includes(s.payment_status) && Number(s.amount) - (paidBy.get(s.id) || 0) > 0);
    return {
      id: m.id, name: m.name, trainerId: m.trainer_id, trainerName: m.trainer_name, branchId: m.branch_id, branchName: m.branch_name, branchPhone: m.branch_phone,
      phone: normalizePhone(m.phone),
      prefs: prefBy.get(m.id) || null,
      plan: cur?.plan_name || null,
      facts: {
        lastVisitKey: lastVisit.get(m.id) || null,
        joinedKey: String(cur?.start_date || m.created_at || '').slice(0, 10) || null,
        membership: cur ? { id: cur.id, startKey: String(cur.start_date).slice(0, 10), endKey: String(cur.end_date).slice(0, 10), status: cur.status } : null,
        payment: unpaid ? { subscriptionId: unpaid.id, sinceKey: String(unpaid.start_date).slice(0, 10), amountDue: Number(unpaid.amount) - (paidBy.get(unpaid.id) || 0) } : null,
      },
    };
  });
}

function memberVariables(member, gymInfo, stepVars) {
  return {
    name: firstName(member.name), gym: gymInfo.gym, branch: member.branchName || null, plan: member.plan || null,
    trainer: firstName(member.trainerName) || null, owner: gymInfo.owner || null,
    gym_phone: member.branchPhone || gymInfo.primaryNumber || null,
    app_link: `${(appConfig.frontendUrl || '').replace(/\/+$/, '')}/app/client`,
    ...stepVars,
  };
}

/* ---------------- campaigns & content ---------------- */

export function parseRule(r) {
  const seq = parse(r.sequence_json, []);
  const sequence = (Array.isArray(seq) ? seq : []).filter((s) => ['call', 'agent', 'sms', 'whatsapp'].includes(s?.channel)).slice(0, 4)
    .map((s, i) => ({ channel: s.channel, after_hours: i === 0 ? 0 : Math.min(12, Math.max(0, Math.round(Number(s.after_hours) || 0))) }));
  return {
    ...r,
    active: r.status === 'active',
    config: normalizeConfig(r.kind, parse(r.config_json, {})),
    sequence: sequence.length ? sequence : [{ channel: 'call', after_hours: 0 }],
    per_day: Math.min(3, Math.max(1, Number(r.per_day) || 1)),
    gap_hours: Math.min(12, Math.max(1, Number(r.gap_hours) || 3)),
    budget: parse(r.budget_json, {}),
  };
}

export const loadRules = async (db, orgId) => (await db.q('SELECT * FROM followup_rules WHERE org_id = ? ORDER BY created_at', [orgId])).map(parseRule);

/** Approved content the campaigns may use, grouped. */
async function loadContent(db, orgId) {
  const scripts = await db.q('SELECT * FROM followup_scripts WHERE org_id = ?', [orgId]);
  const sms = await db.q(`SELECT * FROM followup_sms_templates WHERE org_id = ? AND status = 'active'`, [orgId]);
  const wa = await db.q(`SELECT * FROM followup_templates WHERE org_id = ?`, [orgId]);
  const agents = await db.q(`SELECT * FROM followup_agents WHERE org_id = ? AND status = 'active'`, [orgId]);
  const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.group_id)) m.set(r.group_id, []); m.get(r.group_id).push(r); } return m; };
  return {
    scripts: group(scripts),
    sms: group(sms.map((t) => ({ ...t, approved_at: t.dlt_template_id || setupStatus().mode !== 'live' ? t.updated_at : null }))),
    wa: group(wa.map((t) => ({ ...t, approved_at: t.status === 'approved' ? t.updated_at : null }))),
    agents: new Map(agents.map((a) => [a.id, a])),
  };
}

/**
 * The content for one channel, in the member's language if they chose one
 * the gym enabled for that channel, else the campaign's fallback.
 * { language, body, ref } or { missing: reason }.
 */
export function contentFor({ channel, rule, member, settings, content }) {
  const enabled = settings.languages[CHANNEL_LANG_KEY[channel]] || [settings.language];
  const wanted = member.prefs?.language && enabled.includes(member.prefs.language) ? member.prefs.language : null;
  const fallback = enabled.includes(rule.language) ? rule.language : settings.language;
  if (channel === 'agent') {
    const agent = rule.agent_id ? content.agents.get(rule.agent_id) : null;
    if (!agent) return { missing: 'no_agent' };
    if (wanted && wanted !== agent.language) return { missing: 'no_language' };
    return { language: agent.language, agent };
  }
  const groupId = channel === 'call' ? rule.script_group_id : channel === 'sms' ? rule.sms_group_id : rule.template_group_id;
  const map = channel === 'call' ? content.scripts : channel === 'sms' ? content.sms : content.wa;
  const variants = groupId ? map.get(groupId) : null;
  if (!variants?.length) return { missing: channel === 'whatsapp' ? 'template_not_approved' : 'no_message' };
  const v = pickVariant(variants, { memberLanguage: wanted, fallback });
  if (!v) return { missing: channel === 'whatsapp' && variants.some((x) => x.status === 'pending') ? 'template_pending' : 'no_language' };
  return { language: v.language, body: v.body, ref: v };
}

/* ---------------- planning ---------------- */

async function loadHistory(db, orgId, todayKey) {
  const since = shiftDayKey(todayKey, -120);
  const rows = await db.q(
    `SELECT id, rule_id, client_id, channel, cycle_key, step_key, seq_index, day_key, status, outcome, to_number, attempt, created_at, ended_at
       FROM followup_jobs WHERE org_id = ? AND day_key >= ? AND client_id IS NOT NULL AND is_test = 0`, [orgId, since]);
  const callbacks = await db.q(`SELECT client_id FROM followup_callbacks WHERE org_id = ? AND status IN ('new','assigned','in_progress')`, [orgId]);
  const spentByRule = await db.q(`SELECT rule_id, unit, SUM(-delta) AS n FROM followup_ledger WHERE org_id = ? AND reason = 'usage' AND rule_id IS NOT NULL GROUP BY rule_id, unit`, [orgId]);
  const budgetUsed = new Map();
  for (const r of spentByRule) {
    const k = `${r.rule_id}:${productOf(r.unit)}`;
    budgetUsed.set(k, (budgetUsed.get(k) || 0) + (Number(r.n) || 0));
  }
  return { rows, callbacks: new Set(callbacks.map((c) => c.client_id)), budgetUsed, weekStart: shiftDayKey(todayKey, -6) };
}

const responded = (j) => (CALLISH.has(j.channel) ? ['answered', 'completed'].includes(j.status) && (j.channel === 'call' || j.outcome) : !!j.outcome);

/**
 * What to do now for one campaign and member. Pure over its inputs.
 * { skip: reason, step? } or { channel, seqIndex, attempt, step }.
 */
export function decide({ rule, member, settings, todayKey, history, nowMs, localMinutes, inHours }) {
  const step = dueStep(rule.kind, rule.config, member.facts, todayKey);
  if (!step) return { skip: 'not_due' };
  if (rule.ends_on && todayKey > rule.ends_on) return { skip: 'campaign_ended', step };

  const mine = history.rows.filter((j) => j.client_id === member.id);
  const wrongNumber = mine.some((j) => j.outcome === 'wrong_number' && j.to_number === member.phone);
  if (mine.some((j) => j.rule_id === rule.id && j.cycle_key === step.cycleKey && j.outcome === 'not_interested')) return { skip: 'not_interested', step };
  const snoozeCutoff = new Date(nowMs - rule.config.snooze_days * 86_400_000).toISOString();
  if (mine.some((j) => j.rule_id === rule.id && POSITIVE.has(j.outcome) && j.created_at >= snoozeCutoff)) return { skip: 'snoozed', step };

  const stepJobs = mine.filter((j) => j.rule_id === rule.id && j.cycle_key === step.cycleKey && j.step_key === step.stepKey);
  if (stepJobs.some((j) => j.day_key < todayKey)) return { skip: 'step_done', step };
  if (stepJobs.some(responded)) return { skip: 'responded', step };

  const today = mine.filter((j) => j.day_key === todayKey);
  const week = mine.filter((j) => j.day_key >= history.weekStart);
  const counts = {
    callsToday: today.filter((j) => CALLISH.has(j.channel)).length,
    messagesToday: 0,
    contactsThisWeek: week.length,
  };
  const caps = { perCall: Math.min(settings.max_per_day, member.prefs?.max_per_day ? Number(member.prefs.max_per_day) : 3), perWeek: settings.max_per_week };

  // Walk the sequence: the first channel not finished is the one to work on.
  for (let i = 0; i < rule.sequence.length; i++) {
    const { channel, after_hours: afterHours } = rule.sequence[i];
    const jobs = stepJobs.filter((j) => j.seq_index === i);
    const callLike = CALLISH.has(channel);
    const inFlight = jobs.some((j) => !FINAL.has(j.status));
    if (inFlight) return { skip: 'in_progress', step };
    const finished = callLike ? jobs.length >= rule.per_day || jobs.some((j) => j.status === 'skipped') : jobs.length > 0;
    if (finished) continue;
    // Escalation delay: wait after the previous channel's first contact.
    // (A channel skipped because the member can't be reached on it has no
    // jobs, so there is nothing to wait after.)
    if (i > 0) {
      const prev = stepJobs.filter((j) => j.seq_index === i - 1);
      if (prev.length) {
        const first = prev.reduce((m, j) => Math.min(m, Date.parse(j.created_at) || nowMs), nowMs);
        if (nowMs - first < afterHours * 3600_000) return { skip: 'waiting_to_escalate', step };
      }
    }
    if (callLike && jobs.length) {
      const lastEnd = jobs.reduce((m, j) => Math.max(m, Date.parse(j.ended_at || j.created_at) || 0), 0);
      if (nowMs - lastEnd < rule.gap_hours * 3600_000) return { skip: 'waiting_gap', step };
    }
    counts.messagesToday = today.filter((j) => j.channel === channel && !callLike).length;
    const verdict = evaluate({
      prefs: member.prefs, phone: member.phone, channel, todayKey, localMinutes, inGymHours: inHours,
      ...counts, caps, wrongNumber, callbackPending: history.callbacks.has(member.id),
    });
    if (verdict.decision !== 'ALLOW') {
      // A channel the member can't be reached on is skipped over, not waited on.
      if (verdict.decision === 'DENY' && i < rule.sequence.length - 1) continue;
      return { skip: verdict.reason, decision: verdict.decision, step };
    }
    return { channel, seqIndex: i, attempt: jobs.length + 1, step };
  }
  return { skip: 'sequence_done', step };
}

export async function planOrg(db, orgId, { at = new Date() } = {}) {
  const status = setupStatus();
  const settings = await getSettings(db, orgId);
  const out = { queued: 0, skipped: {} };
  const platform = await platformSwitches(db);
  if (platform.paused) return { ...out, reason: 'platform_paused' };
  if (!settings.enabled || status.mode === 'off') return { ...out, reason: settings.enabled ? 'not_live' : 'disabled' };
  const tz = await getOrgTzCached(db, orgId);
  const inHours = inCallingHours(settings, tz, at);
  if (!inHours) return { ...out, reason: 'outside_hours' };
  const todayKey = dayKey(at, tz);
  const rules = (await loadRules(db, orgId)).filter((r) => r.active);
  if (!rules.length) return { ...out, reason: 'no_campaigns' };
  if (settings.monthly_cap_inr) {
    const spent = await spentSince(db, orgId, `${todayKey.slice(0, 8)}01T00:00:00.000Z`);
    if (spent >= Number(settings.monthly_cap_inr)) return { ...out, reason: 'spend_cap' };
  }
  const members = await loadMembers(db, orgId, tz);
  const history = await loadHistory(db, orgId, todayKey);
  const content = await loadContent(db, orgId);
  const book = await getPriceBook(db);
  const balance = await getWallet(db, orgId, book);
  const gymInfo = await gymDetails(db, orgId, settings);
  const { minutes: localMinutes } = localClock(tz, at);
  const nowMs = at.getTime();
  const bump = (k) => { out.skipped[k] = (out.skipped[k] || 0) + 1; };

  for (const member of members) {
    for (const rule of rules) {
      if (rule.branch_id && member.branchId !== rule.branch_id) continue;
      const d = decide({ rule, member, settings, todayKey, history, nowMs, localMinutes, inHours });
      if (d.skip) { if (d.skip !== 'not_due') bump(d.skip); continue; }
      if (platform.channels.has(d.channel)) { bump('channel_paused'); continue; }
      const unit = unitFor(d.channel, rule);
      const need = d.channel === 'agent' ? AGENT_MAX_MIN : 1;
      if (CALLISH.has(d.channel) && !providers.tierAvailable(productOf(unit), tierOf(book, productOf(unit), unit.split(':')[1]))) { bump('tier_unavailable'); continue; }
      if ((balance[unit] || 0) < need) { bump('no_capacity'); continue; }
      const product = productOf(unit);
      if (rule.budget?.[product] && (history.budgetUsed.get(`${rule.id}:${product}`) || 0) >= Number(rule.budget[product])) { bump('budget_reached'); continue; }
      const c = contentFor({ channel: d.channel, rule, member, settings, content });
      if (c.missing) { bump(c.missing); continue; }
      const vars = memberVariables(member, gymInfo, d.step.variables);
      const textForCheck = d.channel === 'agent' ? '' : c.body;
      const missing = missingDetails(textForCheck, vars);
      if (missing.length) { bump('missing_details'); continue; }
      const dedupe = `${rule.id}:${member.id}:${d.step.cycleKey}:${d.step.stepKey}:${d.seqIndex}:${todayKey}:${d.attempt}`;
      const ts = now();
      try {
        await db.run(
          `INSERT INTO followup_jobs (id, org_id, branch_id, rule_id, client_id, channel, dedupe_key, cycle_key, step_key, seq_index, day_key, attempt, language, status, to_number, unit, variables_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
          [id('fj'), orgId, member.branchId || null, rule.id, member.id, d.channel, dedupe, d.step.cycleKey, d.step.stepKey, d.seqIndex, todayKey, d.attempt, c.language, member.phone, unit, JSON.stringify(vars), ts, ts]);
        balance[unit] -= need;
        history.rows.push({ rule_id: rule.id, client_id: member.id, channel: d.channel, cycle_key: d.step.cycleKey, step_key: d.step.stepKey, seq_index: d.seqIndex, day_key: todayKey, status: 'queued', created_at: ts, to_number: member.phone });
        out.queued += 1;
      } catch (e) {
        if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e;
      }
    }
  }
  return out;
}

/* ---------------- dispatch ---------------- */

async function patchJob(db, jobId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await db.run(`UPDATE followup_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => patch[k]), now(), jobId]);
}
const skipJob = (db, jobId, reason) => patchJob(db, jobId, { status: 'skipped', error: reason, ended_at: now() });

/** Build (or rebuild, when the agent changed) the agent on its provider. */
async function ensureProviderAgent(db, agent, kind, settings, gymName, conv) {
  const hash = agentHash(agent, kind);
  if (agent.provider_agent_id && agent.provider === conv.id && agent.provider_hash === hash) return agent.provider_agent_id;
  const lines = spokenLines(agent.language, kind, settings.lines);
  const greeting = (agent.greeting || lines.agentIntro).replace(/\{name\}/g, '{{member_name}}').replace(/\{gym\}/g, '{{gym_name}}');
  // A voice belongs to one speech engine; an agent provider can only use its own.
  const ref = agent.voice_id || settings.voices?.[agent.language] || null;
  const v = ref ? providers.parseVoiceRef(ref) : null;
  const voiceId = !v ? null : conv.id === 'http' ? ref : (v.providerId === conv.id ? v.voiceId : null);
  const providerId = await conv.upsertAgent({
    agentId: agent.provider === conv.id ? agent.provider_agent_id : null, name: `${gymName} · ${agent.name}`, prompt: agentPrompt(agent, kind),
    firstMessage: greeting, language: agent.language, voiceId, maxSecs: AGENT_MAX_MIN * 60,
  });
  await db.run('UPDATE followup_agents SET provider = ?, provider_agent_id = ?, provider_hash = ?, updated_at = ? WHERE id = ?', [conv.id, providerId, hash, now(), agent.id]);
  return providerId;
}

/**
 * Place one claimed job through the provider interfaces. Every failure is
 * recorded honestly and its capacity given back. A `simulated` result (test
 * mode) is applied exactly like the provider's webhook would be.
 */
async function placeJob(db, job, ctx) {
  const { settings, rules, mode, book, gymInfo, content } = ctx;
  const rule = job.rule_id ? rules.get(job.rule_id) : ctx.testRule;
  const vars = parse(job.variables_json, {});
  const costs = unitCosts(book);
  const live = mode === 'live';
  const member = { prefs: job.client_id ? await db.q1('SELECT * FROM followup_member_prefs WHERE client_id = ?', [job.client_id]) : null, phone: job.to_number };

  if (!job.is_test) {
    // Consent can be withdrawn between planning and now.
    const k = consentKey(job.channel);
    const p = member.prefs || {};
    if (p[`${k}_consent`] !== 'granted' || p[`${k}_opted_out_at`] || Number(p.human_only)) return skipJob(db, job.id, 'The member is no longer reachable on this channel');
    if (!rule) return skipJob(db, job.id, 'The campaign was deleted');
    if (!rule.active) return skipJob(db, job.id, 'The campaign is paused');
  }

  const c = job.is_test ? ctx.testContent : contentFor({ channel: job.channel, rule, member: { prefs: { ...member.prefs, language: job.language } }, settings, content });
  if (!c || c.missing) return skipJob(db, job.id, 'The message for this language is no longer available');

  /* ---- WhatsApp ---- */
  if (job.channel === 'whatsapp') {
    const wa = ctx.whatsapp;
    const text = buildText(c.body, c.language, vars);
    if (!(await chargeMessage(db, job, 'whatsapp', 1, { cost: costs.whatsapp, provider: wa.id, pricingVersion: book.version }))) return skipJob(db, job.id, 'No WhatsApp capacity left');
    try {
      const from = settings.whatsapp_from || exotelEnv().whatsappFrom || (live ? null : 'test');
      if (!from) throw err('No WhatsApp sender is set up for this gym', 503);
      const f = formatVariables(vars, c.language);
      const params = toMetaBody(c.body).order.map((k) => f[k] || '');
      const r = await wa.sendTemplate({ from, to: job.to_number, templateName: c.ref.provider_name, language: c.language, params, seed: job.id });
      const status = r.simulated ? r.simulated.status : 'sent';
      await patchJob(db, job.id, { status, provider: wa.id, provider_ref: r.ref, from_number: from, message_text: text, ...(r.simulated ? { ended_at: now() } : {}) });
      await attachProviderRef(db, job.id, r.ref);
      if (status === 'failed') await refundJob(db, job, 'Not delivered');
    } catch (e) {
      await refundJob(db, job, 'Send failed');
      await patchJob(db, job.id, { status: 'failed', error: String(e.message).slice(0, 300), ended_at: now() });
    }
    return;
  }

  /* ---- SMS ---- */
  if (job.channel === 'sms') {
    const sms = ctx.sms;
    const text = buildText(c.body, c.language, vars);
    const seg = smsSegments(text).segments;
    if (!(await chargeMessage(db, job, 'sms', seg, { cost: seg * costs.sms, provider: sms.id, pricingVersion: book.version }))) return skipJob(db, job.id, 'No SMS capacity left');
    try {
      if (live && (!settings.sms_header || !settings.dlt_entity_id || !c.ref?.dlt_template_id)) throw err('SMS needs a DLT header, entity id and template id', 503);
      const r = await sms.send({
        from: settings.sms_header, to: job.to_number, body: text, dltEntityId: settings.dlt_entity_id, dltTemplateId: c.ref?.dlt_template_id,
        smsType: c.ref?.sms_type, statusUrl: `${publicBase()}/api/followups/hooks/exotel/sms?j=${encodeURIComponent(jobToken(job.id))}`, seed: job.id,
      });
      const status = r.simulated ? r.simulated.status : 'sent';
      await patchJob(db, job.id, { status, provider: sms.id, provider_ref: r.ref, from_number: settings.sms_header || null, message_text: text, segments: r.segments || seg, ...(r.simulated ? { ended_at: now() } : {}) });
      await attachProviderRef(db, job.id, r.ref);
      if (status === 'failed') await refundJob(db, job, 'Not delivered');
    } catch (e) {
      await refundJob(db, job, 'Send failed');
      await patchJob(db, job.id, { status: 'failed', error: String(e.message).slice(0, 300), ended_at: now() });
    }
    return;
  }

  /* ---- calls (voice message or AI conversation) ---- */
  const line = await lineFor(db, job.org_id, { clientId: job.client_id, branchId: job.branch_id, test: !live });
  if (!line) return skipJob(db, job.id, 'No caller line is set up');
  const unit = job.unit || unitFor(job.channel, rule);
  const tier = tierOf(book, productOf(unit), unit.split(':')[1]);
  if (live && !providers.tierAvailable(productOf(unit), tier)) return skipJob(db, job.id, 'This call quality is not available right now');
  const hold = job.channel === 'agent' ? AGENT_MAX_MIN : 1;
  if (!(await holdUnits(db, job.org_id, unit, hold, { jobId: job.id, ruleId: job.rule_id }))) {
    return skipJob(db, job.id, job.channel === 'agent' ? 'Not enough AI conversation minutes left' : 'No voice minutes left');
  }
  const held = { ...job, unit, units_held: hold };

  if (job.channel === 'agent') {
    try {
      const conv = providers.conversationProvider(live ? tier.provider : 'test');
      const agentId = await ensureProviderAgent(db, c.agent, rule?.kind, settings, gymInfo.gym, conv);
      const f = formatVariables(vars, c.language);
      const r = await conv.startCall({
        agentId, lineRef: line.agentPhoneId, to: job.to_number, seed: job.id, kind: rule?.kind,
        variables: { member_name: f.name || '', gym_name: f.gym || gymInfo.gym, days_absent: f.days_absent || '', end_date: f.end_date || '', amount_due: f.amount_due || '', followup_job: jobToken(job.id) },
      });
      await patchJob(db, job.id, { provider: conv.id, provider_ref: r.ref, from_number: line.number });
      if (r.simulated) await applyAgentResult(db, held, r.simulated);
    } catch (e) {
      await settleJob(db, held, { used: 0 });
      await patchJob(db, job.id, { status: 'failed', error: String(e.message).slice(0, 300), ended_at: now() });
    }
    return;
  }

  try {
    const tel = ctx.telephony;
    const msg = buildVoiceMessage({ script: c.body, language: c.language, kind: rule?.kind || 'missed_visits', overrides: settings.lines, vars });
    let audio = null;
    if (live) {
      // Exotel's flow waits only seconds for audio: make all of it first.
      // The voice must belong to this tier's speech engine.
      const voiceId = [rule?.voice_id, settings.voices?.[`${tier.id}:${c.language}`], settings.voices?.[c.language]]
        .find((ref) => ref && providers.parseVoiceRef(ref).providerId === tier.provider);
      if (!voiceId) throw err(`Pick a ${tier.name} voice for ${c.language} first`);
      audio = { main: (await ensureAudio(db, job.org_id, { voiceId, language: c.language, text: msg.full })).id, menu: (await ensureAudio(db, job.org_id, { voiceId, language: c.language, text: msg.menu })).id, after: {} };
      for (const k of ['1', '2', '9']) audio.after[k] = (await ensureAudio(db, job.org_id, { voiceId, language: c.language, text: msg.after[k] })).id;
    }
    const r = await tel.placeMessageCall({
      to: job.to_number, callerId: line.number, token: jobToken(job.id), seed: job.id,
      statusUrl: `${publicBase()}/api/followups/hooks/exotel/status?j=${encodeURIComponent(jobToken(job.id))}`,
    });
    await patchJob(db, job.id, { provider: tel.id, provider_ref: r.ref, from_number: line.number, audio_json: audio ? JSON.stringify(audio) : null, message_text: msg.full });
    if (r.simulated) {
      await applyCallStatus(db, held, { status: r.simulated.status, duration: r.simulated.duration });
      if (r.simulated.digits) await applyKeypress(db, held, r.simulated.digits);
    }
  } catch (e) {
    await settleJob(db, held, { used: 0 });
    await patchJob(db, job.id, { status: 'failed', error: String(e.message).slice(0, 300), ended_at: now() });
  }
}

async function dispatchContext(db, orgId, mode) {
  const settings = await getSettings(db, orgId);
  return {
    settings, mode,
    rules: new Map((await loadRules(db, orgId)).map((r) => [r.id, r])),
    book: await getPriceBook(db),
    gymInfo: await gymDetails(db, orgId, settings),
    content: await loadContent(db, orgId),
    telephony: providers.telephony(),
    sms: providers.sms(),
    whatsapp: providers.whatsapp(),
  };
}

/**
 * The member-level gates again, at the moment of sending. A job can sit in
 * the queue for several ticks (dispatch places `max` per tick), and in that
 * time the member may have been paused, pressed 1 on another call, or moved
 * outside their own preferred time. Returns null (send), { skip } or { defer }.
 */
async function sendGate(db, job, { todayKey, localMinutes, callbacks, rules, members }) {
  if (job.day_key !== todayKey) return { skip: 'Not placed on the day it was due' };
  // Still due? A visit, a renewal or a payment since planning ends it NOW,
  // not after the queue drains (docs/FOLLOWUPS.md, "Smart stops").
  const rule = job.rule_id ? rules.get(job.rule_id) : null;
  if (rule) {
    const m = members.get(job.client_id);
    if (!m) return { skip: 'The member is no longer active at this gym' };
    const step = dueStep(rule.kind, rule.config, m.facts, todayKey);
    if (!step || step.cycleKey !== job.cycle_key) return { skip: 'No longer due: the member visited, renewed or paid' };
    if (m.phone !== job.to_number) return { skip: "The member's number changed since planning" };
  }
  const prefs = job.client_id ? await db.q1('SELECT * FROM followup_member_prefs WHERE client_id = ?', [job.client_id]) : null;
  const v = evaluate({ prefs, phone: job.to_number, channel: job.channel, todayKey, localMinutes, inGymHours: true, callbackPending: callbacks.has(job.client_id) });
  if (v.decision === 'ALLOW') return null;
  if (v.decision === 'DEFER' && v.reason === 'outside_member_window') return { defer: true };   // later today, inside their window
  return { skip: REASONS[v.reason] || 'The member can no longer be reached on this channel' };
}

export async function dispatchOrg(db, orgId, { max = 25, budgetMs = 20_000, at = new Date() } = {}) {
  const started = Date.now();
  const mode = setupStatus().mode;
  if (mode === 'off') return { placed: 0 };
  const platform = await platformSwitches(db);
  if (platform.paused) return { placed: 0 };
  // Calling hours and the gym's own switch are checked again here, not only
  // when planning: a queue longer than one tick, or one left over from a
  // platform pause, must never be placed after the gym's hours (21:00 at
  // the latest) or once the owner has switched automations off. Jobs left
  // queued are placed when hours resume the same day, else swept.
  const settings = await getSettings(db, orgId);
  if (!settings.enabled) return { placed: 0, reason: 'disabled' };
  const tz = await getOrgTzCached(db, orgId);
  if (!inCallingHours(settings, tz, at)) return { placed: 0, reason: 'outside_hours' };
  const queued = await db.q(`SELECT * FROM followup_jobs WHERE org_id = ? AND status = 'queued' ORDER BY created_at LIMIT ?`, [orgId, max]);
  if (!queued.length) return { placed: 0 };
  const ctx = await dispatchContext(db, orgId, mode);
  const gate = {
    todayKey: dayKey(at, tz),
    localMinutes: localClock(tz, at).minutes,
    callbacks: new Set((await db.q(`SELECT client_id FROM followup_callbacks WHERE org_id = ? AND status IN ('new','assigned','in_progress')`, [orgId])).map((c) => c.client_id)),
    rules: ctx.rules,
    members: new Map((await loadMembers(db, orgId, tz, { clientIds: queued.map((j) => j.client_id) })).map((m) => [m.id, m])),
  };
  let placed = 0;
  for (const job of queued) {
    if (Date.now() - started > budgetMs) break;
    if (platform.channels.has(job.channel)) { await skipJob(db, job.id, 'This channel is paused by the platform'); continue; }
    const g = await sendGate(db, job, gate);
    if (g?.defer) continue;
    if (g?.skip) { await skipJob(db, job.id, g.skip); continue; }
    const claimed = await db.run(`UPDATE followup_jobs SET status = 'dialing', dialed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`, [now(), now(), job.id]);
    if (claimed.changes !== 1) continue;
    await placeJob(db, { ...job, status: 'dialing' }, ctx);
    placed += 1;
  }
  return { placed };
}

/**
 * Close out calls and messages that never heard back, and stale queue.
 *
 * Provider callbacks can be late, lost or incomplete (Exotel's docs say so and
 * recommend its Call Details API as the fallback). So before a call is written
 * off, the provider's own record is asked:
 *   - a voice call whose callback said "completed" but gave no duration keeps
 *     its hold, and is settled here from the provider's record; if after an
 *     hour the provider still has no duration, the 1-minute minimum pulse is
 *     charged (it connected, so it cost at least that) and the job says so;
 *   - a call that never reported after 30 minutes is settled from the
 *     provider's record when it has one, else failed with nothing charged;
 *   - anything still queued after 6 hours is skipped (never sent late).
 */
export async function sweep(db, orgId, { telephony = providers.telephony(), at = Date.now() } = {}) {
  const iso = (ms) => new Date(ms).toISOString();
  const stale = iso(at - 30 * 60_000);
  let closed = 0;
  const pending = await db.q(
    `SELECT * FROM followup_jobs WHERE org_id = ? AND (
        (status IN ('dialing','answered') AND dialed_at < ?)
     OR (status = 'completed' AND units_held > 0 AND ended_at < ?))
      ORDER BY COALESCE(dialed_at, created_at) LIMIT 100`, [orgId, stale, iso(at - 3 * 60_000)]);   // the oldest first; the rest next tick
  for (const j of pending) {
    if (j.channel === 'call') { if (await reconcileCall(db, j, telephony, at)) closed += 1; continue; }
    await settleJob(db, j, { used: 0 });   // AI conversation / message with no result: nothing charged; reconciliation can correct
    await patchJob(db, j.id, { status: 'failed', error: 'No result from the provider (pending reconciliation)', ended_at: now() });
    closed += 1;
  }
  const b = await db.run(`UPDATE followup_jobs SET status = 'skipped', error = 'Not placed in time', ended_at = ?, updated_at = ? WHERE org_id = ? AND status = 'queued' AND created_at < ?`, [now(), now(), orgId, iso(at - 6 * 3600_000)]);
  return closed + b.changes;
}

export const UNKNOWN_DURATION_NOTE = 'The provider never reported how long this call lasted; charged the 1-minute minimum';

/** One voice call the callbacks left open. True when it is now closed. */
async function reconcileCall(db, j, telephony, at) {
  let record = null;
  if (j.provider_ref && typeof telephony?.fetchCall === 'function') {
    try { record = await telephony.fetchCall(j.provider_ref); } catch { record = null; }   // try again next tick
  }
  if (record?.status && FINAL.has(record.status) && (record.status !== 'completed' || record.duration !== null)) {
    await applyCallStatus(db, j, { status: record.status, duration: record.duration });
    return true;
  }
  const since = Date.parse(j.ended_at || j.dialed_at || j.created_at) || at;
  if (j.status === 'completed' || record?.status === 'completed') {
    if (at - since < 60 * 60_000) return false;                     // details arrive late; look again next tick
    const book = await getPriceBook(db);
    await settleJob(db, j, { used: 1, cost: unitCosts(book)[j.unit] || 0, provider: j.provider, providerRef: j.provider_ref, pricingVersion: book.version });
    await patchJob(db, j.id, { status: 'completed', error: UNKNOWN_DURATION_NOTE, ended_at: j.ended_at || now() });
    return true;
  }
  if (record?.status === 'answered' && at - since < 6 * 3600_000) return false;   // the provider says it is still on
  await settleJob(db, j, { used: 0 });
  await patchJob(db, j.id, { status: 'failed', error: 'No result from the provider (pending reconciliation)', ended_at: now() });
  return true;
}

export async function tickOrg(db, orgId, opts = {}) {
  await db.run('UPDATE followup_settings SET last_tick_at = ? WHERE org_id = ?', [now(), orgId]);
  const swept = await sweep(db, orgId);
  const plan = await planOrg(db, orgId, opts);
  const sent = await dispatchOrg(db, orgId, opts);
  return { swept, ...plan, ...sent };
}

export async function maybeTick(db, orgId) {
  const s = await db.q1('SELECT enabled, last_tick_at FROM followup_settings WHERE org_id = ?', [orgId]);
  if (!s || !Number(s.enabled)) return null;
  if (s.last_tick_at && Date.now() - Date.parse(s.last_tick_at) < 3 * 60_000) return null;
  const r = await db.run('UPDATE followup_settings SET last_tick_at = ? WHERE org_id = ? AND (last_tick_at IS NULL OR last_tick_at = ?)', [now(), orgId, s.last_tick_at]);
  if (r.changes !== 1) return null;
  return tickOrg(db, orgId, { max: 8, budgetMs: 8_000 });
}

const envInt = (k, dflt, lo, hi) => { const n = Math.round(Number(process.env[k])); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt; };

/**
 * The scheduler tick for every gym that is switched on.
 *
 * FAIR: gyms are visited longest-waiting first (by last_tick_at), and each
 * gets at most its share of the time, so one large gym can no longer use up
 * the whole tick while later gyms never run. BOUNDED: the total budget must
 * stay below the hosting function's time limit (on Vercel, maxDuration) --
 * a tick cut off mid-call leaves jobs for the sweep to reconcile.
 *   FOLLOWUP_TICK_BUDGET_MS   whole tick       (default 50000)
 *   FOLLOWUP_TICK_GYM_MS      one gym's share  (default 15000)
 *   FOLLOWUP_DISPATCH_PER_TICK contacts placed per gym per tick (default 25)
 */
export async function runAll(db, { budgetMs = envInt('FOLLOWUP_TICK_BUDGET_MS', 50_000, 5_000, 800_000) } = {}) {
  const started = Date.now();
  const gymMs = envInt('FOLLOWUP_TICK_GYM_MS', 15_000, 2_000, 300_000);
  const max = envInt('FOLLOWUP_DISPATCH_PER_TICK', 25, 1, 500);
  const orgs = await db.q(`SELECT org_id FROM followup_settings WHERE enabled = 1 ORDER BY COALESCE(last_tick_at, ''), org_id`);
  const results = {};
  for (const { org_id: orgId } of orgs) {
    const left = budgetMs - (Date.now() - started);
    if (left < 1_000) break;
    try { results[orgId] = await tickOrg(db, orgId, { max, budgetMs: Math.min(gymMs, left) }); } catch (e) { results[orgId] = { error: String(e.message).slice(0, 200) }; }
  }
  const ran = Object.keys(results).length;
  return { gyms: ran, waiting: orgs.length - ran, results };
}

/* ---------------- outcomes ---------------- */

const fresh = (db, jobId) => db.q1('SELECT * FROM followup_jobs WHERE id = ?', [jobId]);

async function requestCallback(db, job, channel, reason) {
  if (!job.client_id) return;
  await openCallback(db, { orgId: job.org_id, clientId: job.client_id, branchId: job.branch_id, phone: job.to_number, ruleId: job.rule_id, jobId: job.id, channel, reason, priority: 'high' });
}

async function stopChannel(db, job, channel, source, evidence) {
  if (!job.client_id) return;
  await recordConsent(db, { orgId: job.org_id, clientId: job.client_id, channels: [channel], action: 'opted_out', source, evidence });
}

/**
 * A voice-message call's status. Settles the hold on the final status.
 *
 * `duration` null means the provider did not say how long the call was. A
 * "completed" call with no duration is NOT settled at zero (that would give
 * every answered call away): it is marked completed, keeps its hold, and is
 * settled later from the provider's record (sweep/reconcileCall). Out of
 * order and duplicate statuses change nothing once the call is settled.
 */
export async function applyCallStatus(db, job, { status, duration = null }) {
  if (!status) return;
  const j = await fresh(db, job.id);
  if (!j) return;
  const awaitingDuration = j.status === 'completed' && Number(j.units_held) > 0;
  if (FINAL.has(j.status) && !awaitingDuration) return;                     // duplicate or late
  if (awaitingDuration && status !== 'completed') return;                   // only its duration is still to come
  if (!FINAL.has(status)) { await patchJob(db, j.id, { status }); return; }
  const known = duration !== null && duration !== undefined && duration !== '' && Number.isFinite(Number(duration));
  if (status === 'completed' && !known) {
    if (!awaitingDuration) await patchJob(db, j.id, { status: 'completed', ended_at: now() });
    return;
  }
  const secs = known ? Math.max(0, Math.round(Number(duration))) : 0;
  const book = await getPriceBook(db);
  const connected = status === 'completed' && secs > 0;
  const minutes = connected ? Math.max(1, Math.ceil(secs / 60)) : 0;
  await settleJob(db, j, { used: minutes, cost: minutes * (unitCosts(book)[j.unit] || 0), provider: j.provider, providerRef: j.provider_ref, pricingVersion: book.version });
  await patchJob(db, j.id, { status, duration_secs: known ? secs : null, ended_at: j.ended_at || now() });
}

/** The key a member pressed: 1 = a person, 2 = I'm on it, 9 = stop calls. */
export async function applyKeypress(db, job, digit) {
  const j = await fresh(db, job.id);
  if (!j || j.digits) return;
  const outcome = digit === '1' ? 'callback' : digit === '2' ? 'on_it' : digit === '9' ? 'opted_out' : null;
  await patchJob(db, j.id, { digits: digit, ...(outcome ? { outcome } : {}) });
  if (outcome === 'callback') await requestCallback(db, j, 'call', 'Pressed 1 on a follow-up call to talk to someone.');
  if (outcome === 'opted_out') await stopChannel(db, j, 'call', 'keypad', `Pressed 9 on call ${j.id}`);
}

const AGENT_OUTCOMES = {
  coming_back: 'coming_back', renewing: 'renewing', will_pay: 'will_pay', callback_requested: 'callback',
  not_interested: 'not_interested', opted_out: 'opted_out', wrong_number: 'wrong_number', no_conversation: null, other: 'other',
};

/** An AI conversation's result. Settles to the minutes actually talked. */
export async function applyAgentResult(db, job, { status, duration = 0, outcome, summary }) {
  const j = await fresh(db, job.id);
  if (!j) return;
  const done = await db.q1(`SELECT id FROM followup_ledger WHERE job_id = ? AND reason IN ('usage','release') LIMIT 1`, [j.id]);
  if (done) return;                                         // a duplicate webhook
  const mapped = AGENT_OUTCOMES[String(outcome || '').toLowerCase()] ?? null;
  // Whatever a provider (or a self-hosted agent server) calls it, a job holds
  // one of these -- an unknown status must not fail every retry on a CHECK.
  status = ['completed', 'no_answer', 'busy', 'failed'].includes(status) ? status : 'failed';
  duration = Math.max(0, Math.round(Number(duration) || 0));
  const minutes = status === 'completed' && duration > 0 ? Math.ceil(duration / 60) : 0;
  const book = await getPriceBook(db);
  await settleJob(db, j, { used: minutes, cost: minutes * (unitCosts(book)[j.unit] || 0), provider: j.provider, providerRef: j.provider_ref, pricingVersion: book.version });
  await patchJob(db, j.id, { status, duration_secs: duration || null, outcome: mapped, summary: summary ? String(summary).slice(0, 500) : null, ended_at: now() });
  if (mapped === 'callback') await requestCallback(db, j, 'agent', summary ? `On the AI call: "${String(summary).slice(0, 200)}"` : 'Asked to talk to someone on the AI call.');
  if (mapped === 'opted_out') await stopChannel(db, j, 'call', 'agent', `Asked the AI to stop calls (${j.id})`);
}

/** Delivery reports for SMS and WhatsApp. Failures are refunded once. */
export async function applyMessageStatus(db, job, status) {
  const order = { sent: 1, delivered: 2, read: 3 };
  const j = await fresh(db, job.id);
  if (!j) return;
  if (status === 'failed') {
    if (j.status !== 'failed') {
      await patchJob(db, j.id, { status: 'failed', ended_at: now() });
      await refundJob(db, j, 'Provider reported it was not delivered');
    }
    return;
  }
  if (order[status] && order[status] > (order[j.status] || 0)) await patchJob(db, j.id, { status, ended_at: now() });
}

const norm = (s) => String(s || '').trim().toLowerCase();
const STOP_WORDS = new Set(['stop', 'unsubscribe', 'stop messages', 'रोकें', 'बंद', 'बंद करें']);

/**
 * A member's WhatsApp reply: a quick-reply button or STOP.
 *
 * `to` is the business number they replied to. A person can belong to two
 * gyms; when each gym has its own sender, the reply belongs to the gym whose
 * number it was sent to, never to whichever gym happened to message last.
 * Without `to` (or on the platform's shared sender) the latest message to
 * that member is the one they are answering.
 */
export async function applyWhatsAppReply(db, { from, to = null, text }) {
  const phone = normalizePhone(from);
  if (!phone) return { matched: false };
  const sender = to ? (normalizePhone(to) || String(to).replace(/[^\d+]/g, '')) : null;
  const latest = (extra, params) => db.q1(`SELECT * FROM followup_jobs WHERE to_number = ? AND channel = 'whatsapp' AND is_test = 0${extra} ORDER BY created_at DESC LIMIT 1`, [phone, ...params]);
  const j = (sender ? await latest(' AND from_number = ?', [sender]) : null) || await latest('', []);
  if (!j) return { matched: false };
  const t = norm(text);
  let outcome = STOP_WORDS.has(t) ? 'opted_out' : null;
  for (const code of LANGUAGE_CODES) {
    for (const kind of ['missed_visits', 'membership_ending', 'payment_due', 'onboarding']) {
      const q = quickRepliesFor(code, kind);
      if (t === norm(q.stop)) outcome = 'opted_out';
      else if (!outcome && t === norm(q.callMe)) outcome = 'callback';
      else if (!outcome && t === norm(q.onIt)) outcome = 'on_it';
    }
  }
  if (!outcome) return { matched: false };
  await patchJob(db, j.id, { outcome });
  if (outcome === 'callback') await requestCallback(db, j, 'whatsapp', 'Tapped "Call me" on a follow-up WhatsApp.');
  if (outcome === 'opted_out') await stopChannel(db, j, 'whatsapp', 'whatsapp', `Replied "${String(text).slice(0, 40)}" to ${j.id}`);
  return { matched: true, outcome };
}

/* ---------------- previews and tests ---------------- */

/** Who a campaign would contact today, and who not and why. No side effects. */
export async function previewRule(db, orgId, rawRule, { at = new Date(), limit = 60 } = {}) {
  const rule = parseRule({ id: rawRule.id || 'preview', status: 'active', per_day: 1, gap_hours: 3, ...rawRule, config_json: JSON.stringify(rawRule.config || {}), sequence_json: JSON.stringify(rawRule.sequence || []) });
  const settings = await getSettings(db, orgId);
  const tz = await getOrgTzCached(db, orgId);
  const todayKey = dayKey(at, tz);
  const members = await loadMembers(db, orgId, tz);
  const history = await loadHistory(db, orgId, todayKey);
  const due = [];
  const held = {};
  for (const m of members) {
    if (rule.branch_id && m.branchId !== rule.branch_id) continue;
    const step = dueStep(rule.kind, rule.config, m.facts, todayKey);
    if (!step) continue;
    const d = decide({ rule, member: m, settings, todayKey, history, nowMs: at.getTime(), localMinutes: 12 * 60, inHours: true });
    if (d.skip) { held[d.skip] = (held[d.skip] || 0) + 1; continue; }
    due.push({ client_id: m.id, name: m.name, channel: d.channel, step: step.stepKey, variables: step.variables });
  }
  return { count: due.length, members: due.slice(0, limit), held };
}

/** A sample to the requesting owner's OWN phone -- never anyone else's. */
export async function testContact(db, orgId, { phone, channel, rule, body, agent, language }) {
  const mode = setupStatus().mode;
  if (mode === 'off') throw err('AI Communication is not live on this server yet', 409);
  const to = normalizePhone(phone);
  if (!to) throw err('Add your mobile number to your profile first');
  const settings = await getSettings(db, orgId);
  const tz = await getOrgTzCached(db, orgId);
  const todayKey = dayKey(new Date(), tz);
  const gymInfo = await gymDetails(db, orgId, settings);
  const lang = isLanguage(language) ? language : settings.language;
  const vars = { name: 'Rahul', gym: gymInfo.gym, branch: 'Main', plan: 'Quarterly', trainer: 'Asha', owner: gymInfo.owner || 'Owner', gym_phone: gymInfo.primaryNumber || '+91 98765 43210', app_link: `${appConfig.frontendUrl}/app/client`, days_absent: 7, days_since_joining: 3, end_date: shiftDayKey(todayKey, 3), days_left: 3, amount_due: 1500 };
  const jobId = id('fj');
  const ts = now();
  await db.run(
    `INSERT INTO followup_jobs (id, org_id, rule_id, client_id, channel, is_test, dedupe_key, day_key, attempt, language, status, to_number, unit, variables_json, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, ?, 1, ?, ?, 1, ?, 'dialing', ?, ?, ?, ?, ?)`,
    [jobId, orgId, channel, `test:${jobId}`, todayKey, lang, to, unitFor(channel, rule), JSON.stringify(vars), ts, ts]);
  const ctx = await dispatchContext(db, orgId, mode);
  ctx.testRule = rule || { kind: 'missed_visits', voice_id: null };
  ctx.testContent = channel === 'agent' ? { language: agent?.language || lang, agent } : { language: lang, body, ref: { provider_name: rule?.provider_name, dlt_template_id: rule?.dlt_template_id, sms_type: 'transactional' } };
  await placeJob(db, await fresh(db, jobId), ctx);
  return fresh(db, jobId);
}

/** What a member hears or reads, as text, for the editors' live preview. */
export function previewText({ channel, body, language, kind, settings, gym }) {
  const vars = { name: 'Rahul', gym, branch: 'Main', plan: 'Quarterly', trainer: 'Asha', owner: 'Owner', gym_phone: '+91 98765 43210', app_link: 'https://…/app/client', days_absent: 7, days_since_joining: 3, end_date: new Date().toISOString().slice(0, 10), days_left: 3, amount_due: 1500 };
  if (channel === 'call') return { text: buildVoiceMessage({ script: body, language, kind, overrides: settings.lines, vars }).full };
  const text = buildText(body, language, vars);
  return { text, ...(channel === 'sms' ? smsSegments(text) : {}) };
}

export const _test = { fill };
