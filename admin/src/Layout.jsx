import { NavLink, Outlet, Navigate } from 'react-router-dom';
import { useAuth } from './auth.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/gyms', label: 'Gyms' },
  { to: '/payments', label: 'Payments' },
  { to: '/reconciliation', label: 'Reconciliation' },
  { to: '/support', label: 'Support' },
  { to: '/intelligence/food', label: 'Food Intelligence' },
  { to: '/intelligence/ml', label: 'ML Monitoring' },
  { to: '/risk', label: 'Risk' },
  { to: '/features', label: 'Feature Flags' },
  { to: '/announcements', label: 'Announcements' },
  { to: '/system-health', label: 'System Health' },
  { to: '/audit', label: 'Audit Log' },
];

export default function Layout() {
  const { ready, authed, user, logout } = useAuth();
  if (!ready) return <div className="spinner-row">Loading…</div>;
  if (!authed) return <Navigate to="/login" replace />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          SK OS
          <small>Admin Console</small>
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginTop: 'auto' }}>
          <div className="faint" style={{ padding: '0 8px 8px' }}>{user?.name} · {user?.email}</div>
          <button className="signout" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
