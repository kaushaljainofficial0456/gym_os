// ============================================================
// ELEVENLABS -- the voices, and the two-way AI conversations.
//
//   tts()                 the owner's message as phone audio (WAV 8 kHz)
//   listVoices()          the voice library, for the picker
//   designVoice()         "describe a voice" -> three previews
//   saveDesignedVoice()   keep one of them as the gym's own voice
//   upsertAgent()         an AI agent built from an automation
//   exotelOutboundCall()  place an AI conversation through Exotel
//   verifyWebhook()       authenticate the post-call result
//
// The API key never leaves the server. Every call has a timeout, and an
// error carries the provider's message (never the key) so the owner's
// screen can say what went wrong.
// ============================================================
import crypto from 'node:crypto';
import { elevenEnv } from '../config.js';

const TIMEOUT_MS = 20_000;

function providerError(status, body, what) {
  let msg = '';
  try { const j = JSON.parse(body); msg = j?.detail?.message || j?.detail?.[0]?.msg || j?.message || j?.detail || ''; } catch { msg = String(body || '').slice(0, 200); }
  const e = new Error(`${what} failed (${status})${msg ? `: ${typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200)}` : ''}`);
  e.status = status === 401 || status === 403 ? 502 : (status === 429 ? 429 : 502);
  e.provider = 'elevenlabs';
  return e;
}

async function call(path, { method = 'GET', body, raw = false, what = 'ElevenLabs request' } = {}) {
  const { apiKey, base } = elevenEnv();
  if (!apiKey) { const e = new Error('ElevenLabs is not configured'); e.status = 503; throw e; }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'xi-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: raw ? 'audio/wav' : 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw providerError(res.status, await res.text().catch(() => ''), what);
  if (raw) return Buffer.from(await res.arrayBuffer());
  return res.json();
}

/* ---- models: the cheapest one that speaks the language ---- */
let modelCache = { at: 0, list: null };
const PREFERENCE = ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2', 'eleven_v3'];

export async function modelFor(language) {
  if (!modelCache.list || Date.now() - modelCache.at > 24 * 3600_000) {
    try {
      const list = await call('/v1/models', { what: 'Listing models' });
      modelCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
    } catch {
      modelCache = { at: Date.now(), list: [] };
    }
  }
  const speaks = (m) => m.can_do_text_to_speech !== false && (m.languages || []).some((l) => String(l.language_id || '').toLowerCase() === language);
  for (const id of PREFERENCE) {
    const m = modelCache.list.find((x) => x.model_id === id);
    if (m && speaks(m)) return id;
  }
  const any = modelCache.list.find(speaks);
  return any?.model_id || 'eleven_multilingual_v2';
}

/** Speech as WAV, 8 kHz -- what a phone line carries. */
export async function tts({ voiceId, text, language = 'en' }) {
  const modelId = await modelFor(language);
  const audio = await call(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav_8000`, {
    method: 'POST', raw: true, what: 'Making the voice message',
    body: { text, model_id: modelId },
  });
  return { audio, modelId };
}

/** The voice library: premade voices plus the account's own. */
export async function listVoices() {
  let voices;
  try {
    const r = await call('/v2/voices?page_size=100&include_total_count=false', { what: 'Listing voices' });
    voices = r.voices || [];
  } catch {
    const r = await call('/v1/voices', { what: 'Listing voices' });
    voices = r.voices || [];
  }
  return voices.map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category || null,
    gender: v.labels?.gender || null,
    accent: v.labels?.accent || null,
    age: v.labels?.age || null,
    description: v.labels?.description || v.description || null,
    preview_url: v.preview_url || null,
  }));
}

/** "A warm, friendly Indian woman in her 30s" -> up to three previews. */
export async function designVoice({ description, text }) {
  const body = { voice_description: description, ...(text ? { text } : { auto_generate_text: true }) };
  let r;
  try {
    r = await call('/v1/text-to-voice/design', { method: 'POST', body, what: 'Designing the voice' });
  } catch (e) {
    if (e.status !== 502) throw e;
    r = await call('/v1/text-to-voice/create-previews', { method: 'POST', body, what: 'Designing the voice' });
  }
  return (r.previews || []).slice(0, 3).map((p) => ({
    generated_voice_id: p.generated_voice_id,
    audio_base64: p.audio_base_64 || p.audio_base64,
    media_type: p.media_type || 'audio/mpeg',
  }));
}

export async function saveDesignedVoice({ generatedVoiceId, name, description }) {
  const r = await call('/v1/text-to-voice', {
    method: 'POST', what: 'Saving the voice',
    body: { voice_name: name, voice_description: description, generated_voice_id: generatedVoiceId },
  });
  return r.voice_id;
}

/**
 * Instant voice clone from recorded samples. Only called after the owner
 * recorded an authorization (who the speaker is, that they consented, and
 * a statement version) -- routes/followups.js refuses otherwise.
 */
export async function cloneVoice({ name, description, files }) {
  const { apiKey, base } = elevenEnv();
  if (!apiKey) { const e = new Error('ElevenLabs is not configured'); e.status = 503; throw e; }
  const form = new FormData();
  form.set('name', name);
  if (description) form.set('description', description);
  for (const f of files) form.append('files', new Blob([f.buffer], { type: f.type || 'audio/mpeg' }), f.name || 'sample.mp3');
  const res = await fetch(`${base}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw providerError(res.status, await res.text().catch(() => ''), 'Cloning the voice');
  const j = await res.json();
  return j.voice_id;
}

export async function deleteVoice(voiceId) {
  await call(`/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE', what: 'Deleting the voice' });
}

/**
 * Create or update the AI agent for an automation. The agent says its
 * opening line, pursues the owner's goal, and reports a structured
 * outcome the engine acts on (data_collection).
 */
export async function upsertAgent({ agentId, name, prompt, firstMessage, language, voiceId, maxSecs = 180 }) {
  const body = {
    name: name.slice(0, 80),
    conversation_config: {
      agent: { first_message: firstMessage, language, prompt: { prompt } },
      tts: voiceId ? { voice_id: voiceId } : undefined,
      conversation: { max_duration_seconds: maxSecs },
    },
    platform_settings: {
      data_collection: {
        outcome: {
          type: 'string',
          description: 'How the call ended for the gym. Exactly one of: coming_back, renewing, will_pay, callback_requested, not_interested, opted_out, wrong_number, no_conversation, other.',
        },
        reason: { type: 'string', description: 'In one short sentence, why the member has not been coming, or their main objection. Empty if not said.' },
      },
    },
  };
  if (agentId) {
    await call(`/v1/convai/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body, what: 'Updating the AI agent' });
    return agentId;
  }
  const r = await call('/v1/convai/agents/create', { method: 'POST', body, what: 'Creating the AI agent' });
  return r.agent_id;
}

