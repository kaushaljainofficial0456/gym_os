import { createContext, useContext, useEffect, useState } from 'react';
import { api, getStoredUser, getToken, setSession, clearSession } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(getStoredUser());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const token = getToken();
      if (!token) { setReady(true); return; }
      try {
        const { user: fresh } = await api('/auth/me');
        // The Admin Console only ever trusts a SUPER_ADMIN session --
        // never a frontend-only role check: every /api/console/* route
        // independently enforces this server-side too (see console.js),
        // this is purely so a non-admin token doesn't sit in a confusing
        // half-logged-in UI state.
        if (fresh.role !== 'SUPER_ADMIN') { clearSession(); if (alive) setUser(null); }
        else if (alive) { setUser(fresh); setSession({ token, user: fresh }); }
      } catch {
        if (alive) setUser(null);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  const login = async (email, password) => {
    const { token, user: loggedInUser } = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (loggedInUser.role !== 'SUPER_ADMIN') {
      clearSession();
      throw new Error('This account does not have Admin Console access.');
    }
    setSession({ token, user: loggedInUser });
    setUser(loggedInUser);
  };

  const logout = () => { clearSession(); setUser(null); };

  return <AuthCtx.Provider value={{ user, ready, authed: !!user, login, logout }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
