// ============================================================
// YOUR OWN MODELS -- a plain HTTP contract for self-hosted speech
// (IndicF5, XTTS, any TTS you run) and a self-built AI agent.
//
// Point FOLLOWUP_SPEECH_HTTP_URL / FOLLOWUP_AGENT_HTTP_URL at your server
// and set FOLLOWUP_HTTP_TOKEN; every request carries
// `Authorization: Bearer <token>`. Nothing else in the app changes.
//
// SPEECH contract
//   GET  {url}/voices
//        -> { voices: [{ id, name, gender?, accent?, languages?: ['kn','hi'] }] }
//   POST {url}/synthesize   { voice, text, language }   (language: en, hi, kn, ta, te, mr, bn, gu, ml, pa)
//        -> audio/wav (8 kHz mono preferred; anything WAV works)
//
// AGENT contract (your agent places the call and talks; we decide who and why)
//   PUT  {url}/agents/{id?}   { name, prompt, first_message, language, voice, max_seconds }
//        -> { id }
//   POST {url}/calls          { agent_id, line, to, variables }   (variables.followup_job is opaque: echo it back)
//        -> { id }
//   When the call ends, POST https://<app>/api/followups/hooks/agent/http with JSON
//        { followup_job, call_id, status: completed|no_answer|busy|failed, duration_secs,
//          outcome: coming_back|renewing|will_pay|callback_requested|not_interested|opted_out|wrong_number|other,
//          summary }
//        and header X-Followup-Signature: hex HMAC-SHA256 of the raw body with FOLLOWUP_HTTP_TOKEN.
// ============================================================
import crypto from 'node:crypto';

const env = (k) => String(process.env[k] || '').trim().replace(/\/+$/, '');
const token = () => env('FOLLOWUP_HTTP_TOKEN');
const headers = (json = true) => ({ Authorization: `Bearer ${token()}`, ...(json ? { 'Content-Type': 'application/json' } : {}) });

async function call(base, path, { method = 'GET', body, raw = false, what }) {
  if (!base) throw Object.assign(new Error(`${what}: your server is not configured`), { status: 503 });
  const res = await fetch(`${base}${path}`, { method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw Object.assign(new Error(`${what} failed on your server (${res.status})`), { status: 502 });
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

export const speech = {
  id: 'http',
  label: 'Your speech server',
  languages: null,
  features: { library: true, design: false, clone: false },
  configured: () => !!env('FOLLOWUP_SPEECH_HTTP_URL'),
  async listVoices() {
    const r = await call(env('FOLLOWUP_SPEECH_HTTP_URL'), '/voices', { what: 'Listing voices' });
    return (r.voices || []).map((v) => ({ voice_id: String(v.id), name: v.name || String(v.id), gender: v.gender || null, accent: v.accent || null, languages: v.languages || null, description: 'Your own model', preview_url: null }));
  },
  async synthesize({ voiceId, text, language }) {
    const audio = await call(env('FOLLOWUP_SPEECH_HTTP_URL'), '/synthesize', { method: 'POST', raw: true, body: { voice: voiceId, text, language }, what: 'Making the voice message' });
    return { audio, model: 'self-hosted' };
  },
};

export const conversation = {
  id: 'http',
  label: 'Your agent server',
  configured: () => !!env('FOLLOWUP_AGENT_HTTP_URL'),
  async upsertAgent({ agentId, name, prompt, firstMessage, language, voiceId, maxSecs }) {
    const r = await call(env('FOLLOWUP_AGENT_HTTP_URL'), `/agents${agentId ? `/${encodeURIComponent(agentId)}` : ''}`, {
      method: 'PUT', body: { name, prompt, first_message: firstMessage, language, voice: voiceId, max_seconds: maxSecs }, what: 'Saving the AI agent',
    });
    return String(r.id);
  },
  async startCall({ agentId, lineRef, to, variables }) {
    const r = await call(env('FOLLOWUP_AGENT_HTTP_URL'), '/calls', { method: 'POST', body: { agent_id: agentId, line: lineRef, to, variables }, what: 'Placing the AI call' });
    return { ref: String(r.id) };
  },
  verifyWebhook(rawBody, hdrs) {
    const sig = String(hdrs['x-followup-signature'] || '');
    if (!token() || !sig) return false;
    const want = crypto.createHmac('sha256', token()).update(rawBody).digest('hex');
    return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
  },
  parseResult(rawBody) {
    const e = JSON.parse(rawBody);
    return { token: e.followup_job, ref: e.call_id || null, status: e.status, duration: Number(e.duration_secs) || 0, outcome: e.outcome || null, summary: e.summary || null };
  },
};
