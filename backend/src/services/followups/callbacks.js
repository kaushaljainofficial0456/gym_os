// ============================================================
// SCHEDULED CALL BACKS -- "call me next Monday at 6" actually happens.
//
// A call back is a followup_callbacks row. Mode 'human' is the staff queue
// (studio.js openCallback / updateCallback). Modes 'agent' (the AI calls
// back) and 'call' (the recording / voice message is played) are run by the
// scheduler here, on the SAME tick and job queue as campaigns:
//
//   scheduled --(due, in calling hours, claimed)--> processing
//     processing --> a followup_jobs row, dedupe_key 'cb:<id>:<attempt>'
//       job connected               --> completed
//       no answer / busy / failed   --> scheduled again (retry) or failed
//       member no longer reachable  --> cancelled (with the reason)
//   scheduled, not placed within 2 hours of the asked time --> expired
//
// Exactly-once: the claim is a conditional UPDATE (status='scheduled' ->
// 'processing'), and the job's dedupe_key is UNIQUE -- two workers can never
// both place the same attempt. A restart loses nothing: everything is rows.
// Every change is appended to events_json (who, when, what).
// ============================================================
import { id, now } from '../../ids.js';
import { dayKey, getOrgTzCached } from '../../utils/time.js';
import { resolveWhen, localToUtc, whenLabel } from './when.js';
import { getSettings, callingWindow, inCallingHours, localClock, unitFor } from './engine.js';
import { normalizePhone } from './render.js';

const err = (msg, status = 422) => Object.assign(new Error(msg), { status });
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const LATE_LIMIT_MS = 2 * 3600_000;          // later than this after the asked time = expired
export const RETRY_GAP_MIN = 60;
export const AUTO_MODES = ['agent', 'call'];
export const MODES = ['human', 'agent', 'call'];

function appendEvent(eventsJson, event, { by = null, note = null } = {}) {
  const list = parse(eventsJson, []);
  list.push({ at: now(), event, ...(by ? { by } : {}), ...(note ? { note: String(note).slice(0, 300) } : {}) });
  return JSON.stringify(list.slice(-50));
}

/** Set fields on a call back and record why, in one statement. `onlyIf` guards the current status. */
async function move(db, cb, patch, event, { by = null, note = null, onlyIf = null } = {}) {
  const fields = { ...patch, events_json: appendEvent(cb.events_json, event, { by, note }), updated_at: now() };
  const keys = Object.keys(fields);
  const guard = onlyIf ? ` AND status IN (${onlyIf.map(() => '?').join(',')})` : '';
  const r = await db.run(`UPDATE followup_callbacks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?${guard}`, [...keys.map((k) => fields[k]), cb.id, ...(onlyIf || [])]);
  return r.changes === 1;
}

export const getCallback = (db, orgId, cbId) => db.q1('SELECT * FROM followup_callbacks WHERE id = ? AND org_id = ?', [cbId, orgId]);

/**
 * Book an automated call back. One booked call back per member: a newer
 * request replaces an older one. The same conversation booking twice (the
 * member changed their mind mid-call) moves its own booking.
 */