export async function exotelOutboundCall({ agentId, agentPhoneId, to, variables }) {
  const r = await call('/v1/convai/exotel/outbound-call', {
    method: 'POST', what: 'Placing the AI call',
    body: {
      agent_id: agentId,
      agent_phone_number_id: agentPhoneId,
      to_number: to,
      conversation_initiation_client_data: { dynamic_variables: variables },
      telephony_call_config: { ringing_timeout_secs: 35 },
    },
  });
  if (r && r.success === false) { const e = new Error(r.message || 'The AI call could not be placed'); e.status = 502; throw e; }
  return { conversationId: r.conversation_id || null, callSid: r.callSid || null };
}

/**
 * ElevenLabs-Signature: "t=<unix>,v0=<hex hmac-sha256 of `<t>.<body>`>".
 * Rejects stale timestamps (replays) and anything unsigned.
 */
export function verifyWebhook(rawBody, header, secret = elevenEnv().webhookSecret, toleranceSec = 1800) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec || !parts.v0) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(parts.v0));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const _resetModelCacheForTests = () => { modelCache = { at: 0, list: null }; };

/* ---------------- provider-neutral adapters (see ./index.js) ---------------- */

export const speech = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  languages: null,
  features: { library: true, design: true, clone: true },
  configured: () => !!elevenEnv().apiKey,
  listVoices,
  async synthesize({ voiceId, text, language }) {
    const r = await tts({ voiceId, text, language });
    return { audio: r.audio, model: r.modelId };
  },
  designVoice,
  saveDesignedVoice,
  cloneVoice,
  deleteVoice,
};

export const conversation = {
  id: 'elevenlabs',
  label: 'ElevenLabs Agents',
  configured: () => !!elevenEnv().apiKey,
  upsertAgent,
  async startCall({ agentId, lineRef, to, variables }) {
    if (!lineRef) throw Object.assign(new Error('This caller line is not connected to ElevenLabs yet'), { status: 503 });
    const r = await exotelOutboundCall({ agentId, agentPhoneId: lineRef, to, variables });
    return { ref: r.conversationId || r.callSid };
  },
  verifyWebhook: (rawBody, hdrs) => verifyWebhook(rawBody, hdrs['elevenlabs-signature']),
  parseResult(rawBody) {
    const evt = JSON.parse(rawBody);
    const data = evt.data || {};
    const token = data.conversation_initiation_client_data?.dynamic_variables?.followup_job || null;
    if (evt.type === 'call_initiation_failure') {
      const reason = String(data.failure_reason || '').toLowerCase();
      return { token, ref: data.conversation_id || null, status: reason === 'busy' ? 'busy' : reason === 'no-answer' ? 'no_answer' : 'failed', duration: 0 };
    }
    if (evt.type !== 'post_call_transcription') return null;
    const dc = data.analysis?.data_collection_results || {};
    const val = (k) => (dc[k] && typeof dc[k] === 'object' ? dc[k].value : dc[k]);
    return { token, ref: data.conversation_id || null, status: 'completed', duration: Number(data.metadata?.call_duration_secs) || 0, outcome: val('outcome') || null, summary: val('reason') || data.analysis?.transcript_summary || null };
  },
};
