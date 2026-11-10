// ============================================================
// FOLLOW-UPS CONFIG -- which providers are configured, which mode the
// feature runs in, and the signing used on every public callback URL.
//
//   live  Exotel + ElevenLabs keys and a public URL: real calls/messages.
//   test  keys missing, outside production: everything is simulated
//         (providers/mock.js) so the whole flow can be tried end to end.
//   off   keys missing in production: owners can set things up; nothing
//         is ever sent and nothing is simulated (a simulated call in
//         production would be a lie told to a paying owner).
//
// Secrets are read from the environment only. Nothing here is ever sent
// to the browser except booleans saying what is configured.
// ============================================================
import crypto from 'node:crypto';
import { config } from '../../config.js';

const env = (k) => String(process.env[k] || '').trim();

export function exotelEnv() {
  return {
    sid: env('EXOTEL_SID'),
    apiKey: env('EXOTEL_API_KEY'),
    apiToken: env('EXOTEL_API_TOKEN'),
    subdomain: env('EXOTEL_SUBDOMAIN') || 'api.in.exotel.com',
    callerId: env('EXOTEL_CALLER_ID'),          // the platform's own line, for gyms without one
    flowAppId: env('EXOTEL_FLOW_APP_ID'),
    whatsappFrom: env('EXOTEL_WHATSAPP_FROM'),
    wabaId: env('EXOTEL_WABA_ID'),
  };
}

export function elevenEnv() {
  return {
    apiKey: env('ELEVENLABS_API_KEY'),
    agentPhoneId: env('ELEVENLABS_AGENT_PHONE_ID'), // the platform line's id in ElevenLabs
    webhookSecret: env('ELEVENLABS_WEBHOOK_SECRET'),
    base: env('ELEVENLABS_API_BASE') || 'https://api.elevenlabs.io',
  };
}

/** Where providers call us back. Same host as the app on Vercel. */
export function publicBase() {
  return (env('PUBLIC_BASE_URL') || config.frontendUrl || '').replace(/\/+$/, '');
}

const isHttpsPublic = (u) => /^https:\/\//.test(u) && !/localhost|127\.0\.0\.1/.test(u);

/** What is configured, as booleans, plus the mode. Safe to show an owner. */
export function setupStatus() {
  const ex = exotelEnv();
  const el = elevenEnv();
  const wanted = env('FOLLOWUP_PROVIDER').toLowerCase();
  const calls = !!(ex.sid && ex.apiKey && ex.apiToken && ex.flowAppId);
  const voice = !!(el.apiKey || env('SARVAM_API_KEY') || env('FOLLOWUP_SPEECH_HTTP_URL'));
  const base = isHttpsPublic(publicBase());
  const live = wanted === 'exotel' && calls && voice && base;
  const production = config.nodeEnv === 'production';
  const mode = live ? 'live' : (production ? 'off' : 'test');
  const missing = [];
  if (wanted !== 'exotel') missing.push('FOLLOWUP_PROVIDER=exotel');
  if (!calls) missing.push('Exotel account and call flow');
  if (!voice) missing.push('a speech provider (ElevenLabs, Sarvam or your own)');
  if (!base) missing.push('PUBLIC_BASE_URL (https)');
  return {
    mode,
    missing: live ? [] : missing,
    voicePreviews: voice,                           // "Hear it" works whenever ElevenLabs is set
    agentCalls: live && !!(el.webhookSecret || env('FOLLOWUP_AGENT_HTTP_URL')), // AI conversations also need their result webhook
    whatsapp: live,                                 // the sender is per gym (or the platform's); checked when sending
    platformLine: !!ex.callerId,
  };
}

export const followupMode = () => setupStatus().mode;

/* ---- signing: every public URL we hand a provider carries a MAC ---- */
const signingKey = () => crypto.createHmac('sha256', String(config.jwtSecret || 'dev')).update('followups:v1').digest();

export function sign(value) {
  return crypto.createHmac('sha256', signingKey()).update(String(value)).digest('base64url').slice(0, 22);
}

export function verify(value, mac) {
  if (!value || !mac) return false;
  const a = Buffer.from(sign(value));
  const b = Buffer.from(String(mac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** `<jobId>.<mac>` -- what goes in Exotel's CustomField (max 128 chars). */
export const jobToken = (jobId) => `${jobId}.${sign(jobId)}`;
export function readJobToken(token) {
  const s = String(token || '').replace(/^"+|"+$/g, '').trim();
  const dot = s.lastIndexOf('.');
  if (dot < 1) return null;
  const jobId = s.slice(0, dot);
  return verify(jobId, s.slice(dot + 1)) ? jobId : null;
}

export default { exotelEnv, elevenEnv, publicBase, setupStatus, followupMode, sign, verify, jobToken, readJobToken };
