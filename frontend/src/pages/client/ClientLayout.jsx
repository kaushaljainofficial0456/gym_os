import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMotionValue } from 'framer-motion';
import { useAuth } from '../../auth.jsx';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import CoachBriefDrawer from '../../components/CoachBriefDrawer.jsx';
import OnboardingWizard from '../../components/OnboardingWizard.jsx';
import FeaturePopup from '../../components/FeaturePopup.jsx';
import AppTour, { isTourDone } from '../../components/AppTour.jsx';
import Icon from '../../components/Icon.jsx';
import DockNavItem from '../../components/DockNavItem.jsx';
import AnnouncementBanner from '../../components/AnnouncementBanner.jsx';
import { Avatar } from '../../components/UI.jsx';

// Map route paths to feature IDs for first-time popups
const FEATURE_MAP = {
  '/app/client': 'home',
  '/app/client/workout': 'workout',
  '/app/client/nutrition': 'nutrition',
  '/app/client/progress': 'progress',
};

// MERGE FIX: these were unicode glyphs ('⌂', '⌁', '◍', '⇗') left over from
// before the bottom nav switched to <Icon name={l.icon}>. None of those
// glyphs are keys in Icon.jsx's PATHS table, so all four nav icons would
// silently render as the generic fallback glyph — same bug class already
// fixed at 9 other sites (see UI.jsx), just missed here.
const NAV = [
  { to: '/app/client', end: true, label: 'Home', icon: 'home' },
  { to: '/app/client/workout', label: 'Workout', icon: 'strength' },
  { to: '/app/client/nutrition', label: 'Nutrition', icon: 'food' },
  { to: '/app/client/progress', label: 'Progress', icon: 'trending' },
];

/* Grouped, because a flat list of eight rows makes the reader scan all
   eight to find one. The groups are "who I am" / "what I use" / "how it
   behaves", which is also the order people look for them in.
   ── 'Measurements' and 'Goals' used to point at bare /app/client/profile,
   the same destination as 'Profile' itself: three rows, one landing place,
   so two of them silently lied about where they'd take you. Profile drives
   its panels off internal `activeSection` state, so they now carry the
   section in the URL (?section=…) and Profile opens it directly. */
const PROFILE_MENU = [
  [
    { to: '/app/client/profile', label: 'Profile', icon: 'user' },
    { to: '/app/client/profile?section=metrics', label: 'Measurements', icon: 'ruler' },
    { to: '/app/client/profile?section=goal', label: 'Goals', icon: 'target' },
  ],
  [
    { to: '/app/client/nutrition-tracker', label: 'Nutrition tracker', icon: 'food' },
    { to: '/app/client/membership', label: 'Membership', icon: 'clipboard' },
    { to: '/app/client/community', label: 'Community', icon: 'users' },
  ],
  [
    { to: '/app/client/settings', label: 'Settings', icon: 'settings' },
    // Was '⚙️'/'❓' -- literal emoji, neither a key in Icon.jsx's PATHS
    // table, same bug class this file's own comment above already flags as
    // fixed at 9 other sites. 'bulb' has no dedicated question-mark glyph
    // in the shared icon set; it's the closest semantic fit ("here's
    // something to know") rather than adding a one-off icon for one row.
    { to: '/app/client/help', label: 'Help', icon: 'bulb' },
  ],
];

