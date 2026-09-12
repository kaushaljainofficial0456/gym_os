// ============================================================
// ADMIN CONSOLE API CLIENT -- deliberately its own copy, not an import
// from frontend/src/api.js (that would couple two otherwise-separate
// apps' build graphs together for a handful of shared lines). Talks to
// the SAME backend (/api/auth/login for authentication, /api/console/*
// for everything else) -- see backend/src/routes/console.js.
//
// Token storage uses its OWN localStorage key (sk_admin_token), never
// sk_os's own pos_token key -- these are two separate origins/apps in
// production anyway, but keeping the keys distinct even in local dev
// (where both could theoretically run against the same browser) avoids
// any risk of one app accidentally reading the other's session.
// ============================================================
const TOKEN_KEY = 'sk_admin_token';
const USER_KEY = 'sk_admin_user';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const getStoredUser = () => {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
};
export const setSession = ({ token, user }) => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
};
// Clears BOTH halves of an admin session, and both are load-bearing.
//
// The localStorage token is the credential this console SENDS (as a
// Bearer header). The httpOnly sk_token cookie is one it never reads but
// very much HAS: admin logs in through the same POST /api/auth/login as
// the main app, and that route calls setAuthCookie() on every success --
// so the browser is holding an admin cookie whether this code knows it
// or not. api()/downloadCsv() both fetch with credentials: 'include', and
// the backend's requireAuth falls back to req.cookies.sk_token whenever
// no Authorization header is present.
//
// Dropping only localStorage therefore ended the session in the UI while
// leaving it fully alive on the server for the cookie's whole 7-day life
// -- on a SUPER_ADMIN console. Clearing the cookie needs a real request
// (it is httpOnly, so client JS cannot delete it); POST /auth/logout is
// idempotent and needs no auth, so this is safe to call from any state.
//
// Returns a never-rejecting promise: callers that navigate afterwards
// MUST await it, or the navigation cancels the request in flight and the
// cookie survives -- the exact bug this whole change set is fixing. See
// frontend/src/api.js's clearSession for the full write-up.
export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  return fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    .then(() => {}, () => {});
};

// CSV export downloads (Phase 3c) can't go through api() above -- the
// response is text/csv, not JSON, and a file save needs the raw Blob.
// Same auth header, same 401 handling; triggers a normal browser
// download via a throwaway object URL rather than navigating away.
export async function downloadCsv(path, filename) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, { headers, credentials: 'include' });
  if (res.status === 401 && token) {
    // Awaited: the navigation below would otherwise cancel the logout
    // request mid-flight and leave the cookie alive (see clearSession).
    await clearSession();
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error('Export failed');
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
  // Only a 401 on a request that ACTUALLY carried a session token means
  // the session itself expired/was revoked -- e.g. a rejected /auth/login
  // attempt is also a 401 but never had a token to begin with, and was
  // being swallowed into a misleading "Session expired" instead of the
  // real "Invalid email or password" the backend sent back.
  if (res.status === 401 && token) {
    // Awaited for the same reason as downloadCsv's 401 branch above.
    await clearSession();
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Brought in sync with frontend/src/api.js's own fix (see that
    // file's comments for the full reasoning) -- this package's backend
    // routes (console.js) use the same validate() middleware and the
    // same { error: 'code', message: 'human text' } shape on a few
    // routes, so this copy had the identical class of bug: every
    // `catch (e) { toast.error(e.message) }` call site here was equally
    // showing a bare "Validation failed"/error-code with no real reason,
    // even though the backend was already sending one.
    const issueList = Array.isArray(data.issues) && data.issues.length ? data.issues
      : Array.isArray(data.details) && data.details.length ? data.details
      : null;
    const base = data.message || data.error || 'Request failed';
    const detail = issueList ? ` — ${issueList.join('; ')}` : '';
    const err = new Error(base + detail);
    err.issues = data.issues;
    err.details = data.details;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
