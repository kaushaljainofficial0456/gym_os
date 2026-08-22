import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';

const NAV = [
  { to: '/app/trainer', end: true, label: 'Dashboard', icon: 'grid' },
  { to: '/app/trainer/clients', label: 'Clients', icon: 'people' },
  { to: '/app/trainer/workouts', label: 'Workouts', icon: 'dumbbell' },
  { to: '/app/trainer/nutrition', label: 'Nutrition', icon: 'plate' },
  { to: '/app/trainer/alerts', label: 'Alerts', icon: 'alert' },
  { to: '/app/trainer/reports', label: 'Reports', icon: 'chart' },
  { to: '/app/trainer/messages', label: 'Messages', icon: 'mail' },
];

/** Stroke icons, 20px grid — matches the client app's Icon.jsx convention
 *  (never emoji as UI icons: different art per platform, no colour
 *  management, inconsistent baseline). Kept local rather than importing
 *  client/Icon.jsx so this file has no cross-section dependency. */
const ICON_PATHS = {
  grid: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  people: 'M9 8a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 8ZM3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5M17 9a2.6 2.6 0 1 0 0-5.2M15.2 14.6c2.6.2 4.3 2.2 4.3 5.1',
  dumbbell: 'M6.5 8v8M17.5 8v8M3.5 10v4M20.5 10v4M6.5 12h11',
  plate: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  alert: 'M12 3 2 20h20L12 3ZM12 9v5M12 17h.01',
  chart: 'M4 20V13M11 20V6M18 20v-9',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  business: 'M4 21V9l8-5 8 5v12M9 21v-6h6v6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  signOut: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};

function Icon({ name, size = 19 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name] || ICON_PATHS.grid} />
    </svg>
  );
}

export default function TrainerLayout() {
  const { user, logout, isOwner } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const links = isOwner ? [...NAV, { to: '/app/trainer/business', label: 'Business', icon: 'business' }] : NAV;

  /* Closed by default, on every screen size — the sidebar used to sit
     permanently open, eating a fixed 240px on every trainer screen
     whether or not the trainer needed it that moment. One toggle-able
     drawer now serves BOTH desktop and mobile, replacing what were two
     separate nav implementations (a static rail, and an unrelated
     horizontal scroll-tab bar) with one pattern that behaves the same
     way everywhere. */
  const [navOpen, setNavOpen] = useState(false);

  // Route change closes the drawer — opening a page is the natural signal
  // that the trainer is done choosing where to go.
  useEffect(() => { setNavOpen(false); }, [loc.pathname]);

  // Escape closes it too, for keyboard users; a drawer with no keyboard
  // exit is a trap.
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>

      {/* ── persistent top bar: hamburger + wordmark, nothing else ── */}
      <header className="sticky top-0 z-30 flex items-center gap-3 px-4 py-3 border-b backdrop-blur"
        style={{ borderColor: 'var(--line)', background: 'rgb(var(--bg-rgb) / .85)' }}>
        <button
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          aria-expanded={navOpen}
          className="w-9 h-9 grid place-items-center rounded-xl border transition-colors active:scale-95"
          style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}>
          <Icon name="menu" size={18} />
        </button>
        <button className="flex items-center gap-2" onClick={() => nav('/app/trainer')}>
          <img src="/logo.png" alt="SK OS" className="w-7 h-7 rounded-lg object-cover" />
          <span className="font-brand text-[13px] font-bold leading-none">SK OS</span>
          <span className="text-[10px] tracking-[.16em] uppercase" style={{ color: 'var(--faint)' }}>
            {user?.orgName || 'Workspace'}
          </span>
        </button>
      </header>

      {/* ── backdrop, only present while open ── */}
      {navOpen && (
        <div
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
          className="fixed inset-0 z-40 transition-opacity"
          style={{ background: 'rgb(0 0 0 / .38)' }}
        />
      )}

      {/* ── drawer ── */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Trainer navigation"
        className="fixed inset-y-0 left-0 z-50 w-[272px] flex flex-col p-4 border-r transition-transform duration-300"
        style={{
          background: 'var(--panel)',
          borderColor: 'var(--line)',
          transform: navOpen ? 'translateX(0)' : 'translateX(-100%)',
          boxShadow: navOpen ? '24px 0 60px -20px rgb(0 0 0 / .35)' : 'none',
        }}>

        <div className="flex items-center justify-between mb-6 px-1">
          <button className="flex items-center gap-2.5" onClick={() => { nav('/app/trainer'); setNavOpen(false); }}>
            <img src="/logo.png" alt="SK OS" className="w-9 h-9 rounded-xl object-cover" />
            <div className="text-left">
              <div className="font-brand text-[13px] font-bold leading-none">SK OS</div>
              <div className="text-[9px] tracking-[.2em] mt-1 uppercase" style={{ color: 'var(--faint)' }}>
                {user?.orgName || 'Workspace'}
              </div>
            </div>
          </button>
          <button onClick={() => setNavOpen(false)} aria-label="Close menu"
            className="w-8 h-8 grid place-items-center rounded-lg" style={{ color: 'var(--mute)' }}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <nav className="space-y-1 flex-1 overflow-y-auto">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] font-semibold transition-colors ${isActive ? '' : 'hover:opacity-100'}`
              }
              style={({ isActive }) => isActive
                ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                : { color: 'var(--mute)' }}>
              <Icon name={l.icon} size={18} />
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t pt-3 mt-3" style={{ borderColor: 'var(--line)' }}>
          <div className="flex items-center gap-2.5 px-2 mb-2">
            <div className="w-8 h-8 rounded-full grid place-items-center border font-grotesk text-xs font-bold"
              style={{ background: 'var(--panel2)', borderColor: 'var(--line)' }}>
              {user?.name?.[0] || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold font-grotesk truncate">{user?.name}</div>
              <div className="text-[10px]" style={{ color: 'var(--faint)' }}>
                {user?.role === 'GYM_OWNER' ? 'Gym Owner' : user?.role === 'TRAINER' ? 'Trainer' : 'Admin'}
              </div>
            </div>
          </div>
          <button onClick={logout}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[12.5px] font-semibold transition-colors"
            style={{ color: 'var(--mute)' }}>
            <Icon name="signOut" size={16} />
            Sign out
          </button>
        </div>
      </aside>

      <main className="p-4 md:p-8 max-w-7xl mx-auto">
        <div key={loc.pathname} className="anim-fadeUp">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
