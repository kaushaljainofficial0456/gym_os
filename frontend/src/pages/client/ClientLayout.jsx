import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';

const NAV = [
  { to: '/app/client', end: true, label: 'Home', icon: '⌂' },
  { to: '/app/client/workout', label: 'Workout', icon: '⌁' },
  { to: '/app/client/nutrition', label: 'Nutrition', icon: '◍' },
  { to: '/app/client/progress', label: 'Progress', icon: '⇗' },
  { to: '/app/client/profile', label: 'Profile', icon: '●' }
];

export default function ClientLayout() {
  const { user, logout } = useAuth();
  const loc = useLocation();
  return (
    <div className="min-h-screen max-w-lg mx-auto px-4 pb-28 pt-5">
      <header className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="SK OS" className="w-9 h-9 rounded-xl object-cover" />
          <div>
            <div className="font-brand text-[13px] font-bold leading-none">SK OS</div>
            <div className="text-[10px] text-mute mt-1">Hey {user?.name?.split(' ')[0]} 👋</div>
          </div>
        </div>
        <button className="btn-ghost !text-mute !px-2" onClick={logout} aria-label="Sign out">⏻</button>
      </header>

      <div key={loc.pathname} className="anim-fadeUp">
        <Outlet />
      </div>

      <nav className="fixed bottom-0 inset-x-0 z-40 bg-bg/95 backdrop-blur border-t border-line">
        <div className="max-w-lg mx-auto grid grid-cols-5">
          {NAV.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end}
              className={({ isActive }) => `flex flex-col items-center gap-0.5 py-3 font-grotesk text-[9.5px] font-semibold uppercase tracking-wider transition-colors ${isActive ? 'text-gold' : 'text-mute'}`}>
              <span className="text-lg leading-none">{l.icon}</span>
              {l.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
