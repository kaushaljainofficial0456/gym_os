// ============================================================
// SCRIPT STUDIO, AGENTS AND CALLBACKS -- the owner's reusable content.
//
// Scripts: one row per language variant; variants of the same message share
// group_id. Every edit is a new version (followup_script_versions), and a
// variant must be APPROVED by the owner before a campaign uses it -- an AI
// translation is never spoken unseen.
//
// Agents: the separate, premium two-way product. The agent may state ONLY
// what the owner wrote in its knowledge and FAQs; every save is a version.
//
// Callbacks: a member asked for a person. Automated contact pauses for them
// until the callback is closed.
// ============================================================
import crypto from 'node:crypto';
import { id, now } from '../../ids.js';
import { writeText } from '../intelligence/aiProvider.js';
import { normalizePlaceholders, unknownPlaceholders, PLACEHOLDERS } from './render.js';
import { isLanguage, languageList, starterFor } from './languages.js';
import { toolKey } from './config.js';

const err = (msg, status = 422) => Object.assign(new Error(msg), { status });
const langName = (code) => languageList().find((l) => l.code === code)?.name || code;

/* ---------------- scripts ---------------- */

function cleanBody(body, channelType) {
  const text = normalizePlaceholders(String(body || '').trim());
  if (text.length < 5) throw err('Write the message first');
  const max = channelType === 'text' ? 600 : 900;
  if (text.length > max) throw err(`Keep it under ${max} characters`);
  const unknown = unknownPlaceholders(text);
  if (unknown.length) throw err(`Unknown detail${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{${u}}`).join(', ')}. Use: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`);
  return text;
}

export async function listScripts(db, orgId) {
  const rows = await db.q('SELECT * FROM followup_scripts WHERE org_id = ? ORDER BY name, language', [orgId]);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.group_id)) groups.set(r.group_id, { group_id: r.group_id, name: r.name, purpose: r.purpose, channel_type: r.channel_type, variants: [] });
    groups.get(r.group_id).variants.push(r);
  }
  return [...groups.values()];
}

/** Create a message (its first language variant), or add a variant to a group. */
export async function saveScript(db, orgId, userId, { groupId = null, name, purpose = 'general', channelType = 'voice', language = 'en', body, approve = true }) {
  if (!isLanguage(language)) throw err('That language is not supported');
  const text = cleanBody(body, channelType);
  const ts = now();
  const gid = groupId || id('fsg');
  if (groupId) {
    const g = await db.q1('SELECT name, purpose, channel_type FROM followup_scripts WHERE group_id = ? AND org_id = ? LIMIT 1', [groupId, orgId]);
    if (!g) throw err('Message not found', 404);
    name = g.name; purpose = g.purpose; channelType = g.channel_type;
  }
  const existing = await db.q1('SELECT * FROM followup_scripts WHERE group_id = ? AND language = ? AND org_id = ?', [gid, language, orgId]);
  if (existing) {
    if (existing.body === text) return existing;
    const version = Number(existing.version) + 1;
    await db.run(`UPDATE followup_scripts SET body = ?, version = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?`,
      [text, version, approve ? ts : null, approve ? userId : null, ts, existing.id]);
    await db.run('INSERT INTO followup_script_versions (id, org_id, script_id, version, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id('fsv'), orgId, existing.id, version, text, userId, ts]);
    return db.q1('SELECT * FROM followup_scripts WHERE id = ?', [existing.id]);
  }
  const sid = id('fs');
  await db.run(
    `INSERT INTO followup_scripts (id, org_id, group_id, name, purpose, channel_type, language, body, version, approved_at, approved_by, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [sid, orgId, gid, String(name || 'Message').slice(0, 80), purpose, channelType, language, text, approve ? ts : null, approve ? userId : null, userId, ts, ts]);
  await db.run('INSERT INTO followup_script_versions (id, org_id, script_id, version, body, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [id('fsv'), orgId, sid, text, userId, ts]);
  return db.q1('SELECT * FROM followup_scripts WHERE id = ?', [sid]);
}

export async function approveScript(db, orgId, userId, scriptId) {
  const r = await db.run('UPDATE followup_scripts SET approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ? AND org_id = ?', [now(), userId, now(), scriptId, orgId]);
  if (!r.changes) throw err('Message not found', 404);
}

export async function scriptVersions(db, orgId, scriptId) {
  return db.q('SELECT version, body, created_by, created_at FROM followup_script_versions WHERE script_id = ? AND org_id = ? ORDER BY version DESC', [scriptId, orgId]);
}

