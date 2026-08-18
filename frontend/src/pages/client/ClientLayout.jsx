import { useState, useEffect, useRef, useCallback } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import CoachBriefDrawer from '../../components/CoachBriefDrawer.jsx';

const NAV = [
  { to: '/app/client', end: true, label: 'Home', icon: '⌂' },
  { to: '/app/client/workout', label: 'Workout', icon: '⌁' },
  { to: '/app/client/nutrition', label: 'Nutrition', icon: '◍' },
  { to: '/app/client/progress', label: 'Progress', icon: '⇗' },
];

const PROFILE_MENU = [
  { to: '/app/client/profile', label: 'Profile', icon: '👤' },
  { to: '/app/client/profile', label: 'Measurements', icon: '📏' },
  { to: '/app/client/profile', label: 'Goals', icon: '🎯' },
  { to: '/app/client/settings', label: 'Settings', icon: '⚙️' },
  { to: '/app/client/help', label: 'Help', icon: '❓' },
];

export default function ClientLayout() {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const dropdownRef = useRef(null);

  const briefFetch = useFetch(() => api('/intel/coach/brief'));
  const weeklyFetch = useFetch(() => api('/intel/coach/weekly'));

  const hasBrief = briefFetch.data?.ok;
  const briefPriority = briefFetch.data?.priority;

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
                className="w-8 h-8 rounded-full grid place-items-center font-grotesk font-bold text-xs border shrink-0"
                style={{ background: 'linear-gradient(135deg, var(--accent-soft), rgba(200,169,138,.06))', borderColor: 'var(--line)' }}
              >
                {user?.name?.[0]?.toUpperCase() || '?'}
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
                      <span className="text-sm w-5 text-center">{item.icon}</span>
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

      {/* ── MAIN CONTENT ── */}
      <div key={loc.pathname} className="anim-fadeUp pt-4">
        <Outlet />
      </div>

      {/* ── BOTTOM NAV ── */}
      <nav className="fixed bottom-0 inset-x-0 z-40 backdrop-blur border-t" style={{ backgroundColor: 'color-mix(in srgb, var(--bg) 92%, transparent)', borderColor: 'var(--line)' }}>
        <div className="max-w-lg mx-auto grid grid-cols-4">
          {NAV.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end}
              className={({ isActive }) => `flex flex-col items-center gap-0.5 py-3 font-grotesk text-[9.5px] font-semibold uppercase tracking-wider transition-colors ${isActive ? 'text-gold' : ''}`}
              style={({ isActive }) => ({ color: isActive ? undefined : 'var(--mute)' })}>
              <span className="text-lg leading-none">{l.icon}</span>
              {l.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
