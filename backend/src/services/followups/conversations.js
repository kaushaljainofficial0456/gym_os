// ============================================================
// AI CONVERSATIONS (MODE B) -- what the agent may DO during a call, and
// what the owner reads afterwards.
//
// TOOLS. The provider's real-time agent (ElevenLabs Agents, or your own
// server) talks to the member; when the member asks for something that has
// to happen in the real world, the agent calls one of our tools and says
// only what the tool answers:
//
//   schedule_callback  { when_text, date?, time?, reason? }  -> booked | ask this
//   request_person     { reason? }                           -> staff call back recorded
//   stop_calls         { }                                   -> opted out, now
//   wrong_number       { }                                   -> number suppressed, now
//
// Every tool request carries the call's signed job token (so a tool can only
// ever touch THAT call's gym and member) and the platform's tool key header.
// Retries are harmless: each tool is idempotent.
//
// RECORD. One followup_conversations row per AI call: status, outcome,
// intent, renewal interest, questions, objections, call back, escalation,
// owner action, transcript (while the gym keeps transcripts), and a summary
// the SERVER writes from those facts -- one or two lines that say what
// actually happened, never "call completed".
// ============================================================
import { id, now } from '../../ids.js';
import { getOrgTzCached } from '../../utils/time.js';
import { publicBase, readJobToken, toolKey, checkToolKey } from './config.js';
import { resolveWhen } from './when.js';
import { scheduleCallback, callbackLabel } from './callbacks.js';
import { getSettings, callingWindow } from './engine.js';
import { recordConsent } from './consent.js';
import { openCallback } from './studio.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const clip = (s, n) => (s === null || s === undefined ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n) || null);

/* ---------------- tool definitions (provider-neutral) ---------------- */

export { toolKey, checkToolKey };
export const TOOL_NAMES = ['schedule_callback', 'request_person', 'stop_calls', 'wrong_number'];

/**
 * The tools an agent gets, as JSON-schema definitions. `followup_job` is
 * filled by the provider from the call's dynamic variable, never by the model.
 */
export function agentTools(agent) {
  const url = (name) => `${publicBase()}/api/followups/hooks/tools/${name}`;
  const job = { type: 'string', description: 'The call reference. Always the dynamic variable followup_job.', dynamic_variable: 'followup_job' };
  const tools = [];
  if (Number(agent.allow_callbacks ?? 1)) {
    tools.push({
      name: 'schedule_callback', url: url('schedule_callback'),
      description: 'Book a call back when the member asks to be called later. Pass the member\'s own words about when. Only tell the member a call back is booked if this returns status "scheduled", and then say the exact time it returns. If it returns "need_more", ask the question it gives.',
      parameters: {
        type: 'object', required: ['followup_job', 'when_text'],
        properties: {
          followup_job: job,
          when_text: { type: 'string', description: 'What the member said about when, in their words, e.g. "next Monday at 6 in the evening".' },
          date: { type: 'string', description: 'Optional. Your reading of the day as YYYY-MM-DD, if you are sure.' },
          time: { type: 'string', description: 'Optional. Your reading of the time as HH:MM (24-hour), if you are sure.' },
          reason: { type: 'string', description: 'Why they want a call back, in one short phrase (e.g. "busy at work, wants to renew").' },
        },
      },
    });
  }
  tools.push({
    name: 'request_person', url: url('request_person'),
    description: 'Use when the member asks to talk to a person, the owner or staff, or has a question you cannot answer from the facts you were given.',
    parameters: { type: 'object', required: ['followup_job'], properties: { followup_job: job, reason: { type: 'string', description: 'What they want to discuss, in one short phrase.' } } },
  });
  tools.push({
    name: 'stop_calls', url: url('stop_calls'),
    description: 'Use immediately when the member asks not to be called again.',
    parameters: { type: 'object', required: ['followup_job'], properties: { followup_job: job } },
  });
  tools.push({
    name: 'wrong_number', url: url('wrong_number'),
    description: 'Use when the person who answered says they are not the member, or it is the wrong number.',
    parameters: { type: 'object', required: ['followup_job'], properties: { followup_job: job } },
  });
  return tools;
}