/**
 * The variant a member gets: their own language if the group has an
 * APPROVED variant in it, else the campaign's fallback language, else none
 * (the engine then holds the member for review rather than send a wrong one).
 */
export function pickVariant(variants, { memberLanguage, fallback }) {
  const ok = (variants || []).filter((v) => v.approved_at);
  return ok.find((v) => v.language === memberLanguage) || ok.find((v) => v.language === fallback) || null;
}

const STUDIO_SYSTEM = [
  'You write short messages a gym sends its own members by phone call, SMS or WhatsApp.',
  'Warm, respectful, specific; never pushy, never guilt-tripping, no medical claims, no discounts or offers unless the owner wrote them.',
  `Use these placeholders exactly as written where the detail belongs: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}.`,
  'Do not add a greeting from "the AI", do not say you are a person, and do not add opt-out text: the system adds those itself.',
  'Return ONLY the message text, nothing else.',
].join(' ');

/** "Write it for me": a draft in `language` for a purpose. */
export async function draftScript({ purpose, channelType, language, notes }) {
  const brief = `Write a ${channelType === 'text' ? 'text message (under 300 characters)' : 'voice message to be read aloud (2-4 sentences, about 20 seconds)'} in ${langName(language)} for this purpose: ${purpose}.${notes ? ` The owner adds: ${String(notes).slice(0, 400)}` : ''}`;
  const out = await writeText(STUDIO_SYSTEM, brief);
  if (!out) return { text: starterFor(language, purpose), ai: false };
  return { text: normalizePlaceholders(out.replace(/^["'“]|["'”]$/g, '').trim()), ai: true };
}

/** Translate a variant; placeholders are kept untouched. Needs approval before use. */
export async function translateScript({ body, from, to }) {
  const out = await writeText(`${STUDIO_SYSTEM} You are translating: keep the meaning, tone and every {placeholder} exactly; translate naturally for a member in India, not word for word.`,
    `Translate from ${langName(from)} to ${langName(to)}:\n\n${body}`);
  if (!out) throw err('AI translation is not set up on this server. Write this language yourself.', 503);
  const text = normalizePlaceholders(out.replace(/^["'“]|["'”]$/g, '').trim());
  const lost = [...String(body).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !text.includes(`{${k}}`));
  if (lost.length) throw err(`The translation dropped ${lost.map((k) => `{${k}}`).join(', ')}. Try again or write it yourself.`, 502);
  return text;
}

/* ---------------- agents ---------------- */

const agentSnapshot = (a) => ({
  name: a.name, language: a.language, voice_id: a.voice_id, greeting: a.greeting, purpose: a.purpose, knowledge: a.knowledge, faqs: a.faqs,
  tone: a.tone, max_minutes: a.max_minutes, allow_callbacks: a.allow_callbacks, allow_handover: a.allow_handover, answer_plans: a.answer_plans,
});
export const TONES = ['warm', 'professional', 'energetic'];
const flag = (v, dflt = 1) => (v === undefined || v === null ? dflt : (v ? 1 : 0));

export async function saveAgent(db, orgId, userId, input) {
  const a = {
    name: String(input.name || '').trim().slice(0, 60),
    language: isLanguage(input.language) ? input.language : 'en',
    voice_id: input.voice_id || null,
    greeting: String(input.greeting || '').trim().slice(0, 300) || null,
    purpose: String(input.purpose || '').trim().slice(0, 600),
    knowledge: String(input.knowledge || '').trim().slice(0, 4000),
    faqs: (Array.isArray(input.faqs) ? input.faqs : []).slice(0, 30)
      .map((f) => ({ q: String(f?.q || '').trim().slice(0, 200), a: String(f?.a || '').trim().slice(0, 500) })).filter((f) => f.q && f.a),
    tone: TONES.includes(input.tone) ? input.tone : 'warm',
    max_minutes: Math.min(5, Math.max(1, Math.round(Number(input.max_minutes) || 3))),
    allow_callbacks: flag(input.allow_callbacks),
    allow_handover: flag(input.allow_handover),
    answer_plans: flag(input.answer_plans),
  };
  if (!a.name) throw err('Give the agent a name');
  if (a.purpose.length < 10) throw err('Describe what the agent should achieve on the call');
  // The member must hear at once that this is an AI. Every default opening
  // line says so; an owner's own line has to as well.
  if (a.greeting && !/\bAI\b/i.test(a.greeting)) throw err('The opening line must say that this is an AI assistant (for example "I\'m an AI assistant calling from {gym}").');
  const ts = now();
  const cols = ['name', 'language', 'voice_id', 'greeting', 'purpose', 'knowledge', 'tone', 'max_minutes', 'allow_callbacks', 'allow_handover', 'answer_plans'];
  if (input.id) {
    const cur = await db.q1('SELECT * FROM followup_agents WHERE id = ? AND org_id = ?', [input.id, orgId]);
    if (!cur) throw err('Agent not found', 404);
    const version = Number(cur.version) + 1;
    await db.run(`UPDATE followup_agents SET ${cols.map((c) => `${c} = ?`).join(', ')}, faqs_json = ?, version = ?, updated_at = ? WHERE id = ?`,
      [...cols.map((c) => a[c]), JSON.stringify(a.faqs), version, ts, cur.id]);
    await db.run('INSERT INTO followup_agent_versions (id, org_id, agent_id, version, snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id('fav'), orgId, cur.id, version, JSON.stringify(agentSnapshot(a)), userId, ts]);
    return db.q1('SELECT * FROM followup_agents WHERE id = ?', [cur.id]);
  }
  const aid = id('fag');
  await db.run(`INSERT INTO followup_agents (id, org_id, ${cols.join(', ')}, faqs_json, version, created_at, updated_at)
                VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, 1, ?, ?)`,
    [aid, orgId, ...cols.map((c) => a[c]), JSON.stringify(a.faqs), ts, ts]);
  await db.run('INSERT INTO followup_agent_versions (id, org_id, agent_id, version, snapshot_json, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [id('fav'), orgId, aid, JSON.stringify(agentSnapshot(a)), userId, ts]);
  return db.q1('SELECT * FROM followup_agents WHERE id = ?', [aid]);
}

const KIND_CONTEXT = {
  missed_visits: 'The member has not visited for {{days_absent}} days.',
  membership_ending: 'Their membership ends on {{end_date}}.',
  payment_due: 'A payment of {{amount_due}} is pending.',
  onboarding: 'They joined recently and have not come in yet.',
  announcement: 'The gym has an announcement for its members (your goal below says what it is).',
};
const TONE_LINE = {
  warm: 'Be warm, friendly and unhurried.',
  professional: 'Be polite, clear and businesslike.',
  energetic: 'Be upbeat and encouraging, without being pushy.',
};

const planLine = (p) => `- ${p.name}: ₹${Math.round(p.amount)}${p.period_days ? ` for ${p.period_days} days` : ''}${p.features ? ` (${String(p.features).slice(0, 120)})` : ''}`;

/**
 * The system prompt the provider agent runs on. The call flow and the
 * boundaries are fixed; the owner supplies the goal, tone, facts and FAQs.
 * `extra.plans` are the gym's own plans (packages) when the agent may quote them.
 */
export function agentPrompt(agent, kind, extra = {}) {
  let faqs = [];
  try { faqs = JSON.parse(agent.faqs_json || '[]'); } catch { faqs = []; }
  const plans = Array.isArray(extra.plans) ? extra.plans : [];
  const callbacksOn = Number(agent.allow_callbacks ?? 1);
  const minutes = Math.min(5, Math.max(1, Math.round(Number(agent.max_minutes) || 3)));
  return [
    `You are an AI phone assistant calling on behalf of {{gym_name}}, a gym, to speak with its member {{member_name}}. ${TONE_LINE[agent.tone] || TONE_LINE.warm}`,
    'Today is {{today}} and it is {{time_now}} at the gym.',
    kind ? `Context: ${KIND_CONTEXT[kind] || ''}` : '',
    'If {{callback_context}} is not empty, this call is a call back the member asked for: say so first. Context: {{callback_context}}',
    `Your goal on this call: ${agent.purpose}`,
    agent.knowledge ? `Facts about the gym you may share (and ONLY these):\n${agent.knowledge}` : 'You have no gym facts beyond the context above.',
    plans.length ? `The gym's current membership plans (quote ONLY these, exactly):\n${plans.slice(0, 12).map(planLine).join('\n')}` : 'You do not know the gym\'s plan prices: do not quote any.',
    faqs.length ? `Approved answers:\n${faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n')}` : '',
    '',
    'How the call goes:',
    '1. Your first sentence says you are an AI assistant calling from {{gym_name}}.',
    '2. Check you are speaking to {{member_name}} before mentioning anything about their membership. If not, use wrong_number, apologise and end the call.',
    '3. Say why you are calling, in one sentence. Then listen.',
    '4. Answer questions only from the facts, plans and approved answers above. If the answer is not there, say the gym team can tell them, and offer to have someone call (request_person).',
    callbacksOn
      ? '5. If they are busy or want to talk later, ask when suits them and call schedule_callback with their own words. If it asks a question, ask the member exactly that. Only after it returns "scheduled", confirm the exact time it gives you. Never say a call back is booked otherwise.'
      : '5. If they are busy, thank them and say the gym will be in touch. You cannot book call backs on this call.',
    '6. When the purpose is settled, or they want to stop, thank them and end the call. Do not repeat questions they already answered.',
    '',
    'Rules you must always follow:',
    `- Speak only in ${langName(agent.language)}. Keep replies to one or two short sentences: this is a phone call.`,
    '- You are an AI assistant. Never claim or imply that you are a person.',
    '- Never invent or promise discounts, offers, price changes, refunds, free days, opening hours or facilities that are not written above.',
    '- Never say a payment was made or a renewal is done: you cannot see payments.',
    '- No medical advice. Never discuss other members. Never ask for card numbers, OTPs, passwords or anything you do not need.',
    '- If they ask to stop these calls: call stop_calls at once, apologise, confirm, and end the call.',
    '- If they want a person, the owner or staff: call request_person, say someone from the gym will call them back, and end the call.',
    '- If you hear silence or cannot understand twice, say the gym will try another time, and end the call.',
    `- Never pressure, threaten, shame or argue. Finish within ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  ].filter(Boolean).join('\n');
}

// `k` is a fingerprint of the tool key the provider sends back on every tool
// call (derived from the server secret): rotate the secret and every agent is
// re-sent with the new key on its next call, instead of its tools being refused.
export const agentHash = (agent, kind, extra = {}) => crypto.createHash('sha256').update(JSON.stringify({
  p: agentPrompt(agent, kind, extra), g: agent.greeting, l: agent.language, v: agent.voice_id, m: agent.max_minutes, c: agent.allow_callbacks, h: agent.allow_handover, n: 3,
  k: crypto.createHash('sha256').update(toolKey()).digest('hex').slice(0, 8),
})).digest('hex').slice(0, 24);

/* ---------------- callbacks ---------------- */

export async function openCallback(db, { orgId, clientId, branchId = null, phone, ruleId = null, jobId = null, channel, reason, requestedTime = null, priority = 'normal' }) {
  const existing = await db.q1(`SELECT id FROM followup_callbacks WHERE client_id = ? AND status IN ('new','assigned','in_progress')`, [clientId]);
  if (existing) return existing.id;
  const c = await db.q1('SELECT trainer_id FROM clients WHERE id = ?', [clientId]);
  const cid = id('fcb');
  const ts = now();
  await db.run(
    `INSERT INTO followup_callbacks (id, org_id, branch_id, client_id, phone, rule_id, job_id, channel, reason, requested_time, assigned_to, priority, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cid, orgId, branchId, clientId, phone, ruleId, jobId, channel, String(reason || '').slice(0, 500), requestedTime, c?.trainer_id || null, priority, c?.trainer_id ? 'assigned' : 'new', ts, ts]);
  return cid;
}

export const CALLBACK_STATUSES = ['new', 'assigned', 'in_progress', 'completed', 'unreachable', 'cancelled'];

export async function updateCallback(db, orgId, callbackId, patch, { trainerId = null } = {}) {
  const cb = await db.q1('SELECT * FROM followup_callbacks WHERE id = ? AND org_id = ?', [callbackId, orgId]);
  if (!cb) throw err('Callback not found', 404);
  if (trainerId && cb.assigned_to !== trainerId) throw err('This callback is not assigned to you', 403);
  const sets = [];
  const vals = [];
  if (patch.status && CALLBACK_STATUSES.includes(patch.status)) {
    sets.push('status = ?'); vals.push(patch.status);
    if (['completed', 'unreachable', 'cancelled'].includes(patch.status)) { sets.push('closed_at = ?'); vals.push(now()); }
  }
  if (patch.note !== undefined) { sets.push('note = ?'); vals.push(String(patch.note || '').slice(0, 1000)); }
  if (!trainerId && patch.assigned_to !== undefined) {
    sets.push('assigned_to = ?'); vals.push(patch.assigned_to || null);
    if (patch.assigned_to && cb.status === 'new' && !patch.status) { sets.push('status = ?'); vals.push('assigned'); }
  }
  if (!sets.length) return cb;
  await db.run(`UPDATE followup_callbacks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now(), callbackId]);
  return db.q1('SELECT * FROM followup_callbacks WHERE id = ?', [callbackId]);
}
