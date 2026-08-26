import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMotionValue } from 'framer-motion';
import { useAuth } from '../../auth.jsx';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import CoachBriefDrawer from '../../components/CoachBriefDrawer.jsx';
import OnboardingWizard from '../../components/OnboardingWizard.jsx';
import FeaturePopup from '../../components/FeaturePopup.jsx';
import Icon from '../../components/Icon.jsx';
import DockNavItem from '../../components/DockNavItem.jsx';

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

const PROFILE_MENU = [
  { to: '/app/client/profile', label: 'Profile', icon: 'user' },
  { to: '/app/client/profile', label: 'Measurements', icon: 'ruler' },
  { to: '/app/client/profile', label: 'Goals', icon: 'target' },
  { to: '/app/client/nutrition-tracker', label: 'Nutrition Tracker', icon: 'food' },
  { to: '/app/client/membership', label: 'Membership', icon: 'clipboard' },
  // Was '⚙️'/'❓' -- literal emoji, neither a key in Icon.jsx's PATHS table,
  // same bug class this file's own comment above already flags as fixed
  // at 9 other sites. 'bulb' has no dedicated question-mark glyph in the
  // shared icon set; it's the closest semantic fit ("here's something to
  // know") rather than adding a one-off icon for a single menu row.
  { to: '/app/client/settings', label: 'Settings', icon: 'settings' },
  { to: '/app/client/help', label: 'Help', icon: 'bulb' },
];

