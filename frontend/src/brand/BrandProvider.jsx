/**
 * BrandProvider -- puts a gym's own look on the whole app.
 *
 * Whose brand: the signed-in person's gym (user.branding, from /auth/me),
 * or, before anyone is signed in, a gym the screen already knows about --
 * a sign-up link with ?gym=<code>, a gym code typed into the sign-up form,
 * a scanned join QR. Signed in always wins; an independent client and a
 * person with no gym get plain Barbell.
 *
 * How: brandTheme.js turns the two colours into dark and light custom
 * properties; this writes them into one <style> scoped to html.gym-brand,
 * sets that class, the browser's theme-color and the tab title, and keeps
 * a copy in localStorage that public/brand-boot.js replays on the next
 * load before the app starts -- so the gym's colours are there from the
 * very first frame.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useTheme } from '../themeContext.jsx';

// The colour maths (brandTheme.js) is its own lazy chunk: most people are
// in no gym with colours and never download it, and for those who are,
// public/brand-boot.js has already painted the cached theme, so nothing
// on screen waits for it.
let themeModule = null;
const loadThemeModule = () => import('./brandTheme.js').then((m) => { themeModule = m; return m; });
const derive = (m, primary, secondary) => {
  const theme = m.deriveBrand({ primary, secondary });
  return theme ? { theme, css: m.brandCss(theme) } : null;
};

const CACHE_KEY = 'sk-os-brand';
const GUEST_KEY = 'sk-os-guest-brand';
// The gym this device last signed in to, so its sign-in screen is still
// the gym's after a sign-out or an expired session -- "Not your gym?" on
// that screen forgets it. Name, code, colours and a logo URL only.
const LAST_GYM_KEY = 'sk-os-last-gym';
const STYLE_ID = 'gym-brand-style';

const noop = () => {};
const BrandCtx = createContext({ brand: null, theme: null, setGuestBrand: noop, setPreviewBrand: noop, forgetLastGym: noop });

const ORIGINAL = typeof document !== 'undefined'
  ? { title: document.title, themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '#0A0A0A' }
  : { title: 'Barbell', themeColor: '#0A0A0A' };

function readGuest() {
  try { return JSON.parse(window.sessionStorage.getItem(GUEST_KEY) || 'null'); } catch { return null; }
}
export function readLastGym() {
  try {
    const b = JSON.parse(window.localStorage.getItem(LAST_GYM_KEY) || 'null');
    return b && b.code && b.gymName ? b : null;
  } catch { return null; }
}

function applyStyle(derived, brand) {
  const root = document.documentElement;
  let el = document.getElementById(STYLE_ID);
  if (!derived) {
    el?.remove();
    root.classList.remove('gym-brand');
    try { window.localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    return;
  }
  const { theme, css } = derived;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
  root.classList.add('gym-brand');
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({
      css, themeColor: { dark: theme.dark.themeColor, light: theme.light.themeColor }, gym: brand?.code || null,
    }));
  } catch { /* storage full or blocked: the theme still applies this session */ }
}

export function BrandProvider({ children }) {
  const { user } = useAuth();
  const { resolved } = useTheme();
  const [guest, setGuest] = useState(readGuest);
  // A screen showing one particular gym while the signed-in person has
  // none yet -- the QR "join this gym" preview. Wins while it is set.
  const [preview, setPreview] = useState(null);

  const brand = preview || (user ? (user.branding || null) : guest);
  const primary = brand?.primary || null;
  const secondary = brand?.secondary || null;
  const key = primary ? `${primary}|${secondary || ''}` : null;
  const [derived, setDerived] = useState(() => (key && themeModule ? { key, ...derive(themeModule, primary, secondary) } : null));
  useEffect(() => {
    if (!key || derived?.key === key) return undefined;
    let alive = true;
    loadThemeModule().then((m) => { if (alive) setDerived({ key, ...derive(m, primary, secondary) }); }).catch(() => {});
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = key && derived?.key === key && derived.theme ? derived : null;
  const theme = current?.theme || null;

  // Before paint, so a page never renders a frame in the wrong colours
  // when the brand changes. While a new theme is still being worked out,
  // whatever is on screen (the boot script's cached copy) stays.
  useLayoutEffect(() => {
    if (!key) applyStyle(null, null);
    else if (current) applyStyle(current, brand);
  }, [key, current]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme ? theme[resolved === 'light' ? 'light' : 'dark'].themeColor : ORIGINAL.themeColor);
  }, [theme, resolved]);

  const gymName = brand?.gymName || null;
  useEffect(() => {
    document.title = gymName ? `${gymName} × Barbell` : ORIGINAL.title;
  }, [gymName]);

  const userBrand = user?.branding || null;
  useEffect(() => {
    if (!userBrand) return;
    try { window.localStorage.setItem(LAST_GYM_KEY, JSON.stringify(userBrand)); } catch { /* ignore */ }
  }, [userBrand]);

  // Once someone is signed in their own gym decides; a brand picked up on
  // the sign-up screen has done its job.
  useEffect(() => {
    if (user && guest) {
      setGuest(null);
      try { window.sessionStorage.removeItem(GUEST_KEY); } catch { /* ignore */ }
    }
  }, [user, guest]);

  const setGuestBrand = useCallback((b) => {
    const next = b && b.code ? b : null;
    setGuest(next);
    try {
      if (next) window.sessionStorage.setItem(GUEST_KEY, JSON.stringify(next));
      else window.sessionStorage.removeItem(GUEST_KEY);
    } catch { /* ignore */ }
  }, []);

  const forgetLastGym = useCallback(() => {
    try { window.localStorage.removeItem(LAST_GYM_KEY); } catch { /* ignore */ }
    setGuestBrand(null);
  }, [setGuestBrand]);

  const value = useMemo(
    () => ({ brand, theme, setGuestBrand, setPreviewBrand: setPreview, forgetLastGym }),
    [brand, theme, setGuestBrand, forgetLastGym],
  );
  return <BrandCtx.Provider value={value}>{children}</BrandCtx.Provider>;
}

/** { brand, theme, setGuestBrand, setPreviewBrand, forgetLastGym }.
 *  `brand` is { gymName, code, primary, secondary, logoUrl } for anyone in
 *  a gym (colours may be null), else null. */
export const useBrand = () => useContext(BrandCtx);
