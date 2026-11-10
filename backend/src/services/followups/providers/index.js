// ============================================================
// PROVIDERS -- the ONLY place the engine learns who does the work.
//
// AI Communication is built on five provider-neutral interfaces. The
// engine, the routes and the audio cache talk to these, never to a vendor,
// so replacing a vendor (ElevenLabs -> Sarvam -> IndicF5 -> your own model,
// or Exotel -> another carrier) is a new adapter plus an environment
// setting -- no engine change.
//
//   SPEECH        text -> phone audio, and voices
//     id, label, languages (our codes, or null = any), features { library, design, clone }
//     listVoices() -> [{ voice_id, name, gender, accent, age, description, preview_url }]
//     synthesize({ voiceId, text, language }) -> { audio: Buffer (WAV, 8 kHz mono), model }
//     designVoice?, saveDesignedVoice?, cloneVoice?, deleteVoice?
//
//   TELEPHONY     place a voice-message call into the keypad flow
//     id, placeMessageCall({ to, callerId, token, statusUrl }) -> { ref, simulated? }
//     parseCallStatus(payload) -> { ref, status, duration, customField }
//     parseDigits(raw) -> '0'..'9' | null
//
//   CONVERSATION  two-way AI phone agents
//     id, upsertAgent({ agentId, name, prompt, firstMessage, language, voiceId, maxSecs }) -> providerAgentId
//     startCall({ agentId, lineRef, to, variables }) -> { ref, simulated? }
//     verifyWebhook(rawBody, headers) -> boolean
//     parseResult(rawBody) -> { token, ref, status, duration, outcome, summary } | null
//
//   SMS           send(...) -> { ref, segments, simulated? };  parseStatus(payload)
//   WHATSAPP      sendTemplate(...) -> { ref, simulated? }; createTemplate(...); templateStatus(...)
//
// `simulated` is how TEST mode works without branches in the engine: the
// mock adapters return the outcome at once and the engine applies it
// exactly as it would a provider's webhook.
//
// VOICES ARE PROVIDER-QUALIFIED: "sarvam:priya", "elevenlabs:21m00...",
// "http:my-voice". Several speech providers can be live at once (say
// ElevenLabs for English, your own IndicF5 server for Kannada) and every
// voice reaches the engine that owns it. An unprefixed id is ElevenLabs
// (how voices were stored before this registry).
//
// Choosing providers (environment):
//   FOLLOWUP_PROVIDER=exotel            telephony, SMS and WhatsApp on Exotel
//   ELEVENLABS_API_KEY                  enables ElevenLabs speech + agents
//   SARVAM_API_KEY                      enables Sarvam speech (Indian languages)
//   FOLLOWUP_SPEECH_HTTP_URL            enables your own speech server (see http.js)
//   FOLLOWUP_AGENT_PROVIDER=elevenlabs|http   who runs NEW AI agents
//   FOLLOWUP_AGENT_HTTP_URL             your own agent server (see http.js)
// ============================================================
import { setupStatus, elevenEnv } from '../config.js';
import * as elevenlabs from './elevenlabs.js';
import * as exotel from './exotel.js';
import * as sarvam from './sarvam.js';
import * as http from './http.js';
import * as mock from './mock.js';

const err = (msg, status = 503) => Object.assign(new Error(msg), { status });

/* ---------------- speech ---------------- */

const SPEECH = { elevenlabs: elevenlabs.speech, sarvam: sarvam.speech, http: http.speech };

/** Speech engines that are configured right now. */
export function speechProviders() {
  return Object.values(SPEECH).filter((p) => p.configured());
}

/** "sarvam:priya" -> { provider, voiceId }. Unprefixed = ElevenLabs. */
export function parseVoiceRef(ref) {
  const s = String(ref || '');
  const i = s.indexOf(':');
  if (i > 0 && SPEECH[s.slice(0, i)]) return { provider: SPEECH[s.slice(0, i)], providerId: s.slice(0, i), voiceId: s.slice(i + 1) };
  return { provider: SPEECH.elevenlabs, providerId: 'elevenlabs', voiceId: s };
}
export const voiceRef = (providerId, voiceId) => `${providerId}:${voiceId}`;

/** Audio for `text` in the voice `ref`. Throws a readable error when that engine is not set up. */
export async function synthesize({ voiceRef: ref, text, language }) {
  const { provider, voiceId } = parseVoiceRef(ref);
  if (!provider.configured()) throw err(`${provider.label} voices are not set up on this server`);
  if (provider.languages && !provider.languages.includes(language)) throw err(`${provider.label} does not speak this language. Pick another voice.`, 422);
  return provider.synthesize({ voiceId, text, language });
}

/** Every configured engine's voices, with provider-qualified ids. */
export async function listAllVoices() {
  const out = [];
  const errors = [];
  for (const p of speechProviders()) {
    try {
      for (const v of await p.listVoices()) out.push({ ...v, voice_id: voiceRef(p.id, v.voice_id), provider: p.id, provider_label: p.label, languages: v.languages || p.languages });
    } catch (e) { errors.push(`${p.label}: ${e.message}`); }
  }
  return { voices: out, errors };
}

/** The engine that can design or clone voices (first configured with the feature). */
export const speechWith = (feature) => speechProviders().find((p) => p.features?.[feature]) || null;

/* ---------------- conversation (AI agents) ---------------- */

const CONVERSATION = { elevenlabs: elevenlabs.conversation, http: http.conversation, test: mock.conversation };

/** Who runs a NEW agent: the configured choice, or ElevenLabs. Test mode simulates. */
export function defaultConversationId() {
  if (setupStatus().mode === 'test') return 'test';
  const want = String(process.env.FOLLOWUP_AGENT_PROVIDER || '').toLowerCase();
  if (want && CONVERSATION[want]?.configured()) return want;
  return elevenEnv().apiKey ? 'elevenlabs' : null;
}
export function conversationProvider(id) {
  const p = CONVERSATION[id || defaultConversationId()];
  if (!p) throw err('AI conversations are not set up on this server');
  return p;
}

/* ---------------- telephony, SMS, WhatsApp ---------------- */

export function telephony() { return setupStatus().mode === 'test' ? mock.telephony : exotel.telephony; }
export function sms() { return setupStatus().mode === 'test' ? mock.sms : exotel.sms; }
export function whatsapp() { return setupStatus().mode === 'test' ? mock.whatsapp : exotel.whatsapp; }

/** Can this tier run here? Test mode simulates every tier. */
export function tierAvailable(product, tier) {
  if (!tier) return false;
  if (setupStatus().mode === 'test') return true;
  if (product === 'voice') return !!SPEECH[tier.provider]?.configured();
  if (product === 'agent') return !!CONVERSATION[tier.provider]?.configured();
  return true;
}

/** What is available, for the owner's screens and the admin console. */
export function capabilities() {
  const s = setupStatus();
  return {
    mode: s.mode,
    speech: speechProviders().map((p) => ({ id: p.id, label: p.label, languages: p.languages, features: p.features })),
    conversation: defaultConversationId(),
    telephony: s.mode === 'test' ? 'test' : 'exotel',
  };
}

export { exotel, elevenlabs, sarvam, http, mock };
