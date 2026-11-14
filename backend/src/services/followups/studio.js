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

const agentSnapshot = (a) => ({ name: a.name, language: a.language, voice_id: a.voice_id, greeting: a.greeting, purpose: a.purpose, knowledge: a.knowledge, faqs: a.faqs });

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
  };
  if (!a.name) throw err('Give the agent a name');
  if (a.purpose.length < 10) throw err('Describe what the agent should achieve on the call');
  const ts = now();
  if (input.id) {
    const cur = await db.q1('SELECT * FROM followup_agents WHERE id = ? AND org_id = ?', [input.id, orgId]);
    if (!cur) throw err('Agent not found', 404);
    const version = Number(cur.version) + 1;
    await db.run(`UPDATE followup_agents SET name = ?, language = ?, voice_id = ?, greeting = ?, purpose = ?, knowledge = ?, faqs_json = ?, version = ?, updated_at = ? WHERE id = ?`,
      [a.name, a.language, a.voice_id, a.greeting, a.purpose, a.knowledge, JSON.stringify(a.faqs), version, ts, cur.id]);
    await db.run('INSERT INTO followup_agent_versions (id, org_id, agent_id, version, snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id('fav'), orgId, cur.id, version, JSON.stringify(agentSnapshot(a)), userId, ts]);
    return db.q1('SELECT * FROM followup_agents WHERE id = ?', [cur.id]);
  }
  const aid = id('fag');
  await db.run(`INSERT INTO followup_agents (id, org_id, name, language, voice_id, greeting, purpose, knowledge, faqs_json, version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [aid, orgId, a.name, a.language, a.voice_id, a.greeting, a.purpose, a.knowledge, JSON.stringify(a.faqs), ts, ts]);
  await db.run('INSERT INTO followup_agent_versions (id, org_id, agent_id, version, snapshot_json, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [id('fav'), orgId, aid, JSON.stringify(agentSnapshot(a)), userId, ts]);
  return db.q1('SELECT * FROM followup_agents WHERE id = ?', [aid]);
}

const KIND_CONTEXT = {
  missed_visits: 'The member has not visited for {{days_absent}} days.',
  membership_ending: 'Their membership ends on {{end_date}}.',
  payment_due: 'A payment of {{amount_due}} is pending.',
  onboarding: 'They joined recently and have not come in yet.',
};

/** The system prompt the provider agent runs on. Boundaries are not editable. */
export function agentPrompt(agent, kind) {
  let faqs = [];
  try { faqs = JSON.parse(agent.faqs_json || '[]'); } catch { faqs = []; }
  return [
    'You are a warm, respectful AI phone assistant calling on behalf of {{gym_name}}, a gym, to speak with its member {{member_name}}.',
    kind ? `Context: ${KIND_CONTEXT[kind] || ''}` : '',
    `Your goal on this call: ${agent.purpose}`,
    agent.knowledge ? `Facts about the gym you may share (and ONLY these):\n${agent.knowledge}` : 'You have no gym facts beyond the context above.',
    faqs.length ? `Approved answers:\n${faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n')}` : '',
    '',
    'Rules you must always follow:',
    `- Speak only in ${langName(agent.language)}. Keep replies to one or two short sentences: this is a phone call.`,
    '- You are an AI assistant and must say so if asked. Never claim to be a person.',
    '- State only facts given above. If you do not know, offer a call back from the gym team.',
    '- Never invent or promise discounts, price changes, refunds, free days or anything not written above.',
    '- No medical advice. Never discuss other members. Never ask for card numbers, OTPs or passwords.',
    '- If they ask to stop these calls: apologise, confirm they will not be called again, end the call.',
    '- If they want a person: say someone from the gym will call them back soon, end the call.',
    '- If it is the wrong person: apologise and end the call.',
    '- Never pressure, threaten, shame or argue. Wrap up politely within two minutes.',
  ].filter(Boolean).join('\n');
}

export const agentHash = (agent, kind) => crypto.createHash('sha256').update(JSON.stringify({ p: agentPrompt(agent, kind), g: agent.greeting, l: agent.language, v: agent.voice_id, n: 2 })).digest('hex').slice(0, 24);

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
