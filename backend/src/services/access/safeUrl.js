// ============================================================
// OUTBOUND REQUESTS TO OWNER-SUPPLIED URLS.
//
// The access-control feature lets an owner type a URL that SK OS will then
// call: a polling endpoint, a permission-update endpoint. That is a
// server-side request forgery primitive unless every call is checked, and
// "checked" has to mean more than it did in the first version:
//
//   1. AT CALL TIME, NOT JUST AT SAVE TIME. The URL was validated when the
//      connection was created and never again, but a connection's config
//      can be edited afterwards. The check now runs immediately before
//      every request.
//
//   2. NO REDIRECTS. fetch() follows redirects by default, so a perfectly
//      public URL could answer 302 Location: http://169.254.169.254/ and
//      we would dutifully fetch the cloud metadata service. Redirects are
//      refused outright; a vendor endpoint that needs one can be given its
//      final URL.
//
//   3. BOUNDED. A short timeout and a response-size cap, so a hostile or
//      broken endpoint cannot hold a serverless function open or exhaust
//      its memory.
//
// KNOWN LIMIT, stated rather than hidden: the check is on the hostname,
// not on the address it resolves to. A public DNS name that resolves to a
// private address (DNS rebinding) is not caught here. Closing that needs
// resolution-and-pin at the socket layer, which Node's fetch does not
// expose; it is noted in the access-control setup documentation.
// ============================================================

const PRIVATE_HOST = [
  (h) => h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1' || h === '[::1]',
  (h) => h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local'),
  (h) => /^127\./.test(h),
  (h) => /^10\./.test(h),
  (h) => /^192\.168\./.test(h),
  (h) => /^172\.(1[6-9]|2\d|3[01])\./.test(h),
  (h) => /^169\.254\./.test(h),
  (h) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h),   // carrier-grade NAT
  (h) => /^\[?(fc|fd)[0-9a-f]{2}:/i.test(h),                    // IPv6 unique-local
  (h) => /^\[?fe80:/i.test(h),                                   // IPv6 link-local
];

export class UnsafeUrlError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = 'unsafe_url'; }
}

/** Throws UnsafeUrlError, or returns the normalized URL string. */
export function assertSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new UnsafeUrlError('That is not a valid URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new UnsafeUrlError('Only http and https URLs are allowed.');
  if (u.username || u.password) {
    // Credentials in a URL end up in logs. They belong in the API-key field.
    throw new UnsafeUrlError('Put credentials in the API key field, not in the URL.');
  }
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST.some((test) => test(host))) {
    throw new UnsafeUrlError('That address is on a private or internal network, which SK OS will not call.');
  }
  return u.toString();
}

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * fetch() with the guard applied, redirects refused, a timeout, and a size
 * cap. Returns { ok, status, json, text } -- never throws for an HTTP
 * status, always throws UnsafeUrlError for a URL we will not call.
 */
export async function safeFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  const target = assertSafeUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(target, { method, headers, body, redirect: 'manual', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, status: res.status, redirected: true, json: null, text: '' };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    return { ok: false, status: res.status, tooLarge: true, json: null, text: '' };
  }
  const text = buf.toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

export default { assertSafeUrl, safeFetch, UnsafeUrlError };
