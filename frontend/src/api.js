const TOKEN_KEY = 'pos_token';
const USER_KEY = 'pos_user';
const RETURN_TO_KEY = 'pos_return_to';

// Preserves where a not-logged-in visitor was trying to go (currently:
// a shared-meal preview) through the login/signup flow, so a successful
// auth returns them there instead of the default client home -- without
// auto-completing whatever action they were about to take (Login/SignUp
// consume this to decide WHERE to navigate; they never act on the
// visitor's behalf). sessionStorage, not localStorage: this is a single
// pending navigation for the current tab's session, not a persisted
// preference that should survive after being consumed or across tabs.
export const setReturnTo = (path) => { try { sessionStorage.setItem(RETURN_TO_KEY, path); } catch { /* storage unavailable -- return-to is a convenience, not required */ } };
export const consumeReturnTo = () => {
  try {
    const v = sessionStorage.getItem(RETURN_TO_KEY);
    if (v) sessionStorage.removeItem(RETURN_TO_KEY);
    return v || null;
  } catch { return null; }
};

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const getStoredUser = () => {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
};
export const setSession = ({ token, user }) => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
};
// Enterprise/enrollment routes that change a user's org membership mid-
// session (QR join/verify, trainer join) return a FRESH token but not a
// full user object in the shape /auth/me returns -- see auth.jsx's
// refreshSession(), which pairs this with a re-fetch of /auth/me so the
// stored user object never drifts out of sync with the stored token.
export const setToken = (token) => { localStorage.setItem(TOKEN_KEY, token); };
export const setStoredUser = (user) => { localStorage.setItem(USER_KEY, JSON.stringify(user)); };
export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

// Downloads a binary response (e.g. an invoice PDF) with the auth header
// a plain <a href> download can't carry -- same pattern as admin/'s own
// downloadCsv() helper. api()'s JSON-only parsing can't be reused here.
export async function downloadFile(path, filename) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, { headers, credentials: 'include' });
  if (res.status === 401) {
    clearSession();
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, { ...opts, headers, credentials: 'include' });
  if (res.status === 401) {
    clearSession();
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Fold validate.js's per-field detail into the message itself (not
    // just err.issues below) -- a real bug, found live: every one of this
    // app's many `catch (e) { toast(e.message) }` call sites only ever
    // read `.message`, so a 422 always showed the bare, useless
    // "Validation failed" with zero indication of what was actually
    // wrong or how to fix it -- even though the backend was already
    // sending the real reason (e.g. "calories: Number must be less than
    // or equal to 10000") in `issues`, just never surfaced. One fix here
    // fixes it everywhere, with no per-call-site changes needed.
    //
    // `details` is the SAME class of bug on a second, differently-named
    // field -- found live right after fixing `issues`: POST /me/foods'
    // own validateFoodRecord() check (negative macros, an impossible
    // protein+carb+fat+fiber total, etc.) returns { error: 'Invalid food
    // data', details: [...] }, a 400 with its own array of real reasons
    // that was equally being discarded down to the bare "Invalid food
    // data". Same fold, same reasoning, different key name.
    // `message` before `error` -- a THIRD instance of the same bug class,
    // found live while auditing for more of it: a handful of routes
    // (console.js's refund guard, enterprise.js's downgrade-block/no-
    // recipient/email-failure responses) return { error: 'short_code',
    // message: 'the real human sentence' } -- `error` there is a
    // machine-readable reason, not display text. Every one of the 4 real
    // occurrences in this backend follows that exact shape when both
    // fields are present (confirmed by reading each one, not assumed);
    // EnterpriseBilling.jsx already had its own one-off `e.data?.message
    // || e.message` workaround for exactly this, which this fix makes
    // unnecessary everywhere, not just there. Safe as a global default:
    // when a route sets `error` alone (the overwhelming majority), this
    // falls through to it unchanged.
    const base = data.message || data.error || 'Request failed';
    const issueList = Array.isArray(data.issues) && data.issues.length ? data.issues
      : Array.isArray(data.details) && data.details.length ? data.details
      : null;
    const detail = issueList ? ` — ${issueList.join('; ')}` : '';
    const err = new Error(base + detail);
    err.issues = data.issues;
    err.details = data.details;
    err.status = res.status;
    // Machine-readable failure reason some endpoints attach (e.g. barcode
    // lookup's 'not_found' vs 'network_error' vs 'invalid_barcode') so a
    // caller can branch without parsing the human-readable message text.
    err.reason = data.reason;
    // Generic passthrough of the full error body -- some routes attach
    // extra structured fields beyond message/issues/reason (e.g. the
    // Enterprise downgrade-blocked response's own human-readable
    // `message` plus `activeClients`/`requestedCapacity`). Additive:
    // nothing that only reads err.message/.issues/.reason is affected.
    err.data = data;
    throw err;
  }
  return data;
}
