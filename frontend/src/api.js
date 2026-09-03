// F-05 hardening: the JWT itself is NEVER persisted client-side anymore --
// the backend's httpOnly sk_token cookie (set on every login/register/
// google/setup-org/switch-gym/enrollment response -- see auth.js's
// setAuthCookie, called by every one of those routes) is the sole
// authentication mechanism from here on. api()/downloadFile() below rely
// entirely on `credentials: 'include'` sending that cookie; neither reads
// nor sends an Authorization header anymore. USER_KEY still persists the
// non-sensitive profile object (name/role/org -- never a bearer
// credential) purely so the UI can render an optimistic "logged in"
// state on first paint before /auth/me's cookie-authenticated response
// comes back; even a full XSS reading it gains only display data, not a
// way to authenticate as this user anywhere.
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

export const getStoredUser = () => {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
};
// `token` is intentionally accepted-and-ignored (not destructured out) --
// every caller still passes the login/register/etc. response object
// wholesale, and that response DOES still carry a `token` field (the
// backend hands it back for any non-browser caller of these same routes);
// this app just no longer does anything with it, the cookie already set
// alongside it is what matters now.
export const setSession = ({ user }) => {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
};
export const setStoredUser = (user) => { localStorage.setItem(USER_KEY, JSON.stringify(user)); };
// Best-effort: clears the httpOnly cookie server-side (see routes/auth.js's
// POST /auth/logout -- client-side JS cannot read OR delete an httpOnly
// cookie itself, that's the point of httpOnly, so a real network call is
// the only way "log out" can actually end the session rather than just
// forgetting local UI state). Never blocks or throws on failure -- a
// logout must always clear what THIS browser can control (the stored
// user, immediately below) even if the network call itself fails.
export const clearSession = () => {
  fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  localStorage.removeItem(USER_KEY);
};

// Downloads a binary response (e.g. an invoice PDF) -- same pattern as
// admin/'s own downloadCsv() helper. api()'s JSON-only parsing can't be
// reused here. Auth is the httpOnly cookie via credentials: 'include',
// same as api() below -- no Authorization header needed or sent.
export async function downloadFile(path, filename) {
  const res = await fetch('/api' + path, { credentials: 'include' });
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
  const res = await fetch('/api' + path, { ...opts, headers, credentials: 'include' });
  if (res.status === 401) {
    clearSession();
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || 'Request failed');
    err.issues = data.issues;
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
