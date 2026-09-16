// ============================================================
// DEMO NOTIFICATIONS -- the one message this feature sends.
//
// Reuses the email provider this codebase already has
// (services/notifications/emailProvider.js) rather than introducing a
// messaging integration of its own: the spec asks for the former and
// explicitly warns against the latter. There is direct precedent for
// emailing a link that carries a token -- routes/auth.js does exactly
// this for email verification and password reset -- so the posture here
// is the existing one, not a new one.
//
// WhatsApp is deliberately NOT integrated. The founder's actual workflow
// is to copy the link out of the admin console and send it themselves,
// which needs no integration, works today, and keeps a working access
// token out of a third party's message logs. The console shows the link
// for exactly that reason.
// ============================================================
import { sendEmail } from '../notifications/emailProvider.js';

/** Minimal HTML-escaping for the user-supplied strings interpolated into
 *  the body below. The owner name and gym name come from a PUBLIC,
 *  unauthenticated form, so they are the least trustworthy strings in
 *  this system -- they must never reach an email body raw. Same helper
 *  shape as routes/auth.js's own; sufficient for text inside a <p>. */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Tell a prospect their demo is ready.
 *
 * BEST-EFFORT, ALWAYS. Never throws, and the caller must never fail an
 * approval because of it: the founder already has the link on screen at
 * that moment, so a bounced or unconfigured email costs a copy-paste, not
 * the demo. Returns what happened so the console can say "emailed to
 * kirthi@…" or "email not configured — copy the link" rather than
 * leaving the founder guessing whether to send it themselves.
 */
export async function sendDemoLinkEmail({ ownerName, gymName, email }, demoLink, { durationMinutes = 30 } = {}) {
  if (!email || !demoLink) return { ok: false, error: 'missing_recipient_or_link' };
  const name = escapeHtml(String(ownerName || '').trim().split(/\s+/)[0] || 'there');
  const gym = escapeHtml(gymName || 'your gym');
  const subject = `Your Barbell demo for ${String(gymName || 'your gym').slice(0, 60)} is ready`;
  try {
    const res = await sendEmail({
      to: email,
      subject,
      html:
        `<p>Hi ${name},</p>`
        + `<p>Your ${gym} demo of Barbell is ready.</p>`
        + `<p>You'll have ${durationMinutes} minutes to explore the complete platform — members, trainers, `
        + `workouts, nutrition, community, leaderboards and more — in a live gym with real data.</p>`
        + `<p><a href="${demoLink}">Start your demo</a></p>`
        + `<p>The ${durationMinutes} minutes don't start until you open the link and press Start, so there's no rush.</p>`
        + `<p>— Team Barbell</p>`,
      text:
        `Hi ${String(ownerName || '').trim().split(/\s+/)[0] || 'there'},\n\n`
        + `Your ${gymName || 'gym'} demo of Barbell is ready.\n\n`
        + `You'll have ${durationMinutes} minutes to explore the complete platform — members, trainers, `
        + `workouts, nutrition, community, leaderboards and more — in a live gym with real data.\n\n`
        + `Start your demo:\n${demoLink}\n\n`
        + `The ${durationMinutes} minutes don't start until you open the link and press Start, so there's no rush.\n\n`
        + `— Team Barbell`,
    });
    return { ok: !!res?.ok, provider: res?.provider || null, error: res?.error || null };
  } catch (e) {
    // sendEmail already catches its own failures, so reaching here means
    // something unexpected -- logged, never rethrown.
    console.error('[demo] approval email failed (non-fatal):', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