/* ---------------- the conversation record ---------------- */

export async function ensureConversation(db, job, extra = {}) {
  const have = await db.q1('SELECT * FROM followup_conversations WHERE job_id = ?', [job.id]);
  if (have) return have;
  const ts = now();
  try {
    await db.run(
      `INSERT INTO followup_conversations (id, org_id, job_id, client_id, rule_id, agent_id, from_callback_id, language, status, provider, provider_ref, simulated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?)`,
      [id('fcv'), job.org_id, job.id, job.client_id || null, job.rule_id || null, extra.agentId || null, job.callback_id || null, job.language || null,
        extra.provider || job.provider || null, extra.providerRef || job.provider_ref || null, extra.simulated ? 1 : 0, ts, ts]);
  } catch (e) { if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e; }
  return db.q1('SELECT * FROM followup_conversations WHERE job_id = ?', [job.id]);
}

async function patchConversation(db, convId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await db.run(`UPDATE followup_conversations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => patch[k]), now(), convId]);
}

async function logTool(db, conv, entry) {
  const list = parse(conv.tools_json, []);
  list.push({ at: now(), ...entry });
  await patchConversation(db, conv.id, { tools_json: JSON.stringify(list.slice(-30)) });
}

/* ---------------- tools ---------------- */

const toolErr = (status, say) => ({ status, say });

/**
 * Run one tool for the call identified by `token`. Returns what the agent
 * should do next ({ status, say | ask | when }). Never throws for a member's
 * request; a broken or foreign token is { status: 'error' }.
 */
export async function handleTool(db, { tool, token, args = {}, at = new Date() }) {
  if (!TOOL_NAMES.includes(tool)) return toolErr('error', 'Unknown tool.');
  const jobId = readJobToken(token);
  const job = jobId ? await db.q1('SELECT * FROM followup_jobs WHERE id = ?', [jobId]) : null;
  if (!job || job.channel !== 'agent') return toolErr('error', 'This call is not recognised.');
  // Real elapsed time, not `at` (the clock dates are resolved against): a
  // tool call hours after its call was placed is refused.
  if (Date.parse(job.created_at) < Date.now() - 6 * 3600_000) return toolErr('error', 'This call has ended.');
  const agent = await agentForJob(db, job);
  const conv = await ensureConversation(db, job, { agentId: agent?.id });
  const out = await runTool(db, { tool, job, conv, agent, args, at });
  await logTool(db, await db.q1('SELECT * FROM followup_conversations WHERE id = ?', [conv.id]), {
    tool, args: Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'followup_job').map(([k, v]) => [k, clip(v, 200)])), result: out.status, ...(out.when ? { when: out.when } : {}),
  });
  return out;
}

async function agentForJob(db, job) {
  const cb = job.callback_id ? await db.q1('SELECT agent_id FROM followup_callbacks WHERE id = ?', [job.callback_id]) : null;
  const rule = job.rule_id ? await db.q1('SELECT agent_id FROM followup_rules WHERE id = ?', [job.rule_id]) : null;
  const agentId = cb?.agent_id || rule?.agent_id;
  return agentId ? db.q1('SELECT * FROM followup_agents WHERE id = ? AND org_id = ?', [agentId, job.org_id]) : null;
}

async function runTool(db, { tool, job, conv, agent, args, at }) {
  if (!job.client_id) {
    // A test call to the owner's own phone: nothing is booked or changed.
    if (tool === 'schedule_callback') {
      const settings = await getSettings(db, job.org_id);
      const tz = await getOrgTzCached(db, job.org_id);
      const r = resolveWhen({ text: args.when_text, date: args.date, time: args.time, now: at, tz, window: callingWindow(settings), daysMask: settings.days_mask });
      return r.ok ? { status: 'scheduled', when: r.label, say: `This is a test call, so nothing was booked. A real member would hear: I will call you ${r.label}.` } : { status: 'need_more', ask: r.ask };
    }
    return { status: 'done', say: 'This is a test call; nothing was changed.' };
  }

  if (tool === 'stop_calls') {
    await recordConsent(db, { orgId: job.org_id, clientId: job.client_id, channels: ['call'], action: 'opted_out', source: 'agent', evidence: `Asked the AI to stop calls during ${job.id}` });
    await cancelOpenCallbacks(db, job, 'The member asked to stop calls');
    await patchConversation(db, conv.id, { outcome: 'opted_out', intent: 'stop' });
    await db.run('UPDATE followup_jobs SET outcome = ?, updated_at = ? WHERE id = ?', ['opted_out', now(), job.id]);
    return { status: 'done', say: 'Apologise, confirm they will not get these calls again, and end the call.' };
  }

  if (tool === 'wrong_number') {
    await db.run('UPDATE followup_jobs SET outcome = ?, updated_at = ? WHERE id = ?', ['wrong_number', now(), job.id]);
    await cancelOpenCallbacks(db, job, 'Wrong number');
    await patchConversation(db, conv.id, { outcome: 'wrong_number', intent: 'wrong_person' });
    return { status: 'done', say: 'Apologise for the trouble and end the call. Do not mention the member or the gym details again.' };
  }

  if (tool === 'request_person') {
    const reason = clip(args.reason, 200);
    if (!Number(agent?.allow_handover ?? 1)) {
      await patchConversation(db, conv.id, { human_escalation: 1, owner_action_required: 1, owner_action: `Asked for a person${reason ? ` about ${reason}` : ''} (hand-over is switched off for this agent)` });
      return { status: 'not_offered', say: 'Say the gym team can be reached on the gym phone number, and offer to help with anything else.' };
    }
    const cbId = await openCallback(db, {
      orgId: job.org_id, clientId: job.client_id, branchId: job.branch_id, phone: job.to_number, ruleId: job.rule_id, jobId: job.id, channel: 'agent',
      reason: `On the AI call: wants a person${reason ? ` about ${reason}` : ''}.`, priority: 'high',
    });
    await db.run(`UPDATE followup_callbacks SET source = COALESCE(source, 'member_request'), conversation_id = COALESCE(conversation_id, ?) WHERE id = ?`, [conv.id, cbId]);
    await patchConversation(db, conv.id, {
      human_escalation: 1, owner_action_required: 1, owner_action: `Call back: asked for a person${reason ? ` about ${reason}` : ''}`,
      ...(reason && !conv.questions ? { questions: reason } : {}),
    });
    return { status: 'recorded', say: 'Tell them someone from the gym will call them back, thank them, and end the call.' };
  }

  // schedule_callback
  if (!Number(agent?.allow_callbacks ?? 1)) return { status: 'not_offered', say: 'Say you cannot book a call back on this call, and offer to note that they want someone from the gym to call.' };
  const prefs = await db.q1('SELECT * FROM followup_member_prefs WHERE client_id = ?', [job.client_id]) || {};
  if (prefs.call_opted_out_at) return { status: 'not_allowed', say: 'They asked not to be called; do not book a call back.' };
  const settings = await getSettings(db, job.org_id);
  const tz = await getOrgTzCached(db, job.org_id);
  const r = resolveWhen({ text: args.when_text, date: args.date, time: args.time, now: at, tz, window: callingWindow(settings), daysMask: settings.days_mask });
  if (!r.ok) {
    await patchConversation(db, conv.id, { callback_requested: 1 });
    return { status: 'need_more', need: r.need, ask: r.ask };
  }
  const reason = clip(args.reason, 200);
  const cb = await scheduleCallback(db, {
    orgId: job.org_id, clientId: job.client_id, phone: job.to_number, branchId: job.branch_id, ruleId: job.rule_id, jobId: job.id, conversationId: conv.id,
    mode: 'agent', at: r.at, local: r.local, timezone: tz, requestedText: clip(args.when_text, 200), reason: reason || 'Asked the AI to call back later',
    context: `On ${new Date(at).toISOString().slice(0, 10)} the member asked to be called back ${r.label}${reason ? ` (${reason})` : ''}.`,
    agentId: agent?.id || null, language: job.language || null, source: 'member_request',
  });
  await patchConversation(db, conv.id, { callback_requested: 1, callback_id: cb.id });
  return { status: 'scheduled', when: r.label, say: `Confirm: you will call them ${r.label}. Then thank them and end the call.` };
}

async function cancelOpenCallbacks(db, job, why) {
  const open = await db.q(`SELECT id, events_json FROM followup_callbacks WHERE org_id = ? AND client_id = ? AND mode != 'human' AND status = 'scheduled'`, [job.org_id, job.client_id]);
  for (const c of open) {
    const ev = parse(c.events_json, []);
    ev.push({ at: now(), event: 'cancelled', by: 'member', note: why });
    await db.run(`UPDATE followup_callbacks SET status = 'cancelled', closed_at = ?, last_error = ?, events_json = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'`, [now(), why, JSON.stringify(ev.slice(-50)), now(), c.id]);
  }
}

