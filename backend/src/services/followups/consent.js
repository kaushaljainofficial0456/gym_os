// ============================================================
// CONSENT & SUPPRESSION -- may this member be contacted, on this channel,
// right now? Evaluated before EVERY call, AI conversation, SMS and
// WhatsApp message -- when it is planned and again when it is sent.
//
//   ALLOW           go ahead
//   DENY            not on this channel (no permission, stopped, wrong number...)
//   DEFER           not now (outside hours, caps reached, paused) -- try later
//   REQUIRE_REVIEW  a person must look (no message in a language they read,
//                   a detail the message needs is missing)
//
// Every decision carries a reason, which is what the owner sees.
//
// Suppression is per GYM, not per number: a member who stops calls is never
// called again from ANY of the gym's numbers, by any campaign. Only the
// member can undo their own opt-out. Renewing a membership does not
// re-grant anything. An AI conversation is a call: both obey call permission.
// ============================================================
import { id, now } from '../../ids.js';

export const CHANNELS = ['call', 'agent', 'sms', 'whatsapp'];
export const CONSENT_POLICY_VERSION = '2026-11';

/** Which permission a channel needs: an AI conversation is a phone call. */
export const consentKey = (channel) => (channel === 'agent' ? 'call' : channel === 'whatsapp' ? 'wa' : channel);

export const REASONS = {
  no_phone: 'No valid mobile number',
  no_permission: 'Has not given permission for this channel',
  refused: 'Said no to this channel',
  opted_out: 'Asked to stop on this channel',
  human_only: 'Wants a person, not automated contact',
  paused: 'Paused by the gym',
  wrong_number: 'Number belongs to someone else',
  callback_pending: 'Waiting for the gym to call back',
  outside_hours: "Outside the gym's calling hours",
  outside_member_window: "Outside the member's preferred time",
  daily_cap: 'Reached today’s limit',
  weekly_cap: 'Reached this week’s limit',
  no_language: 'No message in a language this member has chosen',
  missing_details: 'The message needs a detail this member does not have',
};

const hhmm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * The decision for one member and channel.
 *
 * ctx: { prefs, phone, channel, todayKey, localMinutes, inGymHours,
 *        callsToday, contactsToday, contactsThisWeek, caps: { perDay, perWeek },
 *        wrongNumber, callbackPending }
 */
export function evaluate(ctx) {
  const p = ctx.prefs || {};
  const k = consentKey(ctx.channel);
  if (!ctx.phone) return { decision: 'DENY', reason: 'no_phone' };
  if (p[`${k}_opted_out_at`]) return { decision: 'DENY', reason: 'opted_out' };
  if (p[`${k}_consent`] === 'refused') return { decision: 'DENY', reason: 'refused' };
  if (p[`${k}_consent`] !== 'granted') return { decision: 'DENY', reason: 'no_permission' };
  if (Number(p.human_only)) return { decision: 'DENY', reason: 'human_only' };
  if (ctx.wrongNumber) return { decision: 'DENY', reason: 'wrong_number' };
  if (ctx.callbackPending) return { decision: 'DEFER', reason: 'callback_pending' };
  if (p.paused_until && p.paused_until >= ctx.todayKey) return { decision: 'DEFER', reason: 'paused' };
  if (ctx.inGymHours === false) return { decision: 'DEFER', reason: 'outside_hours' };
  const ws = hhmm(p.window_start);
  const we = hhmm(p.window_end);
  if (ws !== null && we !== null && we > ws && Number.isFinite(ctx.localMinutes) && (ctx.localMinutes < ws || ctx.localMinutes >= we)) {
    return { decision: 'DEFER', reason: 'outside_member_window' };
  }
  const isCall = ctx.channel === 'call' || ctx.channel === 'agent';
  if (isCall && ctx.caps && ctx.callsToday >= ctx.caps.perCall) return { decision: 'DEFER', reason: 'daily_cap' };
  if (!isCall && ctx.caps && ctx.messagesToday >= 1) return { decision: 'DEFER', reason: 'daily_cap' };
  if (ctx.caps && ctx.contactsThisWeek >= ctx.caps.perWeek) return { decision: 'DEFER', reason: 'weekly_cap' };
  return { decision: 'ALLOW', reason: null };
}

