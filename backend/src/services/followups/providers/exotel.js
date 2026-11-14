// ============================================================
// EXOTEL -- the phone calls and WhatsApp messages.
//
// Voice-message calls go through ONE Exotel call flow the operator builds
// once (docs/FOLLOWUPS.md): Programmable Gather (asks our server what to
// play -- the member's audio -- and collects one key) -> Passthru (tells
// us the key) -> Hangup. We start each call with Calls/connect pointed at
// that flow, and CustomField carries a signed job token so every callback
// is tied to its job and cannot be forged.
//
// WhatsApp uses Exotel's v2 messages API with Meta-approved templates.
//
// Field names Exotel's public docs did not pin down (callback payloads,
// the WhatsApp response) are read defensively; see docs/FOLLOWUPS.md,
// "Things to verify on the live account".
// ============================================================
import { exotelEnv } from '../config.js';
import { toMetaBody } from '../render.js';

const TIMEOUT_MS = 20_000;

function auth() {
  const ex = exotelEnv();
  if (!ex.sid || !ex.apiKey || !ex.apiToken) { const e = new Error('Exotel is not configured'); e.status = 503; throw e; }
  return { ex, header: `Basic ${Buffer.from(`${ex.apiKey}:${ex.apiToken}`).toString('base64')}` };
}

async function readError(res, what) {
  const text = await res.text().catch(() => '');
  let msg = '';
  try { const j = JSON.parse(text); msg = j?.RestException?.Message || j?.message || j?.response?.error_data?.message || ''; } catch { msg = text.replace(/<[^>]+>/g, ' ').trim().slice(0, 200); }
  const e = new Error(`${what} failed (${res.status})${msg ? `: ${msg}` : ''}`);
  e.status = res.status === 429 ? 429 : 502;
  e.provider = 'exotel';
  return e;
}

