import { useEffect, useState } from 'react';
import { NavLink, Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Icon from './components/Icon.jsx';

const GROUPS = [
  { label: 'Overview', items: [{ to: '/', label: 'Dashboard', end: true, icon: 'grid' }] },
  {
    label: 'Business', items: [
      { to: '/gyms', label: 'Gyms', icon: 'gyms' },
      { to: '/payments', label: 'Payments', icon: 'payments' },
      { to: '/refunds', label: 'Refunds', icon: 'refunds' },
      { to: '/reconciliation', label: 'Reconciliation', icon: 'reconciliation' },
    ],
  },
  {
    label: 'Operations', items: [
      { to: '/support', label: 'Support', icon: 'support' },
      { to: '/intelligence/food', label: 'Food Intelligence', icon: 'food' },
      { to: '/intelligence/ml', label: 'ML Monitoring', icon: 'ml' },
      { to: '/risk', label: 'Risk', icon: 'risk' },
    ],
  },
  {
    label: 'Platform', items: [
      { to: '/features', label: 'Feature Flags', icon: 'flag' },
      { to: '/announcements', label: 'Announcements', icon: 'megaphone' },
      { to: '/system-health', label: 'System Health', icon: 'health' },
      { to: '/audit', label: 'Audit Log', icon: 'audit' },
    ],
  },
];

export default function Layout() {
  const { ready, authed, user, logout } = useAuth();
  const loc = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => { setNavOpen(false); }, [loc.pathname]);

  if (!ready) return <div className="spinner-row">Loading…</div>;
  if (!authed) return <Navigate to="/login" replace />;

  const initials = (user?.name || '?').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="layout">
      <button className="sidebar-toggle" style={{ display: navOpen ? 'none' : 'inline-flex' }}
        onClick={() => setNavOpen(true)} aria-expanded={navOpen} aria-label="Open navigation">
        <Icon name="menu" size={17} />
        Menu
      </button>
      <div className={`sidebar-backdrop ${navOpen ? 'open' : ''}`} onClick={() => setNavOpen(false)} />

      <aside className={`sidebar ${navOpen ? 'open' : ''}`} role="navigation" aria-label="Admin console">
        <div className="brand">
          <span className="mark">SK</span>
          <span className="brand-text">
            SK OS
            <small>Admin Console</small>
          </span>
          <button className="sidebar-toggle" style={{ display: navOpen ? 'inline-flex' : 'none', marginLeft: 'auto', width: 'auto', padding: 8 }}
            onClick={() => setNavOpen(false)} aria-label="Close navigation">
            <Icon name="close" size={16} />
          </button>
        </div>

        {GROUPS.map((g) => (
          <div className="nav-group" key={g.label}>
            <div className="nav-group-label">{g.label}</div>
            <nav>
              {g.items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                  <Icon name={n.icon} size={17} />
                  {n.label}
                </NavLink>
              ))}
            </nav>
          </div>
        ))}

        <div style={{ marginTop: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 8px' }}>
            <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center', fontSize: 10.5, fontWeight: 800, flexShrink: 0 }}>
              {initials}
            </div>
            <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--sidebar-ink-soft)', fontSize: 12 }}>{user?.name}</div>
          </div>
          <button className="signout" onClick={logout}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, justifyContent: 'center', width: '100%' }}>
              <Icon name="signOut" size={15} /> Sign out
            </span>
          </button>
        </div>
      </aside>

      <main className="main">
        <div key={loc.pathname} className="anim-fadeUp">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