export async function scheduleCallback(db, {
  orgId, clientId, phone = null, branchId = null, ruleId = null, jobId = null, conversationId = null,
  mode = 'agent', at, local, timezone, requestedText = null, reason = null, context = null,
  agentId = null, recordingId = null, scriptGroupId = null, language = null, source = 'member_request', by = null, maxAttempts = 2,
}) {
  if (!AUTO_MODES.includes(mode)) throw err('A scheduled call back is made by the AI or plays a recording');
  if (!at || !local) throw err('A call back needs a date and time');
  const ts = now();
  if (jobId) {
    const mine = await db.q1(`SELECT * FROM followup_callbacks WHERE org_id = ? AND client_id = ? AND job_id = ? AND mode != 'human' AND status = 'scheduled'`, [orgId, clientId, jobId]);
    if (mine) {
      await move(db, mine, { scheduled_for: at, scheduled_local: local, timezone, requested_time: requestedText, context: context ?? mine.context, attempts: 0 }, 'rescheduled', { by: by || 'member', note: requestedText });
      return db.q1('SELECT * FROM followup_callbacks WHERE id = ?', [mine.id]);
    }
  }
  const older = await db.q(`SELECT * FROM followup_callbacks WHERE org_id = ? AND client_id = ? AND mode != 'human' AND status = 'scheduled'`, [orgId, clientId]);
  for (const o of older) await move(db, o, { status: 'cancelled', closed_at: ts, last_error: 'Replaced by a newer call back request' }, 'replaced', { by: by || 'member', onlyIf: ['scheduled'] });
  const cid = id('fcb');
  await db.run(
    `INSERT INTO followup_callbacks (id, org_id, branch_id, client_id, phone, rule_id, job_id, channel, reason, requested_time, priority, status, mode,
       scheduled_for, scheduled_local, timezone, conversation_id, context, agent_id, recording_id, script_group_id, language, source, attempts, max_attempts, events_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [cid, orgId, branchId, clientId, phone, ruleId, jobId, mode === 'agent' ? 'agent' : 'call', reason ? String(reason).slice(0, 500) : null, requestedText ? String(requestedText).slice(0, 200) : null,
      mode, at, local, timezone, conversationId, context ? String(context).slice(0, 1000) : null, agentId, recordingId, scriptGroupId, language, source, Math.min(3, Math.max(1, maxAttempts)),
      appendEvent(null, 'scheduled', { by: by || (source === 'owner' ? 'owner' : 'member'), note: requestedText || local }), ts, ts]);
  return db.q1('SELECT * FROM followup_callbacks WHERE id = ?', [cid]);
}

/* ---------------- running them ---------------- */

/** Mark call backs that missed their time by too long. Returns how many. */
export async function expireLate(db, orgId, at = new Date()) {
  const late = await db.q(`SELECT * FROM followup_callbacks WHERE org_id = ? AND status = 'scheduled' AND scheduled_for < ?`, [orgId, new Date(at.getTime() - LATE_LIMIT_MS).toISOString()]);
  let n = 0;
  for (const cb of late) {
    if (await move(db, cb, { status: 'expired', closed_at: now(), last_error: `Not placed within 2 hours of ${cb.scheduled_local}. Call the member yourself or book a new time.` }, 'expired', { onlyIf: ['scheduled'] })) n += 1;
  }
  return n;
}

async function memberFor(db, orgId, clientId) {
  return db.q1(`SELECT c.id, c.org_id, u.phone, u.name, u.active FROM clients c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.org_id = ?`, [clientId, orgId]);
}

/**
 * Queue every call back that is due now (inside calling hours, feature on).
 * Each becomes an ordinary job; dispatchOrg places it with every gate,
 * hold and charge a campaign call gets.
 */
export async function queueDueCallbacks(db, orgId, { at = new Date(), settings = null, tz = null, max = 25 } = {}) {
  const s = settings || await getSettings(db, orgId);
  const zone = tz || await getOrgTzCached(db, orgId);
  const out = { expired: await expireLate(db, orgId, at), queued: 0, cancelled: 0, handed_to_staff: 0, failed: 0 };
  if (!s.enabled || !inCallingHours(s, zone, at)) return out;
  const due = await db.q(
    `SELECT * FROM followup_callbacks WHERE org_id = ? AND status = 'scheduled' AND mode IN ('agent','call') AND scheduled_for <= ? ORDER BY scheduled_for LIMIT ?`,
    [orgId, at.toISOString(), max]);
  const todayKey = dayKey(at, zone);
  for (const cb of due) {
    const claimed = await db.run(`UPDATE followup_callbacks SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'scheduled' AND scheduled_for <= ?`, [now(), cb.id, at.toISOString()]);
    if (claimed.changes !== 1) continue;                                   // another worker has it
    const attempt = Number(cb.attempts) + 1;
    const cur = { ...cb, status: 'processing', attempts: attempt };
    const stop = async (status, why, key) => { await move(db, cur, { status, closed_at: now(), last_error: why }, status === 'cancelled' ? 'cancelled' : 'failed', { note: why }); out[key] += 1; };

    const member = await memberFor(db, orgId, cb.client_id);
    if (!member || !Number(member.active)) { await stop('cancelled', 'The member is no longer active at this gym', 'cancelled'); continue; }
    const phone = normalizePhone(member.phone);
    if (!phone) { await stop('cancelled', 'The member has no valid mobile number', 'cancelled'); continue; }
    const prefs = await db.q1('SELECT * FROM followup_member_prefs WHERE client_id = ?', [cb.client_id]) || {};
    if (prefs.call_opted_out_at) { await stop('cancelled', 'The member asked to stop calls', 'cancelled'); continue; }
    if (prefs.call_consent === 'refused') { await stop('cancelled', 'The member withdrew permission for calls', 'cancelled'); continue; }
    if (await db.q1(`SELECT id FROM followup_jobs WHERE client_id = ? AND outcome = 'wrong_number' AND to_number = ? LIMIT 1`, [cb.client_id, phone])) { await stop('cancelled', 'This number belongs to someone else', 'cancelled'); continue; }
    if (Number(prefs.human_only)) {
      await move(db, cur, { mode: 'human', status: 'new', priority: 'high' }, 'handed_to_staff', { note: 'The member wants a person, not an automated call' });
      out.handed_to_staff += 1;
      continue;
    }

    const rule = cb.rule_id ? await db.q1('SELECT * FROM followup_rules WHERE id = ? AND org_id = ?', [cb.rule_id, orgId]) : null;
    const origin = cb.job_id ? await db.q1('SELECT unit, variables_json, language, cycle_key FROM followup_jobs WHERE id = ? AND org_id = ?', [cb.job_id, orgId]) : null;
    const channel = cb.mode === 'agent' ? 'agent' : 'call';
    if (channel === 'agent') {
      const agentId = cb.agent_id || rule?.agent_id;
      const agent = agentId ? await db.q1(`SELECT id FROM followup_agents WHERE id = ? AND org_id = ? AND status = 'active'`, [agentId, orgId]) : null;
      if (!agent) { await stop('failed', 'The AI agent for this call back was removed. Pick another agent or call yourself.', 'failed'); continue; }
      if (!cb.agent_id) await db.run('UPDATE followup_callbacks SET agent_id = ? WHERE id = ?', [agentId, cb.id]);
    } else if (!cb.recording_id && !cb.script_group_id && !rule?.recording_id && !rule?.script_group_id) {
      await stop('failed', 'Pick the recording this call back should play.', 'failed');
      continue;
    }
    const unit = origin?.unit && String(origin.unit).startsWith(channel === 'agent' ? 'agent:' : 'voice:') ? origin.unit : unitFor(channel, rule || {});
    const vars = {
      ...parse(origin?.variables_json, {}),
      callback_context: cb.context || (cb.requested_time ? `The member asked to be called back (${cb.requested_time}).` : 'The member asked to be called back.'),
      callback_time: cb.scheduled_local,
    };
    const jobId = id('fj');
    const ts = now();
    try {
      await db.run(
        `INSERT INTO followup_jobs (id, org_id, branch_id, rule_id, client_id, channel, dedupe_key, cycle_key, step_key, seq_index, day_key, attempt, language, status, to_number, unit, variables_json, callback_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        // cycle_key = the situation it was booked about (dispatch drops the call
        // back if that situation is gone); step_key 'cbN' never matches a campaign step.
        [jobId, orgId, cb.branch_id || null, cb.rule_id || null, cb.client_id, channel, `cb:${cb.id}:${attempt}`, origin?.cycle_key || `cb:${cb.id}`, `cb${attempt}`, todayKey, attempt,
          cb.language || origin?.language || null, phone, unit, JSON.stringify(vars), cb.id, ts, ts]);
    } catch (e) {
      if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e;
      continue;                                                            // this attempt is already queued
    }
    await move(db, cur, { last_job_id: jobId }, 'queued', { note: `attempt ${attempt}` });
    out.queued += 1;
  }
  return out;
}

