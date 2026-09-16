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
// Clears the httpOnly cookie server-side (see routes/auth.js's POST
// /auth/logout -- client-side JS cannot read OR delete an httpOnly cookie
// itself, that's the point of httpOnly, so a real network call is the only
// way "log out" can actually end the session rather than just forgetting
// local UI state).
//
// RETURNS A PROMISE, and every caller that follows it with a navigation
// MUST await it. Root cause of "Sign out doesn't work": this used to fire
// the fetch and immediately drop the promise, and auth.jsx's logout() set
// `location.href` on the very next line -- a full-page navigation cancels
// in-flight requests, so the browser tore the logout POST down before it
// reached the server. The sk_token cookie therefore survived; the reloaded
// page's /auth/me authenticated with it perfectly happily, and App.jsx's
// <GuestOnly> saw an authenticated user sitting on /login and redirected
// straight back into the app -- so clicking "Sign out" looked like it did
// nothing at all.
//
// Never rejects: the state THIS browser controls (the stored user) is
// cleared first and unconditionally, so awaiting this can delay a logout
// on a slow/offline network but can never block or break one.
export const clearSession = () => {
  clearStoredUser();
  return fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    .then(() => {}, () => {});
};

// The local half of clearSession, WITHOUT the server round-trip -- for the
// callers that only need to drop this browser's optimistic UI state and
// know the cookie is already being dealt with (or can't be: no network).
// Exists so a failed /auth/me doesn't fire a SECOND, redundant logout POST
// on top of the one api()'s own 401 branch already sent -- that pair was
// visible in the server log as two POST /auth/logout per anonymous page
// load, one of them pure waste.
export const clearStoredUser = () => { localStorage.removeItem(USER_KEY); };

// Downloads a binary response (e.g. an invoice PDF) -- same pattern as
// admin/'s own downloadCsv() helper. api()'s JSON-only parsing can't be
// reused here. Auth is the httpOnly cookie via credentials: 'include',
// same as api() below -- no Authorization header needed or sent.
export async function downloadFile(path, filename) {
  const res = await fetch('/api' + path, { credentials: 'include' });
  if (res.status === 401) {
    // Awaited for the same reason as api()'s 401 branch above.
    await clearSession();
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

/**
 * `opts.probe` marks a call as a BACKGROUND SESSION-DEPENDENT READ rather
 * than something the user asked for: its 401 means "not signed in", which
 * on a public page is the normal state of the world, not an expired
 * session. Such a call must never redirect.
 *
 * This generalises the hard-coded `/auth/me` exemption below, which was
 * added for exactly this reason and then turned out not to be the only
 * instance. UnitsProvider is mounted OUTSIDE the router (main.jsx), so it
 * reads /me/profile on every page load including the unauthenticated
 * public ones -- and that 401 was sending every anonymous visitor
 * straight to /login from a community invitation, a shared meal, a shared
 * workout or a demo link. Confirmed live before fixing: opening
 * /invite/<code> signed out landed on the login screen, which is the
 * exact bug the /auth/me exemption exists to prevent, on a second path.
 *
 * Deliberately a per-CALL-SITE flag and not a second hard-coded path:
 * /me/profile is ALSO a real user-initiated read (the Profile page), and
 * a 401 there genuinely is an expired session that should go to /login.
 * Which of the two a given call is cannot be told from the path -- only
 * the caller knows.
 */
export async function api(path, opts = {}) {
  const { probe, ...fetchOpts } = opts;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch('/api' + path, { ...fetchOpts, headers, credentials: 'include' });
  if (res.status === 401) {
    // A DEMO that has ended is not an expired login, and must not be
    // treated as one. The backend answers `demo_session_ended` (see
    // auth.js's demo gate) for every request once the 30 minutes are up,
    // once a founder revokes it, or once the prospect finishes -- and the
    // right destination is then the demo's own closing screen with its
    // conversion CTA, not a sign-in form the prospect has no account for.
    // Same status, distinguished only by the body; cloned so the parse
    // here cannot consume the body the caller might still want.
    const demoEnded = await res.clone().json().then((b) => b?.error === 'demo_session_ended', () => false);

    // /auth/me is the SESSION PROBE, not an app action. AuthProvider calls
    // it on every mount -- including on the PUBLIC pages a signed-out
    // visitor is meant to be able to read (a community invitation, a
    // shared workout, a shared meal, a demo link). Two things follow from
    // that, and both matter:
    //
    //   * It must not REDIRECT. Doing so sent every one of those visitors
    //     to the login screen, so an invite link could not be read without
    //     already having an account, which is exactly backwards.
    //   * It must not send POST /auth/logout. A 401 here means the server
    //     holds no session for this browser, so there is nothing to end --
    //     and spending one of the 30-a-minute-per-IP logout requests on
    //     every signed-out page view is enough, behind a gym's shared
    //     Wi-Fi, to get a REAL sign-out refused (auth.spec.js).
    //
    // So a probe drops only the local optimistic user. Any other 401 is a
    // live session expiring mid-use and is cleared properly, awaited so the
    // navigation below cannot cancel the POST mid-flight (see clearSession).
    //
    // `probe === true` generalises what used to be a hard-coded /auth/me
    // test: UnitsProvider reads /me/profile on every page for the same
    // reason, and only the caller knows which kind of read it is.
    const isSessionProbe = probe === true || path === '/auth/me';
    if (isSessionProbe) clearStoredUser();
    else await clearSession();

    if (demoEnded) {
      // A demo ending is decided by WHERE the visitor is, not by whether
      // the call was a probe -- and it has to be, because both readings
      // are wrong on their own:
      //
      //   * Redirecting on every `demo_session_ended`, probe included,
      //     makes a dead demo cookie hijack the whole site. A prospect
      //     who finished one demo and was later sent a second link still
      //     holds the first one's cookie, so opening the new
      //     /demo/<token> fired /auth/me, got this error, and bounced
      //     them off the welcome screen they had just opened to the
      //     ending screen of a demo they had already finished. Their new
      //     link was unusable.
      //
      //   * Exempting probes -- the fix for the case above -- means the
      //     30 minutes running out while they are USING the product
      //     redirects nowhere, /auth/me just fails, and App.jsx's route
      //     guards see an unauthenticated user and send them to a LOGIN
      //     SCREEN they have no account for, instead of the closing
      //     screen with the CTA this whole feature builds toward.
      //
      // Inside /app the demo is what they are doing, so ending it is an
      // interruption worth navigating for. Anywhere else -- a public
      // page, a legal page, the demo's own request and welcome screens --
      // there is nothing to interrupt and the page renders signed-out.
      if (location.pathname.startsWith('/app')) location.href = '/demo-expired';
      throw new Error('Demo session ended');
    }
    if (!isSessionProbe && !location.pathname.startsWith('/login')) location.href = '/login';
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