export default function ClientLayout() {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  // Infinity, not 0: Dock's distance-from-cursor transform maps
  // out-of-range to baseSize, and 0 would sit inside every item's range
  // on first paint, before any real pointer position ever arrives.
  const bottomNavMouseX = useMotionValue(Infinity);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [featurePopup, setFeaturePopup] = useState(null);
  const dropdownRef = useRef(null);

  // Show feature popup on first visit to each page
  useEffect(() => {
    const featureId = FEATURE_MAP[loc.pathname];
    if (featureId) {
      // Small delay to let the page render first
      const timer = setTimeout(() => setFeaturePopup(featureId), 500);
      return () => clearTimeout(timer);
    }
  }, [loc.pathname]);

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
      <header
        className="sticky top-0 z-40 backdrop-blur-md border-b px-1 pt-3 pb-2"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--bg) 92%, transparent)',
          borderColor: 'var(--line)',
        }}
      >
        <div className="flex items-center justify-between">
          {/* LEFT: Profile button */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              className="flex items-center gap-2 py-1.5 px-2 rounded-xl transition-colors"
              style={{ color: 'var(--ink)' }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(128,128,128,.08)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              aria-expanded={dropdownOpen}
              aria-label="Profile menu"
            >
              <div
                className="w-8 h-8 rounded-full grid place-items-center font-grotesk font-bold text-xs border shrink-0 overflow-hidden"
                style={{ background: user?.avatar ? 'none' : 'linear-gradient(135deg, var(--accent-soft), rgba(200,169,138,.06))', borderColor: 'var(--line)' }}
              >
                {user?.avatar ? (
                  <img src={user.avatar} alt="Profile" className="w-full h-full object-cover" />
                ) : (
                  <span>{user?.name?.[0]?.toUpperCase() || '?'}</span>
                )}
              </div>
              <div className="hidden sm:flex flex-col items-start">
                <span className="font-grotesk text-[11px] font-semibold leading-none" style={{ color: 'var(--ink)' }}>{user?.name?.split(' ')[0]}</span>
                <span className="text-[9px] mt-0.5" style={{ color: 'var(--faint)' }}>Profile</span>
              </div>
              <svg className={`w-3 h-3 transition-transform duration-200 ${dropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none" stroke="var(--faint)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4.5L6 7.5L9 4.5" />
              </svg>
            </button>

            {/* ── PROFILE DROPDOWN ── */}
            {dropdownOpen && (
              <div className="absolute left-0 top-full mt-1 w-56 rounded-2xl border overflow-hidden anim-scaleIn z-50 card" style={{ borderColor: 'var(--line)' }}>
                {/* User info */}
                <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-full grid place-items-center font-grotesk font-bold text-sm border"
                      style={{ background: 'linear-gradient(135deg, var(--accent-soft), rgba(200,169,138,.06))', borderColor: 'var(--line)' }}
                    >
                      {user?.name?.[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-grotesk text-sm font-bold truncate" style={{ color: 'var(--ink)' }}>{user?.name || 'User'}</div>
                      <div className="text-[10px] truncate" style={{ color: 'var(--faint)' }}>{user?.email || ''}</div>
                    </div>
                  </div>
                </div>

                {/* Menu items */}
                <div className="py-1.5">
                  {PROFILE_MENU.map((item, i) => (
                    <button
                      key={i}
                      onClick={() => handleMenuClick(item)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
                      style={{
                        color: 'var(--ink)',
                        background: loc.pathname === item.to && item.label === 'Profile' ? 'rgba(128,128,128,.06)' : 'transparent',
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(128,128,128,.08)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = loc.pathname === item.to && item.label === 'Profile' ? 'rgba(128,128,128,.06)' : 'transparent'}
                    >
                      <span className="w-5 grid place-items-center"><Icon name={item.icon} size={16} /></span>
                      <span className="font-grotesk text-[13px]">{item.label}</span>
                    </button>
                  ))}
                </div>

                {/* Logout */}
                <div className="py-1.5" style={{ borderTop: '1px solid var(--line)' }}>
                  <button
                    onClick={logout}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors text-bad/80 hover:text-bad"
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(248,113,113,.06)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <span className="text-sm w-5 text-center">⏻</span>
                    <span className="font-grotesk text-[13px]">Sign out</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* CENTER: SK OS branding */}
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="SK OS" className="w-7 h-7 rounded-lg object-cover" />
            <span className="font-brand text-[13px] font-bold leading-none tracking-wide" style={{ color: 'var(--ink)' }}>SK OS</span>
          </div>

          {/* RIGHT: Coach notification */}
          <button
            onClick={() => setCoachOpen(true)}
            className="relative flex items-center gap-1.5 py-1.5 px-2.5 rounded-xl transition-colors"
            style={{ color: 'var(--mute)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(128,128,128,.08)'; e.currentTarget.style.color = 'var(--ink)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--mute)'; }}
            aria-label="Coach brief"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
            <span className="hidden sm:block font-grotesk text-[11px]">Coach</span>
            {hasBrief && briefPriority && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-gold anim-pulse-soft" />
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
          onComplete={() => { setOnboardingDone(true); homeFetch.reload(); }}
        />
      )}

      {/* ── MAIN CONTENT ── */}
      <div key={loc.pathname} className="anim-fadeUp pt-4">
        <Outlet context={homeCtx} />
      </div>

      {/* ── FEATURE POPUP ── */}
      {featurePopup && <FeaturePopup featureId={featurePopup} onClose={() => setFeaturePopup(null)} />}

      {/* ── BOTTOM NAV — Dock's spring-physics magnify-on-proximity,
          layered onto the existing full-width tab bar rather than the
          demo's floating pill: this is a persistent mobile tab bar,
          not a desktop dock, and it needs to keep working with zero
          hover capability at all on a touchscreen. ── */}
      <nav className="fixed bottom-0 inset-x-0 z-40 backdrop-blur-xl border-t"
        style={{ backgroundColor: 'color-mix(in srgb, var(--bg) 88%, transparent)', borderColor: 'var(--line)' }}
        onMouseMove={(e) => bottomNavMouseX.set(e.clientX)}
        onMouseLeave={() => bottomNavMouseX.set(Infinity)}>
        <div className="max-w-lg mx-auto grid grid-cols-4 gap-1 px-2 pb-1">
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
