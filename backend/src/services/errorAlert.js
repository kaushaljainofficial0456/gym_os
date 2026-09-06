// ============================================================
// ERROR ALERTING — optional, generic webhook (Slack/Discord/PagerDuty/a
// custom endpoint all accept a plain JSON POST). Not a vendor SDK
// (Sentry, etc.) deliberately: this repo has no account/DSN for one, and
// a generic webhook needs zero new heavy dependency, works with
// whatever the operator already has (most teams already have a Slack
// incoming-webhook URL), and is trivially swappable for a real APM
// later without an SDK migration.
//
// Same "safe when unconfigured" posture as every other optional
// integration in this codebase (payments, AI providers, S3 storage):
// unset ERROR_ALERT_WEBHOOK_URL and this is a complete no-op, never a
// startup failure. This is what makes the OAuth-style incident this
// pass started from ("nothing paged anyone, a user had to report it")
// closeable without forcing every deployment to sign up for a vendor
// first.
// ============================================================

const WEBHOOK_URL = process.env.ERROR_ALERT_WEBHOOK_URL || '';

export function errorAlertingConfigured() {
  return !!WEBHOOK_URL;
}

/** Fire-and-forget by default (callers in request-handling paths should
 *  NOT await this before responding to the client -- an alert must never
 *  add latency to a real response). The two process-level crash handlers
 *  in index.js are the deliberate exception: they DO await this, with a
 *  short timeout, because the process exits immediately after and an
 *  un-awaited fetch would never get a chance to complete.
 *
 *  `detail` is logged/sent as-is but is expected to already be
 *  sanitized by the caller -- see index.js's own comment on never
 *  including a raw stack trace or request body in what leaves this
 *  process for a third-party webhook. */
export async function sendErrorAlert({ kind, message, path, method, status, reqId }) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` is Slack's/Discord's own expected top-level field for a
      // plain message; a custom/PagerDuty-style endpoint can ignore it
      // and read the structured fields below instead. Sending both
      // shapes in one payload means the same call site works for either
      // without a provider-specific branch.
      body: JSON.stringify({
        text: `[sk-os] ${kind}: ${String(message || '').slice(0, 500)}`,
        service: 'sk-os',
        kind,
        message: String(message || '').slice(0, 500),
        path: path || null,
        method: method || null,
        status: status || null,
        reqId: reqId || null,
        timestamp: new Date().toISOString(),
      }),
      // Never let an unreachable/slow webhook hang the caller -- a
      // 500-handling path already has a client waiting on a response,
      // and the crash handlers are about to exit the process regardless.
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    // Never throws outward -- an alerting failure must never become a
    // second, different failure. Logged so a persistently-broken webhook
    // URL is at least discoverable in the function logs.
    console.error('[errorAlert] webhook delivery failed (non-fatal):', e?.message || e);
  }
}
