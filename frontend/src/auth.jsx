import { createContext, useContext, useEffect, useState } from 'react';
import { api, getStoredUser, setSession, setStoredUser, clearSession } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(getStoredUser());
  // If a stored user exists, start unready until the token is validated.
  const [ready, setReady] = useState(!getStoredUser());

  useEffect(() => {
    if (getStoredUser()) {
      api('/auth/me')
        .then(({ user: u }) => setUser(u))
        .catch(() => { clearSession(); setUser(null); })
        .finally(() => setReady(true));
    } else setReady(true);
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

  const logout = () => { clearSession(); setUser(null); location.href = '/login'; };

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