/** Summary of who can be reached on which channel, for the owner. */
export function reachableOn(prefs, phone) {
  const out = {};
  for (const ch of ['call', 'sms', 'whatsapp']) {
    out[ch] = evaluate({ prefs, phone, channel: ch, todayKey: '0000-00-00' }).decision === 'ALLOW';
  }
  return out;
}

async function ensurePrefs(db, orgId, clientId) {
  const row = await db.q1('SELECT * FROM followup_member_prefs WHERE client_id = ?', [clientId]);
  if (row) return row;
  try {
    await db.run('INSERT INTO followup_member_prefs (client_id, org_id, updated_at) VALUES (?, ?, ?)', [clientId, orgId, now()]);
  } catch (e) { if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e; }
  return db.q1('SELECT * FROM followup_member_prefs WHERE client_id = ?', [clientId]);
}

const COLS = { call: ['call_consent', 'call_opted_out_at'], sms: ['sms_consent', 'sms_opted_out_at'], whatsapp: ['wa_consent', 'wa_opted_out_at'] };

/**
 * Record a permission change for one member, with its evidence.
 *
 *   action: granted | refused | opted_out | opted_in | withdrawn
 *   source: member | owner | keypad | sms | whatsapp | agent
 *
 * The OWNER may record that a member granted permission (with evidence),
 * but can never undo a member's own opt-out -- only the member can.
 */
export async function recordConsent(db, { orgId, clientId, channels, action, source, evidence = null, purpose = null, actorId = null }) {
  const prefs = await ensurePrefs(db, orgId, clientId);
  const ts = now();
  const changed = [];
  for (const ch of channels) {
    const [c, o] = COLS[ch] || [];
    if (!c) continue;
    if (action === 'granted') {
      if (prefs[o] && source !== 'member') continue;         // a member's stop outranks the owner
      await db.run(`UPDATE followup_member_prefs SET ${c} = 'granted', ${o} = ${source === 'member' ? 'NULL' : o}, updated_at = ? WHERE client_id = ?`, [ts, clientId]);
    } else if (action === 'opted_in') {
      if (source !== 'member') continue;
      await db.run(`UPDATE followup_member_prefs SET ${c} = 'granted', ${o} = NULL, updated_at = ? WHERE client_id = ?`, [ts, clientId]);
    } else if (action === 'refused' || action === 'withdrawn') {
      await db.run(`UPDATE followup_member_prefs SET ${c} = 'refused', updated_at = ? WHERE client_id = ?`, [ts, clientId]);
    } else if (action === 'opted_out') {
      await db.run(`UPDATE followup_member_prefs SET ${o} = COALESCE(${o}, ?), updated_at = ? WHERE client_id = ?`, [ts, ts, clientId]);
    } else continue;
    await db.run(
      `INSERT INTO followup_consent_log (id, org_id, client_id, channel, action, source, purpose, evidence, policy_version, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('fcl'), orgId, clientId, ch, action, source, purpose, evidence, CONSENT_POLICY_VERSION, actorId, ts]);
    changed.push(ch);
  }
  // An opt-out cancels everything still queued for this member on that channel.
  if ((action === 'opted_out' || action === 'refused' || action === 'withdrawn') && changed.length) {
    const jobChannels = changed.flatMap((ch) => (ch === 'call' ? ['call', 'agent'] : [ch]));
    await db.run(
      `UPDATE followup_jobs SET status = 'skipped', error = 'Member stopped this channel', ended_at = ?, updated_at = ?
        WHERE client_id = ? AND status = 'queued' AND channel IN (${jobChannels.map(() => '?').join(',')})`,
      [ts, ts, clientId, ...jobChannels]);
  }
  return changed;
}

/** Member-set preferences that are not permissions. */
export async function updatePreferences(db, { orgId, clientId, patch }) {
  await ensurePrefs(db, orgId, clientId);
  const allowed = ['human_only', 'language', 'window_start', 'window_end', 'paused_until', 'max_per_day'];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  await db.run(`UPDATE followup_member_prefs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE client_id = ?`,
    [...keys.map((k) => patch[k]), now(), clientId]);
}

export const getPrefs = (db, orgId, clientId) => ensurePrefs(db, orgId, clientId);