/* ---------------- the result, and the summary ---------------- */

const KIND_NOUN = {
  membership_ending: { yes: 'renewing', no: 'renewal' },
  payment_due: { yes: 'paying', no: 'paying now' },
  missed_visits: { yes: 'coming back', no: 'coming back' },
  onboarding: { yes: 'starting', no: 'starting' },
  announcement: { yes: 'the announcement', no: 'the announcement' },
};

const OUTCOME_INTENT = {
  renewing: 'renew', will_pay: 'pay', coming_back: 'return', callback_scheduled: 'callback', person_requested: 'speak_to_person',
  declined: 'decline', question_open: 'ask_question', opted_out: 'stop', wrong_number: 'wrong_person', not_understood: 'unclear', incomplete: 'unclear', other: 'other',
};

/**
 * One or two lines for the owner, from facts only. `c` is the conversation
 * with its final fields; `cbLabel` the booked call back's spoken time.
 */
export function summarize(c, { kind = null, cbLabel = null } = {}) {
  const q = (s) => (s ? `"${clip(s, 140)}"` : '');
  const noun = KIND_NOUN[kind] || { yes: 'going ahead', no: 'going ahead' };
  switch (c.status) {
    case 'no_answer': return 'No answer. Nothing was said.';
    case 'busy': return 'The line was busy. Nothing was said.';
    case 'failed': return c.error ? `The call could not be completed: ${clip(c.error, 120)}` : 'The call could not be completed. Nothing was agreed.';
    default: break;
  }
  const interested = c.renewal_interest === 'yes' || c.renewal_interest === 'maybe';
  switch (c.outcome) {
    case 'callback_scheduled':
      return `${interested ? `Interested in ${noun.yes} but could not talk then` : `Asked to be called back${c.objections ? ` (${clip(c.objections, 80)})` : ''}`}. Call back booked for ${cbLabel || 'the time they chose'}.`;
    case 'renewing':
      return `Agreed to renew${c.objections ? ` (${clip(c.objections, 80)})` : ''}. Follow up to collect the payment or confirm the renewal.`;
    case 'will_pay':
      return 'Said they will pay the pending amount. Check that the payment comes in.';
    case 'coming_back':
      return `Said they will be back${c.provider_summary ? `: ${q(c.provider_summary)}` : ''}. No call back needed.`;
    case 'person_requested':
      return c.unanswered
        ? `Asked ${q(c.questions)}, which the AI could not confirm, so it referred them to the gym team. A staff call back was created.`
        : `Asked to speak to a person${c.questions ? ` about ${clip(c.questions, 100)}` : ''}. A staff call back was created.`;
    case 'declined':
      return `Declined ${noun.no}${c.objections ? `: ${q(c.objections)}` : ''}. No call back requested.`;
    case 'question_open':
      return `Asked ${q(c.questions) || 'a question'} that the AI could not confirm from your information, so it referred them to the gym team. Owner follow-up needed.`;
    case 'opted_out':
      return 'Asked not to be called again. Calls to this member are stopped.';
    case 'wrong_number':
      return 'Wrong number: the person who answered is not the member. This number will not be called again.';
    case 'not_understood':
      return 'The AI could not understand the replies, so nothing was agreed. Consider calling yourself.';
    case 'incomplete':
      return `The call connected but ended after ${Number(c.duration_secs) || 0} seconds, before any answer. Nothing was agreed.`;
    default:
      return c.provider_summary ? `${clip(c.provider_summary, 180)} Nothing specific was agreed.` : 'The conversation ended without a clear outcome. Nothing was agreed.';
  }
}

