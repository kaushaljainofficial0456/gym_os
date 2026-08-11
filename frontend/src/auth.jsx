import { createContext, useContext, useEffect, useState } from 'react';
import { api, getStoredUser, setSession, clearSession } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(getStoredUser());
  const [ready, setReady] = useState(!!getStoredUser());

  useEffect(() => {
    if (getStoredUser()) {
      api('/auth/me').then(({ user: u }) => setUser(u)).catch(() => clearSession()).finally(() => setReady(true));
    } else setReady(true);
  }, []);

  const login = async (email, password) => {
    const res = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setSession(res);
    setUser(res.user);
    return res.user;
  };

  const logout = () => { clearSession(); setUser(null); location.href = '/login'; };

  const isTrainer = user && ['GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'].includes(user.role);
  const isOwner = user && ['GYM_OWNER', 'SUPER_ADMIN'].includes(user.role);
  const isClient = user && user.role === 'CLIENT';

  return (
    <AuthCtx.Provider value={{ user, ready, login, logout, isTrainer, isOwner, isClient }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
