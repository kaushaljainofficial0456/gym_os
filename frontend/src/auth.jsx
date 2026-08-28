import { createContext, useContext, useEffect, useState } from 'react';
import { api, getStoredUser, setSession, setToken, setStoredUser, clearSession } from './api.js';

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
    setUser(res.user);
    return res.user;
  };

  const register = async (data) => {
    const res = await api('/auth/register', { method: 'POST', body: JSON.stringify(data) });
    setSession(res);
    setUser(res.user);
    return { user: res.user, clientId: res.clientId };
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
    setUser(res.user);
    return res.user;
  };

  const completeOnboarding = async (data) => {
    await api('/auth/complete-onboarding', { method: 'POST', body: JSON.stringify(data) });
  };

  // "Enterprise" on the login screen -- a gym's very first visit, before
  // any account exists. Creates the org + its GYM_OWNER account in one call.
  const setupOrg = async (data) => {
    const res = await api('/auth/setup-org', { method: 'POST', body: JSON.stringify(data) });
    setSession(res);
    setUser(res.user);
    return res.user;
  };

  // "Independent client" on the login screen -- Google Identity Services
  // hands back a signed `credential` (ID token); the backend verifies it
  // and finds-or-creates a CLIENT account under the shared independent org.
  const loginWithGoogle = async (credential) => {
    const res = await api('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) });
    setSession(res);
    setUser(res.user);
    return res.user;
  };

  // "Enterprise" screen's Google option -- same ID-token verification as
  // above, but a SEPARATE backend route (POST /auth/google/enterprise):
  // an existing GYM_OWNER logs straight in; a brand-new signup creates a
  // real org (needs orgName, which Google never supplies -- see
  // SetupOrg.jsx for where that comes from), mirroring setupOrg() above.
  const loginWithGoogleEnterprise = async (credential, orgName) => {
    const res = await api('/auth/google/enterprise', { method: 'POST', body: JSON.stringify({ credential, orgName }) });
    setSession(res);
    setUser(res.user);
    return res.user;
  };

  const logout = () => { clearSession(); setUser(null); location.href = '/login'; };

  // Called after a QR join/renewal/trainer-join completes and the API
  // handed back a FRESH token (org membership just changed mid-session,
  // so the old token's stale claims are no longer good enough -- see
  // enrollment.js's own comment on why each of those routes re-signs).
  // Re-fetches /auth/me under the new token rather than trusting a
  // caller-assembled user object, so this can never drift from what the
  // server actually thinks is true.
  const refreshSession = async (newToken) => {
    if (newToken) setToken(newToken);
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

  return (
    <AuthCtx.Provider value={{ user, ready, login, register, registerTrainer, setupOrg, loginWithGoogle, loginWithGoogleEnterprise, completeOnboarding, refreshSession, logout, isTrainer, isOwner, isClient, isIndependent }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