export default function ClientLayout() {
  const { user, logout, isIndependent } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  // Infinity, not 0: Dock's distance-from-cursor transform maps
  // out-of-range to baseSize, and 0 would sit inside every item's range
  // on first paint, before any real pointer position ever arrives.
  const bottomNavMouseX = useMotionValue(Infinity);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [featurePopup, setFeaturePopup] = useState(null);
  // Guided first-run tour (see AppTour.jsx): activated only in the session
  // where OnboardingWizard completes — i.e. genuinely brand-new users.
  // Returning users' onboarding_completed is already true server-side, so
  // this state never flips for them (TEST 10: existing users log straight in).
  const [tourActive, setTourActive] = useState(false);
  const dropdownRef = useRef(null);

  // Help page's "Replay app tour" button — same activation path, no URL hacks.
  useEffect(() => {
    const startTour = () => setTourActive(true);
    window.addEventListener('sk-os:start-tour', startTour);
    return () => window.removeEventListener('sk-os:start-tour', startTour);
  }, []);

  // Show feature popup on first visit to each page. Suppressed while the
  // tour drives navigation — otherwise its modal would collide with the
  // tour spotlight on every step that lands on a FEATURE_MAP route.
  useEffect(() => {
    const featureId = FEATURE_MAP[loc.pathname];
    if (featureId && !tourActive) {
      // Small delay to let the page render first
      const timer = setTimeout(() => setFeaturePopup(featureId), 500);
      return () => clearTimeout(timer);
    }
  }, [loc.pathname, tourActive]);

  const briefFetch = useFetch(() => api('/intel/coach/brief'));
  const weeklyFetch = useFetch(() => api('/intel/coach/weekly'));
  const homeFetch = useFetch(() => api('/tracking/me/home'));

  const hasBrief = briefFetch.data?.ok;
  const briefPriority = briefFetch.data?.priority;

  // Onboarding state — server-side check via /me/home
  const clientData = homeFetch.data?.client;
  const needsOnboarding = clientData && !clientData.onboardingCompleted;
  const [onboardingDone, setOnboardingDone] = useState(false);

  // ClientLayout persists across client-page navigation (Outlet swaps only
  // the page below it), so /tracking/me/home is fetched once here and handed
  // down via Outlet context — every child page used to call
  // useFetch(() => api('/tracking/me/home')) itself, doubling that request
  // on every single navigation. Memoized on the fetch's own fields (not on
  // homeFetch's render-fresh object identity) so layout-only re-renders
  // (profile dropdown, coach drawer, feature popup) don't push a new context
  // value and re-render whichever child page is mounted.
  const homeCtx = useMemo(
    () => ({ data: homeFetch.data, loading: homeFetch.loading, error: homeFetch.error, reload: homeFetch.reload }),
    [homeFetch.data, homeFetch.loading, homeFetch.error, homeFetch.reload]
  );

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  useEffect(() => {
    setDropdownOpen(false);
  }, [loc.pathname]);

  const handleMenuClick = useCallback((item) => {
    setDropdownOpen(false);
    nav(item.to);
  }, [nav]);

  return (
    <div className="min-h-screen max-w-lg mx-auto px-4 pb-28 pt-0">
      {/* ── TOP HEADER ── */}
      <header className="app-header px-1">
        <div className="flex items-center justify-between gap-2">
          {/* LEFT: Profile button */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              data-tour="header-profile"
              className="chrome-btn gap-2 py-1.5 px-2"
              aria-expanded={dropdownOpen}
              aria-haspopup="menu"
              aria-label="Profile menu"
            >
              <Avatar name={user?.name} src={user?.avatar} size={30} />
              <div className="hidden sm:flex flex-col items-start">
                <span className="font-grotesk text-[11px] font-semibold leading-none" style={{ color: 'var(--ink)' }}>{user?.name?.split(' ')[0]}</span>
                <span className="text-[9px] mt-0.5" style={{ color: 'var(--faint)' }}>Profile</span>
              </div>
              <svg className={`w-3 h-3 shrink-0 transition-transform duration-200 ${dropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 4.5L6 7.5L9 4.5" />
              </svg>
            </button>

            {/* ── PROFILE DROPDOWN ── */}
            {dropdownOpen && (
              <div role="menu" className="absolute left-0 top-full mt-1.5 w-60 overflow-hidden anim-scaleIn z-50 card !p-0"
                style={{ borderRadius: 'var(--r-lg)', boxShadow: 'var(--e-3)' }}>
                {/* Identity — who you're signed in as, before any action */}
                <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: '1px solid var(--line)' }}>
                  <Avatar name={user?.name} src={user?.avatar} size={38} />
                  <div className="flex-1 min-w-0">
                    <div className="font-grotesk text-[13px] font-bold truncate" style={{ color: 'var(--ink)' }}>{user?.name || 'User'}</div>
                    <div className="text-[10.5px] truncate mt-0.5" style={{ color: 'var(--faint)' }}>{user?.email || ''}</div>
                  </div>
                </div>

                {PROFILE_MENU.map((group, gi) => (
                  <div key={gi} className="py-1" style={gi > 0 ? { borderTop: '1px solid var(--line)' } : undefined}>
                    {group.map((item) => (
                      <button
                        key={item.label}
                        role="menuitem"
                        onClick={() => handleMenuClick(item)}
                        className="menu-row"
                        aria-current={loc.pathname + loc.search === item.to ? 'page' : undefined}
                      >
                        <span className="menu-icon"><Icon name={item.icon} size={16} /></span>
                        {item.label}
                      </button>
                    ))}
                  </div>
                ))}

                <div className="py-1" style={{ borderTop: '1px solid var(--line)' }}>
                  <button role="menuitem" onClick={logout} className="menu-row menu-row-danger">
                    {/* Was '⏻' — a Unicode power symbol next to eight real
                        SVG icons, rendering at a different weight and
                        baseline than every row above it. */}
                    <span className="menu-icon">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                      </svg>
                    </span>
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* CENTER: SK OS branding */}
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="" aria-hidden="true" className="w-7 h-7 rounded-lg object-cover" />
            <span className="font-brand text-[13px] font-bold leading-none" style={{ color: 'var(--ink)', letterSpacing: '.02em' }}>SK OS</span>
          </div>

          {/* RIGHT: Coach notification */}
          <button
            onClick={() => setCoachOpen(true)}
            className="chrome-btn relative gap-1.5 py-1.5 px-2.5"
            aria-label={hasBrief && briefPriority ? 'Coach brief — new' : 'Coach brief'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
            <span className="hidden sm:block font-grotesk text-[11px] font-medium">Coach</span>
            {hasBrief && briefPriority && (
              <span aria-hidden="true" className="absolute top-0.5 right-1 w-2 h-2 rounded-full anim-pulse-soft"
                style={{ background: 'var(--accent)', boxShadow: '0 0 0 2px rgb(var(--bg-rgb))' }} />
            )}
          </button>
        </div>
      </header>

      {/* ── COACH BRIEF DRAWER ── */}
      <CoachBriefDrawer
        open={coachOpen}
        onClose={() => setCoachOpen(false)}
        briefFetch={briefFetch}
        weeklyFetch={weeklyFetch}
      />

      {/* ── ONBOARDING WIZARD ── */}
      {needsOnboarding && !onboardingDone && (
        <OnboardingWizard
          open={true}
          initialName={user?.name || ''}
          onComplete={() => {
            setOnboardingDone(true);
            // silent: true -- avoids a spinner flash on the exact frame
            // the app tour is about to start, for the same reason as
            // every other reload() call fixed this pass.
            homeFetch.reload({ silent: true });
            // Setup just finished for a brand-new user → start the guided
            // app tour automatically (skipped/completed tours are remembered
            // per-user by AppTour and never auto-start again).
            if (!isTourDone(user?.id)) setTourActive(true);
          }}
        />
      )}

      {/* ── GUIDED APP TOUR ── */}
      <AppTour
        active={tourActive}
        userId={user?.id}
        onDone={() => setTourActive(false)}
        isClient={!isIndependent}
        isIndependent={isIndependent}
      />

      {/* ── MAIN CONTENT ── */}
      <div key={loc.pathname} className="anim-fadeUp pt-4">
        <AnnouncementBanner />
        <Outlet context={homeCtx} />
      </div>

      {/* ── FEATURE POPUP ── */}
      {featurePopup && <FeaturePopup featureId={featurePopup} onClose={() => setFeaturePopup(null)} />}

      {/* ── BOTTOM NAV — Dock's spring-physics magnify-on-proximity,
          layered onto the existing full-width tab bar rather than the
          demo's floating pill: this is a persistent mobile tab bar,
          not a desktop dock, and it needs to keep working with zero
          hover capability at all on a touchscreen. ── */}
      <nav className="app-tabbar" aria-label="Main"
        onMouseMove={(e) => bottomNavMouseX.set(e.clientX)}
        onMouseLeave={() => bottomNavMouseX.set(Infinity)}>
        <div data-tour="bottom-nav" className="max-w-lg mx-auto grid grid-cols-4 gap-1 px-2 pb-1">
          {NAV.map((l) => (
            <DockNavItem key={l.to} to={l.to} end={l.end} label={l.label}
              icon={<Icon name={l.icon} size={20} />}
              mouseX={bottomNavMouseX} baseSize={20} magnifySize={26} distance={80}
              spring={{ mass: 0.1, stiffness: 200, damping: 14 }} />
          ))}
        </div>
      </nav>
    </div>
  );
}
