// ============================================================
// DEMO SESSION — the client's side of the 30-minute clock.
//
// EVERYTHING HERE IS PRESENTATION. Not one line of it decides whether
// the demo is still valid: the server re-reads demo_sessions and
// re-checks the deadline on every single API request (backend
// auth.js + services/demo/session.js), so editing this file in a
// browser's devtools, freezing the countdown, or clearing storage buys
// exactly nothing. The countdown is a picture of a number the server
// owns.
//
// The one non-obvious thing this file does is correct for a WRONG DEVICE
// CLOCK. The API hands back its own `serverTime` alongside `expiresAt`;
// subtracting the two gives an offset, and the countdown is rendered
// against `Date.now() + offset` rather than `Date.now()`. A phone an hour
// fast would otherwise show "expired" on a demo with 30 minutes left (and
// a phone an hour slow, the reverse) — the demo would still END at exactly
// the right moment either way, because the server decides that, but the
// number on screen would be a lie.
// ============================================================
import { api } from './api.js';

// Where the raw link token is parked for the duration of the demo, so
// /demo-expired can say WHY it ended and greet the prospect by name.
//
// sessionStorage, not localStorage, and deliberately: it is scoped to the
// tab, dies when the tab does, and never outlives the demo it belongs to.
// Nothing is protected by keeping it — the same token is in the address
// bar, the browser history and whatever message the founder sent it in —
// so this is about not leaving it lying around afterwards, not about
// secrecy. Every access is wrapped: storage throws in a private window
// and returns null after a clear, and a demo must not break either way.
const TOKEN_KEY = 'pos_demo_token';

export const rememberDemoToken = (token) => {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable — the expiry screen falls back to generic copy */ }
};
export const recallDemoToken = () => {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
};
// There is deliberately no forget(): the expiry screen reads this token
// and must keep working across a remount or a reload (see DemoExpired.jsx
// for the bug that taught us so). It expires with the tab, and starting a
// later demo overwrites it.

/** Milliseconds to add to this device's clock to get the server's.
 *  Recomputed every time a response carries `serverTime`. */
let clockOffsetMs = 0;

export function syncClock(serverTime) {
  const server = Date.parse(serverTime || '');
  if (Number.isFinite(server)) clockOffsetMs = server - Date.now();
  return clockOffsetMs;
}

/** "Now", as the server would tell it. */
export const serverNow = () => Date.now() + clockOffsetMs;

/** Milliseconds left, floored at zero. Null when there is no deadline
 *  (the demo has not been started yet). */
export function remainingMs(expiresAt) {
  const end = Date.parse(expiresAt || '');
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - serverNow());
}

/** mm:ss, the format the banner shows. Always two digits on both sides so
 *  the number does not jitter in width as it counts down. */
export function formatRemaining(ms) {
  if (ms == null) return '--:--';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Re-read the session from the server. This is the ONLY thing that can
 *  discover a REVOCATION — a founder pressing "Revoke" changes a database
 *  row, which no amount of client-side arithmetic could ever notice. */
export async function fetchDemoSession() {
  const res = await api('/demo/session');
  syncClock(res.serverTime);
  return res;
}

/** Step into one of the three demo identities. The SERVER picks the
 *  account and signs the new token; this just asks. */
export async function switchPersona(persona) {
  const res = await api('/demo/switch-role', { method: 'POST', body: JSON.stringify({ persona }) });
  if (res?.session?.serverTime) syncClock(res.session.serverTime);
  return res;
}

/** Fire-and-forget feature telemetry (spec 24). Never awaited by a caller
 *  and never allowed to reject: a founder's analytics must not be able to
 *  break, block or slow down the product the prospect is evaluating. */
export function trackDemo(type, data) {
  api('/demo/event', { method: 'POST', body: JSON.stringify({ type, data }) }).catch(() => {});
}

/** End the demo deliberately, from the banner's "Finish" action. */
export async function finishDemo() {
  try { await api('/demo/finish', { method: 'POST' }); } catch { /* already over — the destination is the same */ }
}

/** Where a page sends someone whose demo has ended. Kept here so the
 *  banner, api.js and the pre-demo screen cannot drift apart about it. */
export const DEMO_EXPIRED_PATH = '/demo-expired';
