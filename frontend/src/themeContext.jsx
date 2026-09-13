import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

const ThemeContext = createContext({ theme: 'dark', resolved: 'dark', toggle: () => {} });

const STORAGE_KEY = 'sk-os-theme';

/* THREE CHOICES, TWO APPEARANCES.
   `theme` is what the person PICKED -- 'system' | 'light' | 'dark'.
   `resolved` is what is actually on screen, which is only ever light or
   dark. Keeping them apart is what lets "System" exist at all: stored as
   'system', it follows the OS now and keeps following it when the OS
   flips at sunset, instead of freezing to whichever value happened to be
   current when the choice was made.

   Only ever light/dark reaches the root element, so every existing
   selector in theme.css is untouched by this. */
const VALID = ['system', 'light', 'dark'];

function systemPrefers() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  } catch { return 'dark'; }
}

function getInitialTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (VALID.includes(stored)) return stored;
  } catch { /* ignore */ }
  return 'dark'; // default to dark — the premium signature
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(getInitialTheme);
  const [systemTheme, setSystemTheme] = useState(systemPrefers);

  // Follow the OS while 'system' is selected. Without this listener the
  // choice would resolve once at load and then quietly stop being true.
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia('(prefers-color-scheme: light)'); } catch { return undefined; }
    if (!mq) return undefined;
    const onChange = (e) => setSystemTheme(e.matches ? 'light' : 'dark');
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => {
      mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange);
    };
  }, []);

  const resolved = theme === 'system' ? systemTheme : theme;

  useEffect(() => {
    const root = document.documentElement;
    if (resolved === 'dark') {
      root.classList.add('dark');
      root.classList.remove('light');
    } else {
      root.classList.add('light');
      root.classList.remove('dark');
    }
  }, [resolved]);

  // Persist the CHOICE, not the resolution -- storing 'dark' for someone
  // who picked 'system' on a dark OS would silently lose the preference
  // the moment their OS switched.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  /* Toggle flips what is ON SCREEN, which is what a two-state switch
     means to the person using it. From 'system' that necessarily means
     leaving 'system' -- there is no third thing to toggle to. */
  const toggle = useCallback(() => {
    setTheme(() => (resolved === 'dark' ? 'light' : 'dark'));
  }, [resolved]);

  const value = useMemo(
    () => ({ theme, resolved, systemTheme, toggle, setTheme }),
    [theme, resolved, systemTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
