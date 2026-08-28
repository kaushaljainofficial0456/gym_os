// ============================================================
// EMAIL PROVIDER ABSTRACTION — mock (default, zero-risk) | resend.
//
// Same shape as services/payments/paymentProvider.js's zero-cost gate,
// deliberately: EMAIL_PROVIDER=resend alone has NO effect without
// RESEND_API_KEY also being set -- an incomplete config silently falls
// back to mock rather than half-configuring a live integration that
// could spam a real client inbox from a misconfigured deployment.
//
// The 'mock' provider is not a stub to delete later -- it's how the
// whole "email this invoice" flow gets built and tested for real,
// deterministically, with zero network calls and zero risk of ever
// emailing a real address by accident before real credentials exist.
//
// RESEND: a single JSON POST (api.resend.com/emails), no SDK dependency
// -- matches this codebase's existing preference for plain fetch() over
// vendor SDKs (see aiProvider.js's own per-vendor call* functions).
// NOT YET LIVE-TESTED -- that needs a real RESEND_API_KEY this
// environment does not have.
// ============================================================

import crypto from 'node:crypto';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'SK OS <onboarding@resend.dev>';
const REQUESTED_PROVIDER = (process.env.EMAIL_PROVIDER || 'mock').toLowerCase();

export function providerName() {
  if (REQUESTED_PROVIDER === 'resend' && RESEND_API_KEY) return 'resend';
  return 'mock';
}

export function isLiveProviderConfigured() {
  return !!RESEND_API_KEY;
}

export function emailConfigSummary() {
  return {
    provider: providerName(),
    requested: REQUESTED_PROVIDER,
    liveConfigured: isLiveProviderConfigured(),
    from: EMAIL_FROM,
  };
}

/* ------------------------------------------------------------------ */
/*  Mock provider — deterministic, in-process, no network call ever    */
/* ------------------------------------------------------------------ */

// In-memory only, by design -- same reasoning as paymentProvider.js's
// _mockOrders: exists purely to make the "email this invoice" flow
// testable/browsable without ever sending a real email.
const _mockSentEmails = [];

async function mockSend({ to, subject, html, text, attachments }) {
  const providerMessageId = 'mock_email_' + crypto.randomBytes(8).toString('hex');
  _mockSentEmails.push({
    providerMessageId, to, subject, html: html || null, text: text || null,
    attachmentFilenames: (attachments || []).map((a) => a.filename),
    sentAt: new Date().toISOString(),
  });
  return { ok: true, provider: 'mock', providerMessageId };
}

/** TEST-ONLY: the mock provider's outbox, newest last. Lets a test (or a
 *  live dev-mode check) confirm an email was "sent" without needing a
 *  real inbox. */
export function _mockOutbox() { return _mockSentEmails.slice(); }
export function _resetMockEmailStateForTests() { _mockSentEmails.length = 0; }

/* ------------------------------------------------------------------ */
/*  Resend provider — real API, gated behind EMAIL_PROVIDER=resend +   */
/*  RESEND_API_KEY.                                                    */
/* ------------------------------------------------------------------ */

async function resendSend({ to, subject, html, text, attachments }) {
  const body = {
    from: EMAIL_FROM,
    to: [to],
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, provider: 'resend', error: `resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const data = await res.json();
  return { ok: true, provider: 'resend', providerMessageId: data.id };
}

/* ------------------------------------------------------------------ */
/*  Public, provider-agnostic API                                      */
/* ------------------------------------------------------------------ */

/** Sends an email. NEVER throws -- always resolves { ok, provider, ... }
 *  so a caller (e.g. "email this invoice") can honestly tell the
 *  requester delivery failed rather than silently pretending success,
 *  the same "never crash, never fake success" posture as this
 *  codebase's other best-effort integrations.
 *  `attachments` is [{ filename, content }] where content is a Buffer
 *  or an already-base64 string -- normalized to base64 here either way
 *  since that's what both the mock outbox and Resend's API expect. */
export async function sendEmail({ to, subject, html, text, attachments } = {}) {
  const provider = providerName();
  if (!to || !subject || (!html && !text)) {
    return { ok: false, provider, error: 'to, subject, and html or text are required' };
  }
  const normalizedAttachments = (attachments || []).map((a) => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
  }));
  try {
    return provider === 'resend'
      ? await resendSend({ to, subject, html, text, attachments: normalizedAttachments })
      : await mockSend({ to, subject, html, text, attachments: normalizedAttachments });
  } catch (e) {
    return { ok: false, provider, error: String(e.message || e) };
  }
}
