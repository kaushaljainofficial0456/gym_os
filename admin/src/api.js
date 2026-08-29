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
export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
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
    clearSession();
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
    clearSession();
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
