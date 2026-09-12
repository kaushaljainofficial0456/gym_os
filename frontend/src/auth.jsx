import { createContext, useContext, useEffect, useState } from 'react';
import { api, getStoredUser, setSession, setStoredUser, clearSession, clearStoredUser } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  // getStoredUser() is only an OPTIMISTIC first-paint value (see api.js's
  // own comment on why USER_KEY exists) -- never proof of a valid session
  // by itself. The effect below ALWAYS re-validates against the server via
  // /auth/me, regardless of whether this cache is present.
  //
  // Root cause of "signed in, but the app forces me through the login
  // flow again": this used to skip the /auth/me check entirely whenever
  // getStoredUser() returned null (cleared localStorage, a private window,
  // a fresh device/browser profile) -- `ready` was set `true` immediately
  // with `user` left `null`, so the app decided "not authenticated"
  // without ever asking the server, even though the httpOnly sk_token
  // cookie (the actual, sole source of truth -- see auth.js's own comment)
  // could still be perfectly valid for up to 7 days. Every route that
  // gates on `authed` (App.jsx's <Require>/<GuestOnly>) inherited that
  // wrong answer. Now this always asks first; `ready` stays false (every
  // gated route shows its loading spinner, not a premature verdict) until
  // the real answer comes back -- matching every other login-adjacent
  // action in this file, which already re-fetches /auth/me rather than
  // trusting a locally-assembled user object.
  const [user, setUser] = useState(getStoredUser());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api('/auth/me')
      .then(({ user: u }) => { setStoredUser(u); setUser(u); })
      // clearStoredUser, not clearSession: whatever made /auth/me fail has
      // already been handled at the network layer -- a 401 went through
      // api()'s own 401 branch, which already POSTed the logout, and a
      // transport failure means a second POST would fail too. All that is
      // left to do here is drop this browser's optimistic cached user.
      .catch(() => { clearStoredUser(); setUser(null); })
      .finally(() => setReady(true));
  }, []);

  const login = async (email, password) => {
    const res = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setSession(res);
    // Re-fetch /auth/me so the user object includes terms status and all
    // server-side fields (the login response is a minimal shape).
    const { user: full } = await api('/auth/me');
    setStoredUser(full);
    setUser(full);
    return full;
  };

  const register = async (data) => {
    const res = await api('/auth/register', { method: 'POST', body: JSON.stringify(data) });
    setSession(res);
    // Re-fetch /auth/me so the user object includes terms status and all
    // server-side fields (the register response is a minimal shape).
    const { user: full } = await api('/auth/me');
    setStoredUser(full);
    setUser(full);
    return { user: full, clientId: res.clientId };
  };

  // Self-serve TRAINER signup -- no gym yet (org_id null, role TRAINER).
  // Distinct from `register` (which is CLIENT-shaped and hits a
  // different backend route) rather than overloading one function with
  // a role switch, matching how setupOrg/loginWithGoogle are already
  // each their own named action for their own distinct account-creation
  // story.
  const registerTrainer = async (data) => {
    const res = await api('/auth/register-trainer', { method: 'POST', body: JSON.stringify(data) });
    setSession(res);
    const { user: full } = await api('/auth/me');
    setStoredUser(full);
    setUser(full);
    return full;
  };

  const completeOnboarding = async (data) => {
    await api('/auth/complete-onboarding', { method: 'POST', body: JSON.stringify(data) });
  };

  // "Enterprise" on the login screen -- a gym's very first visit, before
  // any account exists. Creates the org + its GYM_OWNER account in one call.
  const setupOrg = async (data) => {
    const res = await api('/auth/setup-org', { method: 'POST', body: JSON.stringify(data) });
    setSession(res);
    const { user: full } = await api('/auth/me');
    setStoredUser(full);
    setUser(full);
    return full;
  };

  // "Independent client" on the login screen -- Google Identity Services
  // hands back a signed `credential` (ID token); the backend verifies it
  // and finds-or-creates a CLIENT account under the shared independent org.
  const loginWithGoogle = async (credential) => {
    const res = await api('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) });
    setSession(res);
    const { user: full } = await api('/auth/me');
    setStoredUser(full);
    setUser(full);
    return full;
  };

  // "Enterprise" screen's Google option -- same ID-token verification as
  // above, but a SEPARATE backend route (POST /auth/google/enterprise):
  // an existing GYM_OWNER logs straight in; a brand-new signup creates a
  // real org (needs orgName, which Google never supplies -- see
  // SetupOrg.jsx for where that comes from), mirroring setupOrg() above.
  const loginWithGoogleEnterprise = async (credential, orgName) => {
    const res = await api('/auth/google/enterprise', { method: 'POST', body: JSON.stringify({ credential, orgName }) });
    setSession(res);
    const { user: full } = await api('/auth/me');
    setStoredUser(full);
    setUser(full);
    return full;
  };

  // `await` is load-bearing, not decoration: clearSession()'s POST
  // /auth/logout is the ONLY thing that can clear the httpOnly sk_token
  // cookie, and a full-page navigation cancels requests still in flight.
  // Firing it and navigating on the same tick (what this used to do) meant
  // the request was usually killed before the server saw it, the cookie
  // survived, and the reloaded app re-authenticated the user via /auth/me
  // and bounced them out of /login right back into the app -- i.e. "Sign
  // out" silently did nothing. See api.js's clearSession for the full
  // write-up. clearSession never rejects, so there is no failure path
  // here that can strand the user on a half-logged-out screen.
  //
  // replace(), not href: logging out should not leave the app page the
  // user just left behind as the Back-button destination.
  const logout = async () => {
    await clearSession();
    setUser(null);
    location.replace('/login');
  };

  // Called after a QR join/renewal/trainer-join completes and the API
  // handed back a FRESH token (org membership just changed mid-session,
  // so the old token's stale claims are no longer good enough -- see
  // enrollment.js's own comment on why each of those routes re-signs).
  // F-05: the `newToken` param is accepted (existing callers still pass
  // it) but no longer stored anywhere client-side -- the SAME response
  // that returned it already re-set the httpOnly sk_token cookie
  // server-side (every enrollment.js/auth.js route that hands back a
  // token also calls setAuthCookie), so /auth/me below picks up the new
  // claims automatically via the cookie. Re-fetching rather than trusting
  // a caller-assembled user object means this can never drift from what
  // the server actually thinks is true.
  const refreshSession = async (_newToken) => {
    const { user: u } = await api('/auth/me');
    setStoredUser(u);
    setUser(u);
    return u;
  };

  const isTrainer = user && ['GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'].includes(user.role);
  const isOwner = user && ['GYM_OWNER', 'SUPER_ADMIN'].includes(user.role);
  const isClient = user && user.role === 'CLIENT';
  // /auth/login|register|setup-org|google return camelCase `orgSlug`;
  // /auth/me (re-validated on page refresh) returns the raw DB row's
  // `org_slug` -- a pre-existing inconsistency across this API, not
  // introduced here. Both are checked so this doesn't flip after a refresh.
  const isIndependent = isClient && (user.orgSlug === 'independent' || user.org_slug === 'independent');

  // Legal consent: terms_accepted_at / terms_version come from /auth/me.
  // A user has accepted current terms iff both fields are present and
  // the version matches the required version the backend enforces.
  const REQUIRED_TERMS_VERSION = '1.0';
  const termsAccepted = !!(user?.terms_accepted_at && user?.terms_version === REQUIRED_TERMS_VERSION);

  // Accept terms after user reviews and checks the consent box.
  const acceptTerms = async () => {
    await api('/auth/terms/accept', { method: 'POST', body: JSON.stringify({ version: REQUIRED_TERMS_VERSION }) });
    // Re-fetch /auth/me so the user object carries the updated fields.
    const { user: fresh } = await api('/auth/me');
    setStoredUser(fresh);
    setUser(fresh);
    return fresh;
  };

  return (
    <AuthCtx.Provider value={{ user, ready, login, register, registerTrainer, setupOrg, loginWithGoogle, loginWithGoogleEnterprise, completeOnboarding, refreshSession, logout, isTrainer, isOwner, isClient, isIndependent, termsAccepted, acceptTerms, requiredTermsVersion: REQUIRED_TERMS_VERSION }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
