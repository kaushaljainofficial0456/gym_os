// ============================================================
// TEST MODE -- the providers, simulated.
//
// Used when the real providers are not configured outside production
// (config.setupStatus().mode === 'test'). Nothing leaves the server.
// Outcomes are realistic and DETERMINISTIC per job (a hash of its id), so
// the owner sees a believable mix of answered / no answer / busy, key
// presses and AI summaries, and a test that seeds known ids can predict
// exactly what happens.
// ============================================================
import crypto from 'node:crypto';

const roll = (seed, salt = '') => crypto.createHash('sha256').update(`${seed}:${salt}`).digest().readUInt32BE(0) / 0xffffffff;

/** A voice-message call's simulated end: status, key pressed, seconds. */
export function simulateMessageCall(jobId) {
  const r = roll(jobId, 'answer');
  if (r < 0.28) return { status: 'no_answer', digits: null, duration: 0 };
  if (r < 0.36) return { status: 'busy', digits: null, duration: 0 };
  const k = roll(jobId, 'key');
  const digits = k < 0.12 ? '1' : k < 0.5 ? '2' : k < 0.54 ? '9' : null;
  return { status: 'completed', digits, duration: 28 + Math.round(roll(jobId, 'dur') * 30) };
}

const AGENT_RESULTS = [
  { outcome: 'coming_back', reason: 'Was travelling for work; will come in on Monday.' },
  { outcome: 'coming_back', reason: 'Had a minor injury, feeling better now.' },
  { outcome: 'renewing', reason: 'Will renew at the front desk this week.' },
  { outcome: 'will_pay', reason: 'Will pay by UPI tonight.' },
  { outcome: 'callback_requested', reason: 'Wants to talk to the owner about the price.' },
  { outcome: 'not_interested', reason: 'Has moved to another area.' },
];

/** An AI conversation's simulated result. */
export function simulateAgentCall(jobId, kind) {
  const r = roll(jobId, 'answer');
  if (r < 0.3) return { status: 'no_answer', duration: 0 };
  const fit = AGENT_RESULTS.filter((x) => (kind === 'payment_due' ? x.outcome !== 'renewing' : kind === 'membership_ending' ? x.outcome !== 'will_pay' : !['renewing', 'will_pay'].includes(x.outcome)));
  const pickd = fit[Math.floor(roll(jobId, 'outcome') * fit.length)];
  return { status: 'completed', duration: 45 + Math.round(roll(jobId, 'dur') * 100), outcome: pickd.outcome, summary: pickd.reason };
}

/** A WhatsApp message's simulated delivery. */
export function simulateWhatsApp(jobId) {
  const r = roll(jobId, 'wa');
  return r < 0.05 ? { status: 'failed' } : r < 0.45 ? { status: 'delivered' } : { status: 'read' };
}

/** An SMS's simulated delivery report. */
export function simulateSms(jobId) {
  return roll(jobId, 'sms') < 0.06 ? { status: 'failed' } : { status: 'delivered' };
}

export const mockRef = (kind, jobId) => `test_${kind}_${jobId}`;

/* ---------------- TEST-mode adapters (see ./index.js): nothing leaves the
   server; each returns its outcome at once as `simulated`, which the engine
   applies exactly like a provider's webhook. ---------------- */

export const telephony = {
  id: 'test',
  async placeMessageCall({ seed }) { return { ref: mockRef('call', seed), simulated: simulateMessageCall(seed) }; },
  parseCallStatus: () => ({ ref: null, status: null, duration: 0, customField: null }),
  parseDigits: (raw) => (/^[0-9]$/.test(String(raw || '')) ? String(raw) : null),
  async fetchCall() { return null; },   // simulated calls always report their outcome at once
};

export const sms = {
  id: 'test',
  async send({ seed }) { return { ref: mockRef('sms', seed), segments: null, simulated: simulateSms(seed) }; },
  parseStatus: () => ({ ref: null, status: null }),
};

export const whatsapp = {
  id: 'test',
  async sendTemplate({ seed }) { return { ref: mockRef('wa', seed), simulated: simulateWhatsApp(seed) }; },
  async createTemplate() { return { status: 'approved' }; },
  async templateStatus() { return { status: 'approved', reason: null }; },
};

export const conversation = {
  id: 'test',
  label: 'Test mode',
  configured: () => true,
  async upsertAgent({ agentId, name }) { return agentId || `test_agent_${crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 10)}`; },
  async startCall({ seed, kind }) { return { ref: mockRef('ai', seed), simulated: simulateAgentCall(seed, kind) }; },
  verifyWebhook: () => false,
  parseResult: () => null,
};
