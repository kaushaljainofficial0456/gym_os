import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';

const NAV = [
  { to: '/app/trainer', end: true, label: 'Dashboard', icon: '◧' },
  { to: '/app/trainer/clients', label: 'Clients', icon: '◉' },
  { to: '/app/trainer/workouts', label: 'Workouts', icon: '⌁' },
  { to: '/app/trainer/nutrition', label: 'Nutrition', icon: '◍' },
  { to: '/app/trainer/alerts', label: 'Alerts', icon: '◈' },
  { to: '/app/trainer/reports', label: 'Reports', icon: '▤' },
  { to: '/app/trainer/messages', label: 'Messages', icon: '✉' }
];

export default function TrainerLayout() {
  const { user, logout, isOwner } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const links = isOwner ? [...NAV, { to: '/app/trainer/business', label: 'Business', icon: '₹' }] : NAV;

  return (
    <div className="min-h-screen flex">
      <aside className="hidden md:flex flex-col w-60 shrink-0 border-r border-line p-4 sticky top-0 h-screen">
        <button className="flex items-center gap-2.5 px-2 py-2 mb-6" onClick={() => nav('/app/trainer')}>
          <img src="/logo.png" alt="SK OS" className="w-9 h-9 rounded-xl object-cover" />
          <div className="text-left">
            <div className="font-brand text-[13px] font-bold leading-none">SK OS</div>
            <div className="text-[9px] text-mute tracking-[.2em] mt-1 uppercase">{user?.orgName || 'Workspace'}</div>
          </div>
        </button>
        <nav className="space-y-1 flex-1">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `navlink ${isActive ? 'active' : ''}`}>
              <span className="w-4 text-center text-ember">{l.icon}</span>{l.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line pt-3">
          <div className="flex items-center gap-2.5 px-2 mb-2">
            <div className="w-8 h-8 rounded-full grid place-items-center bg-white/8 border border-line font-grotesk text-xs font-bold">
              {user?.name?.[0] || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold font-grotesk truncate">{user?.name}</div>
              <div className="text-[10px] text-mute">{user?.role === 'GYM_OWNER' ? 'Gym Owner' : user?.role === 'TRAINER' ? 'Trainer' : 'Admin'}</div>
            </div>
          </div>
          <button className="btn-ghost w-full !text-mute" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        {/* mobile top bar */}
        <header className="md:hidden sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-line px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="SK OS" className="w-8 h-8 rounded-lg object-cover" />
            <span className="font-brand text-xs font-bold">SK OS</span>
          </div>
          <button className="btn-ghost !text-mute text-xs" onClick={logout}>Sign out</button>
        </header>
        {/* mobile nav */}
        <nav className="md:hidden sticky top-[53px] z-20 bg-bg/90 backdrop-blur border-b border-line px-3 py-2 flex gap-1 overflow-x-auto">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end}
              className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>{l.label}</NavLink>
          ))}
        </nav>
        <main className="p-4 md:p-8 max-w-7xl mx-auto">
          <div key={loc.pathname} className="anim-fadeUp">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