/** What the owner has to do, if anything. */
function ownerAction(c) {
  switch (c.outcome) {
    case 'renewing': return 'Collect the payment or confirm the renewal';
    case 'will_pay': return 'Check the payment comes in';
    case 'person_requested': return c.owner_action || 'Call the member back';
    case 'question_open': return `Answer their question${c.questions ? `: ${clip(c.questions, 120)}` : ''}`;
    case 'not_understood': return 'Call the member yourself';
    default: return null;
  }
}

const PROVIDER_OUTCOME = {
  renewing: 'renewing', will_pay: 'will_pay', coming_back: 'coming_back', not_interested: 'declined', declined: 'declined',
  callback_requested: 'person_requested', person_requested: 'person_requested', opted_out: 'opted_out', wrong_number: 'wrong_number',
  question_open: 'question_open', not_understood: 'not_understood', no_conversation: 'incomplete', other: 'other',
};

/**
 * Close a conversation from the provider's result (or the simulator's).
 * Facts recorded by tools during the call win over the after-call analysis:
 * a booked call back, a stop or a wrong number is never overwritten by a
 * model's later guess. Idempotent per job.
 */
export async function closeConversation(db, job, result, { kind = null } = {}) {
  const conv = await ensureConversation(db, job, { provider: result.provider, providerRef: result.ref, simulated: result.simulated });
  if (conv.status !== 'in_progress') return conv;
  const settings = await getSettings(db, job.org_id);
  const duration = Math.max(0, Math.round(Number(result.duration) || 0));
  const connected = result.status === 'completed' && duration > 0;
  let outcome = conv.outcome && ['opted_out', 'wrong_number'].includes(conv.outcome) ? conv.outcome : null;
  if (!outcome && conv.callback_id) {
    const cb = await db.q1('SELECT status FROM followup_callbacks WHERE id = ?', [conv.callback_id]);
    if (cb && cb.status !== 'cancelled') outcome = 'callback_scheduled';
  }
  if (!outcome && Number(conv.human_escalation)) outcome = 'person_requested';
  if (!outcome && connected) {
    // "Could not understand" is a fact about the call, whatever label came with it.
    if (result.understood === false) outcome = 'not_understood';
    if (!outcome) outcome = PROVIDER_OUTCOME[String(result.outcome || '').toLowerCase()] || null;
    if (!outcome && result.unanswered_question) outcome = 'question_open';
    if (!outcome) outcome = duration < 15 ? 'incomplete' : 'other';
  }
  const status = !connected ? (['no_answer', 'busy'].includes(result.status) ? result.status : 'failed')
    : (['incomplete', 'not_understood'].includes(outcome) ? 'incomplete' : 'completed');
  const renewal = ['yes', 'maybe', 'no', 'unknown'].includes(String(result.renewal_interest || '').toLowerCase()) ? String(result.renewal_interest).toLowerCase()
    : outcome === 'renewing' || outcome === 'will_pay' || outcome === 'coming_back' ? 'yes' : outcome === 'declined' ? 'no' : null;
  const facts = {
    status, outcome: connected ? outcome : null, intent: connected ? OUTCOME_INTENT[outcome] || 'other' : null, renewal_interest: connected ? renewal : null,
    questions: clip(result.unanswered_question || result.questions || conv.questions, 300), objections: clip(result.objection || (outcome === 'declined' ? result.summary : null), 300),
    provider_summary: clip(result.summary, 500), duration_secs: duration || null, error: result.error || null,
  };
  if (outcome === 'person_requested' && !Number(conv.human_escalation) && job.client_id) {
    // The model reported it, but no tool recorded it during the call: make sure a person calls.
    const cbId = await openCallback(db, { orgId: job.org_id, clientId: job.client_id, branchId: job.branch_id, phone: job.to_number, ruleId: job.rule_id, jobId: job.id, channel: 'agent', reason: `On the AI call: "${clip(result.summary, 200) || 'asked to talk to someone'}"`, priority: 'high' });
    await db.run(`UPDATE followup_callbacks SET source = COALESCE(source, 'member_request'), conversation_id = COALESCE(conversation_id, ?) WHERE id = ?`, [conv.id, cbId]);
  }
  const cb = conv.callback_id ? await db.q1('SELECT * FROM followup_callbacks WHERE id = ?', [conv.callback_id]) : null;
  const merged = { ...conv, ...facts, owner_action: conv.owner_action };
  const action = connected ? ownerAction(merged) : null;
  const keep = Number(settings.keep_transcripts ?? 1) && Array.isArray(result.transcript) && result.transcript.length;
  const days = Math.min(365, Math.max(7, Number(settings.transcript_days) || 90));
  await patchConversation(db, conv.id, {
    ...Object.fromEntries(Object.entries(facts).filter(([k]) => k !== 'error')),
    human_escalation: Number(conv.human_escalation) || (outcome === 'person_requested' ? 1 : 0),
    owner_action_required: action ? 1 : 0, owner_action: action,
    summary: summarize({ ...merged, status, unanswered: !!result.unanswered_question }, { kind, cbLabel: cb ? callbackLabel(cb) : null }),
    transcript_json: keep ? JSON.stringify(result.transcript.slice(0, 200).map((t) => ({ role: t.role === 'agent' ? 'agent' : 'member', text: clip(t.text, 600) || '', ...(Number.isFinite(t.secs) ? { secs: t.secs } : {}) }))) : null,
    transcript_expires_at: keep ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    cost_json: result.cost ? JSON.stringify(result.cost).slice(0, 2000) : null,
    provider: result.provider || conv.provider, provider_ref: result.ref || conv.provider_ref, simulated: result.simulated ? 1 : Number(conv.simulated) || 0,
    ended_at: now(),
  });
  return db.q1('SELECT * FROM followup_conversations WHERE id = ?', [conv.id]);
}

/** Transcripts past their retention date are deleted; the summary stays. */
export async function pruneTranscripts(db, orgId = null, at = new Date()) {
  const r = await db.run(`UPDATE followup_conversations SET transcript_json = NULL, updated_at = ? WHERE transcript_json IS NOT NULL AND transcript_expires_at < ?${orgId ? ' AND org_id = ?' : ''}`,
    [now(), at.toISOString(), ...(orgId ? [orgId] : [])]);
  return r.changes;
}

/** The provider's data-collection fields, asked for after every AI call. */
export const DATA_COLLECTION = {
  outcome: 'How the call ended for the gym. Exactly one of: renewing, will_pay, coming_back, not_interested, callback_requested, opted_out, wrong_number, question_open, not_understood, no_conversation, other.',
  reason: 'In one short sentence, what the member said about their situation or main objection. Empty if nothing.',
  renewal_interest: 'Did the member want to continue (renew, come back, pay)? Exactly one of: yes, maybe, no, unknown.',
  unanswered_question: 'A question the member asked that you could not answer from the facts given. Empty if none.',
  objection: 'The member\'s main objection or reason for saying no, in a few words. Empty if none.',
  understood: 'true if you could understand the member\'s replies, false if the conversation failed because you could not.',
};
