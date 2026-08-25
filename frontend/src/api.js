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
export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

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
    const err = new Error(data.error || data.message || 'Request failed');
    err.issues = data.issues;
    err.status = res.status;
    // Machine-readable failure reason some endpoints attach (e.g. barcode
    // lookup's 'not_found' vs 'network_error' vs 'invalid_barcode') so a
    // caller can branch without parsing the human-readable message text.
    err.reason = data.reason;
    throw err;
  }
  return data;
}