/** When the next try happens: an hour later, or the requested time on the next open day. */
export function nextRetry(cb, settings, tz, at = new Date()) {
  const w = callingWindow(settings);
  const mask = String(settings.days_mask || '1111110').padEnd(7, '0');
  const soon = new Date(at.getTime() + RETRY_GAP_MIN * 60_000);
  if (inCallingHours(settings, tz, soon) && localClock(tz, soon).minutes < w.end - 10) return soon;
  const asked = /\d{2}:\d{2}$/.exec(String(cb.scheduled_local || ''))?.[0];
  const askedMin = asked ? Number(asked.slice(0, 2)) * 60 + Number(asked.slice(3)) : w.start;
  const minutes = Math.min(Math.max(askedMin, w.start), w.end - 30);
  let k = dayKey(at, tz);
  for (let i = 0; i < 8; i++) {
    k = new Date(Date.parse(`${k}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const wd = (new Date(`${k}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (mask[wd] === '1') break;
  }
  return localToUtc(k, minutes, tz);
}

/**
 * A call-back job has ended (any final status). Idempotent: only the job the
 * call back is currently waiting on can move it, and only out of 'processing'.
 */
export async function syncCallbackFromJob(db, jobId, { at = new Date() } = {}) {
  const j = await db.q1('SELECT * FROM followup_jobs WHERE id = ?', [jobId]);
  if (!j?.callback_id) return null;
  const cb = await db.q1('SELECT * FROM followup_callbacks WHERE id = ?', [j.callback_id]);
  if (!cb || cb.status !== 'processing' || cb.last_job_id !== j.id) return null;
  const connected = j.status === 'completed' && (j.channel === 'call' || Number(j.duration_secs) > 0);
  if (connected) {
    await move(db, cb, { status: 'completed', completed_at: now(), closed_at: now() }, 'completed', { note: j.channel === 'agent' ? 'The AI called the member back' : 'The recording was played', onlyIf: ['processing'] });
    return 'completed';
  }
  const why = String(j.error || j.status || '');
  if (j.status === 'skipped' && /no longer due|visited|renewed|paid|stopped|no longer reachable|someone else|person|no longer active|number changed|permission/i.test(why)) {
    await move(db, cb, { status: 'cancelled', closed_at: now(), last_error: why }, 'cancelled', { note: why, onlyIf: ['processing'] });
    return 'cancelled';
  }
  if (j.status === 'skipped' && /capacity|minutes left|minutes|balance/i.test(why)) {
    await move(db, cb, { status: 'failed', closed_at: now(), last_error: `${why}. Buy more and book it again, or call the member yourself.` }, 'failed', { note: why, onlyIf: ['processing'] });
    return 'failed';
  }
  const settings = await getSettings(db, cb.org_id);
  const tz = await getOrgTzCached(db, cb.org_id);
  if (Number(cb.attempts) < Number(cb.max_attempts)) {
    // From the later of now and the attempt's own time: a late result, or a
    // scheduler run on a simulated clock, never books a retry in the past.
    const next = nextRetry(cb, settings, tz, new Date(Math.max(at.getTime(), Date.parse(cb.scheduled_for) || 0)));
    const label = { no_answer: 'No answer', busy: 'Line busy', failed: 'The call did not go through', skipped: why || 'Not placed' }[j.status] || j.status;
    await move(db, cb, { status: 'scheduled', scheduled_for: next.toISOString(), last_error: label }, 'retry', { note: `${label}; trying again`, onlyIf: ['processing'] });
    return 'retry';
  }
  const label = { no_answer: 'No answer', busy: 'Line busy', failed: 'The call did not go through' }[j.status] || why || 'Could not be placed';
  await move(db, cb, { status: 'failed', closed_at: now(), last_error: `${label} after ${cb.attempts} attempt${Number(cb.attempts) === 1 ? '' : 's'}. Call the member yourself.` }, 'failed', { note: label, onlyIf: ['processing'] });
  return 'failed';
}

/* ---------------- the owner's controls ---------------- */

async function resolveForGym(db, orgId, { date, time, text }, at = new Date()) {
  const settings = await getSettings(db, orgId);
  const tz = await getOrgTzCached(db, orgId);
  const r = resolveWhen({ text: text || '', date, time, now: at, tz, window: callingWindow(settings), daysMask: settings.days_mask, leadMin: 5 });
  if (!r.ok) throw err(r.ask.replace(/suits you\?|would suit you\?/g, 'should it be?'));
  return { r, tz, settings };
}

export async function createCallback(db, orgId, by, { clientId, date, time, mode, agentId = null, recordingId = null, scriptGroupId = null, reason = null }, at = new Date()) {
  const member = await memberFor(db, orgId, clientId);
  if (!member) throw err('Member not found', 404);
  const prefs = await db.q1('SELECT * FROM followup_member_prefs WHERE client_id = ?', [clientId]) || {};
  if (prefs.call_opted_out_at || prefs.call_consent !== 'granted') throw err('This member has not given permission for calls, or asked to stop them');
  if (Number(prefs.human_only)) throw err('This member wants a person, not an automated call');
  await checkContent(db, orgId, { mode, agentId, recordingId, scriptGroupId });
  const { r, tz } = await resolveForGym(db, orgId, { date, time }, at);
  return scheduleCallback(db, {
    orgId, clientId, phone: normalizePhone(member.phone), mode, at: r.at, local: r.local, timezone: tz, requestedText: r.label,
    reason: reason || 'Booked by the gym', agentId, recordingId, scriptGroupId, source: 'owner', by,
  });
}

async function checkContent(db, orgId, { mode, agentId, recordingId, scriptGroupId }) {
  if (mode === 'agent') {
    if (!agentId || !(await db.q1(`SELECT id FROM followup_agents WHERE id = ? AND org_id = ? AND status = 'active'`, [agentId, orgId]))) throw err('Pick the AI agent that should call');
  } else if (mode === 'call') {
    if (recordingId && !(await db.q1(`SELECT id FROM followup_recordings WHERE id = ? AND org_id = ? AND status = 'active'`, [recordingId, orgId]))) throw err('Pick one of your recordings');
    if (scriptGroupId && !(await db.q1('SELECT 1 AS ok FROM followup_scripts WHERE group_id = ? AND org_id = ? LIMIT 1', [scriptGroupId, orgId]))) throw err('Pick one of your voice messages');
    if (!recordingId && !scriptGroupId) throw err('Pick the recording to play');
  }
}

const CHANGEABLE = ['scheduled', 'failed', 'expired', 'cancelled', 'new', 'assigned'];

export async function rescheduleCallback(db, orgId, cbId, { date, time }, by, at = new Date()) {
  const cb = await getCallback(db, orgId, cbId);
  if (!cb) throw err('Call back not found', 404);
  if (!CHANGEABLE.includes(cb.status)) throw err('This call back is being placed right now. Try again in a minute.', 409);
  const { r, tz } = await resolveForGym(db, orgId, { date, time }, at);
  const mode = AUTO_MODES.includes(cb.mode) ? cb.mode : 'agent';
  if (mode === 'agent' && !cb.agent_id) {
    const agent = cb.rule_id ? await db.q1('SELECT agent_id FROM followup_rules WHERE id = ?', [cb.rule_id]) : null;
    if (!agent?.agent_id) throw err('Choose who calls first: the AI (pick an agent) or a recording');
    await db.run('UPDATE followup_callbacks SET agent_id = ? WHERE id = ?', [agent.agent_id, cb.id]);
  }
  await move(db, cb, { status: 'scheduled', mode, scheduled_for: r.at, scheduled_local: r.local, timezone: tz, attempts: 0, closed_at: null, last_error: null }, 'rescheduled', { by, note: r.label });
  return getCallback(db, orgId, cbId);
}

export async function changeCallbackMode(db, orgId, cbId, { mode, agentId = null, recordingId = null, scriptGroupId = null }, by) {
  const cb = await getCallback(db, orgId, cbId);
  if (!cb) throw err('Call back not found', 404);
  if (!MODES.includes(mode)) throw err('Unknown call back type');
  if (!CHANGEABLE.includes(cb.status)) throw err('This call back is being placed right now. Try again in a minute.', 409);
  if (mode === 'human') {
    await move(db, cb, { mode: 'human', status: cb.assigned_to ? 'assigned' : 'new', closed_at: null }, 'handed_to_staff', { by, note: 'A person from the gym will call' });
    return getCallback(db, orgId, cbId);
  }
  await checkContent(db, orgId, { mode, agentId: agentId || cb.agent_id, recordingId: recordingId || cb.recording_id, scriptGroupId: scriptGroupId || cb.script_group_id });
  if (!cb.scheduled_for) throw err('Pick a date and time for the call back first');
  const late = Date.parse(cb.scheduled_for) < Date.now() - LATE_LIMIT_MS;
  await move(db, cb, {
    mode, agent_id: agentId || cb.agent_id, recording_id: recordingId || cb.recording_id, script_group_id: scriptGroupId || cb.script_group_id,
    status: late ? 'expired' : 'scheduled', closed_at: null,
  }, 'mode_changed', { by, note: mode === 'agent' ? 'The AI will call back' : 'A recording will be played' });
  return getCallback(db, orgId, cbId);
}

export async function cancelCallback(db, orgId, cbId, by, note = null) {
  const cb = await getCallback(db, orgId, cbId);
  if (!cb) throw err('Call back not found', 404);
  if (cb.status === 'processing') throw err('This call back is being placed right now.', 409);
  if (['completed', 'cancelled'].includes(cb.status)) return cb;
  await move(db, cb, { status: 'cancelled', closed_at: now(), last_error: note || 'Cancelled by the gym' }, 'cancelled', { by, note });
  return getCallback(db, orgId, cbId);
}

/** "Call now": due immediately, if the gym may call right now. The caller runs the queue. */
export async function callNow(db, orgId, cbId, by, at = new Date()) {
  const cb = await getCallback(db, orgId, cbId);
  if (!cb) throw err('Call back not found', 404);
  if (!AUTO_MODES.includes(cb.mode)) throw err('This call back is for a person from the gym. Change it to the AI or a recording first.');
  if (!['scheduled', 'failed', 'expired'].includes(cb.status)) throw err('This call back cannot be placed now.', 409);
  const settings = await getSettings(db, orgId);
  const tz = await getOrgTzCached(db, orgId);
  if (!settings.enabled) throw err('Switch AI Communication on first', 409);
  if (!inCallingHours(settings, tz, at)) throw err('It is outside your calling hours. Reschedule it instead.', 409);
  const local = `${dayKey(at, tz)} ${String(Math.floor(localClock(tz, at).minutes / 60)).padStart(2, '0')}:${String(localClock(tz, at).minutes % 60).padStart(2, '0')}`;
  await move(db, cb, { status: 'scheduled', scheduled_for: at.toISOString(), scheduled_local: local, timezone: tz, closed_at: null, last_error: null, attempts: cb.status === 'scheduled' ? cb.attempts : 0 }, 'call_now', { by });
  return getCallback(db, orgId, cbId);
}

/** For the owner: the label as said to the member, e.g. "Monday 16 November at 6 PM". */
export function callbackLabel(cb, todayKey = null) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(String(cb.scheduled_local || ''));
  return m ? whenLabel(m[1], Number(m[2]) * 60 + Number(m[3]), todayKey) : null;
}