/** Start a voice-message call into the follow-up flow. Returns the CallSid. */
export async function placeFlowCall({ to, callerId, customField, statusUrl, timeLimit = 120, timeOut = 30 }) {
  const { ex, header } = auth();
  const form = new URLSearchParams();
  form.set('From', to);
  form.set('CallerId', callerId);
  form.set('Url', `http://my.exotel.com/${ex.sid}/exoml/start_voice/${ex.flowAppId}`);
  form.set('CallType', 'trans');
  form.set('TimeLimit', String(timeLimit));
  form.set('TimeOut', String(timeOut));
  form.set('CustomField', customField);
  form.set('StatusCallback', statusUrl);
  form.append('StatusCallbackEvents[0]', 'terminal');
  form.append('StatusCallbackEvents[1]', 'answered');
  form.set('StatusCallbackContentType', 'application/json');
  const res = await fetch(`https://${ex.subdomain}/v1/Accounts/${ex.sid}/Calls/connect.json`, {
    method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, 'Placing the call');
  const j = await res.json().catch(() => ({}));
  const sid = j?.Call?.Sid || j?.Sid || null;
  if (!sid) { const e = new Error('Exotel accepted the call but returned no call id'); e.status = 502; throw e; }
  return { ref: sid };
}

/**
 * Send one SMS through Exotel with its DLT registration (India requires a
 * registered header, entity and template for commercial SMS). Returns the
 * message sid; delivery comes later on the status callback.
 */
export async function sendSms({ from, to, body, dltEntityId, dltTemplateId, smsType = 'transactional', statusUrl }) {
  const { ex, header } = auth();
  const form = new URLSearchParams();
  form.set('From', from);
  form.set('To', to);
  form.set('Body', body);
  form.set('SmsType', smsType);
  if (dltEntityId) form.set('DltEntityId', dltEntityId);
  if (dltTemplateId) form.set('DltTemplateId', dltTemplateId);
  if (statusUrl) form.set('StatusCallback', statusUrl);
  const res = await fetch(`https://${ex.subdomain}/v1/Accounts/${ex.sid}/Sms/send.json`, {
    method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, 'Sending the SMS');
  const j = await res.json().catch(() => ({}));
  const sms = j?.SMSMessage || j?.SmsMessage || {};
  return { ref: sms.Sid || j?.Sid || null, segments: Number(sms.SmsUnits || sms.NumSegments || 0) || null };
}

/** Normalise an SMS status callback: { ref, status, segments }. */
export function parseSmsStatus(payload) {
  const p = payload || {};
  const raw = String(p.Status || p.status || p.SmsStatus || '').toLowerCase();
  // Failure first: "undelivered" contains "deliver", and reading it as
  // delivered would keep a failed SMS's charge instead of refunding it.
  const status = /fail|undeliv|reject|expired|dnd/.test(raw) ? 'failed' : /deliver/.test(raw) ? 'delivered' : (raw ? 'sent' : null);
  return { ref: p.SmsSid || p.Sid || p.sid || null, status, segments: Number(p.SmsUnits || p.NumSegments || 0) || null, detail: p.DetailedStatus || p.DetailedStatusCode || null };
}

export { toMetaBody };

/** Send one approved template. Returns the message id. */
export async function sendTemplate({ from, to, templateName, language, params }) {
  const { ex, header } = auth();
  const body = {
    whatsapp: {
      messages: [{
        from, to,
        content: {
          type: 'template',
          template: {
            name: templateName,
            language: { policy: 'deterministic', code: language },
            components: params.length ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }] : [],
          },
        },
      }],
    },
  };
  const res = await fetch(`https://${ex.subdomain}/v2/accounts/${ex.sid}/messages`, {
    method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, 'Sending the WhatsApp message');
  const j = await res.json().catch(() => ({}));
  const m = j?.response?.whatsapp?.messages?.[0] || j?.messages?.[0] || {};
  if (m.code && Number(m.code) >= 400) { const e = new Error(m?.error_data?.message || 'WhatsApp refused the message'); e.status = 502; throw e; }
  return { ref: m?.data?.sid || m?.sid || j?.sid || null };
}

/** Submit a template to Meta (through Exotel) for approval. */
export async function createTemplate({ name, language, category, body, examples, quickReplies }) {
  const { ex, header } = auth();
  if (!ex.wabaId) { const e = new Error('The WhatsApp Business account id is not configured'); e.status = 503; throw e; }
  const meta = toMetaBody(body);
  const components = [{ type: 'BODY', text: meta.text, ...(meta.order.length ? { example: { body_text: [meta.order.map((k) => examples[k] || k)] } } : {}) }];
  if (quickReplies?.length) components.push({ type: 'BUTTONS', buttons: quickReplies.map((t) => ({ type: 'QUICK_REPLY', text: String(t).slice(0, 25) })) });
  const res = await fetch(`https://${ex.subdomain}/v2/accounts/${ex.sid}/templates?waba_id=${encodeURIComponent(ex.wabaId)}`, {
    method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ whatsapp: { templates: [{ template: { category, name, language, components } }] } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, 'Submitting the template');
  const j = await res.json().catch(() => ({}));
  const t = j?.response?.whatsapp?.templates?.[0] || {};
  const status = String(t?.data?.status || t?.status || 'PENDING').toLowerCase();
  return { status: ['approved', 'rejected', 'pending'].includes(status) ? status : 'pending' };
}

/** Meta's verdict on a submitted template. */
export async function templateStatus({ name }) {
  const { ex, header } = auth();
  const res = await fetch(`https://${ex.subdomain}/v2/accounts/${ex.sid}/templates?waba_id=${encodeURIComponent(ex.wabaId)}&name=${encodeURIComponent(name)}`, {
    headers: { Authorization: header, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res, 'Checking the template');
  const j = await res.json().catch(() => ({}));
  const t = j?.response?.whatsapp?.templates?.[0]?.data || j?.data?.[0] || j?.templates?.[0] || {};
  const status = String(t.status || '').toLowerCase();
  return { status: ['approved', 'rejected', 'pending', 'paused', 'disabled'].includes(status) ? status : 'pending', reason: t.rejected_reason || t.reason || null };
}

/* ---- callback parsing: tolerant of form vs JSON and naming variants ---- */
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== '') return o[k]; return undefined; };

const STATUS_MAP = { completed: 'completed', 'in-progress': 'answered', answered: 'answered', ringing: null, queued: null, 'no-answer': 'no_answer', busy: 'busy', failed: 'failed', canceled: 'failed', cancelled: 'failed' };
const mapStatus = (raw) => { const k = String(raw || '').toLowerCase(); return k in STATUS_MAP ? STATUS_MAP[k] : (k ? 'failed' : null); };

/** Seconds, or null when the payload does not say (never a silent 0). */
function seconds(...values) {
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return null;
}

/**
 * Normalise a call status callback into { ref, status, duration, customField }.
 *
 * Exotel documents CallSid, Status (completed | failed | busy | no-answer),
 * DateUpdated and RecordingUrl as always sent; ConversationDuration, Legs and
 * CustomField only with StatusCallbackEvents (docs: voice-v1 status-callback).
 * Its docs do not promise a duration for calls connected to a FLOW, so a
 * missing duration is returned as null -- "unknown" -- and the engine keeps
 * the hold and reconciles through fetchCall() instead of billing 0 minutes.
 */
export function parseCallStatus(payload) {
  const p = payload || {};
  const legs = Array.isArray(p.Legs) ? p.Legs : [];
  const legDur = legs.length ? legs.reduce((m, l) => Math.max(m, Number(l?.OnCallDuration ?? l?.Duration ?? 0) || 0), 0) : null;
  return {
    ref: pick(p, 'CallSid', 'Sid', 'callSid') || null,
    status: mapStatus(pick(p, 'Status', 'CallStatus', 'DialCallStatus', 'status')),
    duration: seconds(pick(p, 'ConversationDuration'), pick(p, 'DialCallDuration'), pick(p, 'Duration', 'duration'), legDur),
    customField: pick(p, 'CustomField', 'customField') || null,
  };
}

/**
 * The provider's own record of a call (Call Details API,
 * GET /v1/Accounts/{sid}/Calls/{CallSid}.json?details=true): the fallback
 * Exotel recommends when a status callback is late, missing or incomplete.
 * Duration is filled in asynchronously (~2 minutes after the call ends), so
 * it may still be null. Returns { status, duration } or null.
 */
export async function fetchCall(callSid) {
  if (!callSid) return null;
  const { ex, header } = auth();
  const res = await fetch(`https://${ex.subdomain}/v1/Accounts/${ex.sid}/Calls/${encodeURIComponent(callSid)}.json?details=true`, {
    headers: { Authorization: header, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await readError(res, 'Reading the call');
  const j = await res.json().catch(() => ({}));
  const c = j?.Call || {};
  return { status: mapStatus(c.Status), duration: seconds(c?.Details?.ConversationDuration, c.Duration) };
}

/**
 * Exotel WhatsApp callbacks (delivery statuses and member replies) as
 * provider-neutral events: { statuses: [{ ref, status }], replies: [{ from, to, text }] }.
 * The exact shape could not be confirmed from Exotel's public docs, so the
 * known variants are read and anything else is ignored, never thrown on.
 * `to` (the business number replied to) is passed through when present.
 */
export function parseWhatsAppEvents(body) {
  const b = body && typeof body === 'object' ? body : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const items = [...arr(b?.whatsapp?.messages), ...arr(b?.messages), ...arr(b?.statuses), ...arr(b?.whatsapp?.statuses)];
  const out = { statuses: [], replies: [] };
  for (const m of items.length ? items : [b]) {
    if (!m || typeof m !== 'object') continue;
    const ref = m.sid || m.id || m.message_id || m?.data?.sid || null;
    const raw = String(m.status || m.exo_status_code || m?.data?.status || '').toLowerCase();
    // Failure first ("undelivered" contains "deliver"): a failed message is refunded.
    const status = /fail|undeliv|reject|expired/.test(raw) ? 'failed' : /read/.test(raw) ? 'read' : /deliver/.test(raw) ? 'delivered' : /sent/.test(raw) ? 'sent' : null;
    if (ref && status) out.statuses.push({ ref: String(ref).slice(0, 200), status });
    const from = m.from || m?.content?.from || null;
    const to = m.to || m?.content?.to || null;
    const text = m?.content?.text?.body || m?.content?.button?.text || m?.content?.interactive?.button_reply?.title || m.text || m.body || null;
    if (from && typeof text === 'string' && text.trim()) out.replies.push({ from: String(from).slice(0, 30), to: to ? String(to).slice(0, 30) : null, text: text.slice(0, 200) });
  }
  return out;
}

/** "\"2\"" -> "2"; anything but a single keypad digit -> null. */
export function parseDigits(raw) {
  // Exotel's Passthru sends digits quoted ("\"2\""); the first keypad digit
  // pressed is the member's choice. Anything without a digit is no choice.
  const m = String(raw ?? '').match(/[0-9]/);
  return m ? m[0] : null;
}

/* ---------------- provider-neutral adapters (see ./index.js) ---------------- */

export const telephony = {
  id: 'exotel',
  placeMessageCall: ({ to, callerId, token, statusUrl }) => placeFlowCall({ to, callerId, customField: token, statusUrl }),
  parseCallStatus,
  parseDigits,
  fetchCall,
};

export const sms = { id: 'exotel', send: sendSms, parseStatus: parseSmsStatus };

export const whatsapp = { id: 'exotel', sendTemplate, createTemplate, templateStatus, toMetaBody, parseEvents: parseWhatsAppEvents };
