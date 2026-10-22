/**
 * Where to go once the terms are accepted.
 *
 * A brand-new account is bounced to /legal before anything else (App.jsx),
 * which loses wherever it was headed -- a new gym owner on the way to
 * setting up their gym landed on the dashboard instead. The screen that
 * sends someone onward records the destination here; the terms screen
 * reads it once. Only in-app paths are honoured.
 */
const KEY = 'barbell-after-terms';

export function afterTerms(path) {
  try { sessionStorage.setItem(KEY, path); } catch { /* storage blocked: falls back to /app */ }
}

export function takeAfterTerms() {
  try {
    const p = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return p && p.startsWith('/app/') ? p : '/app';
  } catch { return '/app'; }
}
