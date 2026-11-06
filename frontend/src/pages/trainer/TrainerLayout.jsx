import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import ThemeSwitch from '../../components/trainer/ThemeSwitch.jsx';
import AnnouncementBanner from '../../components/AnnouncementBanner.jsx';
import DemoBanner from '../../components/DemoBanner.jsx';
import AppTour, { isTourDone } from '../../components/AppTour.jsx';
import GlassTabBar from '../../components/GlassTabBar.jsx';
import Icon from '../../components/Icon.jsx';
import { Avatar } from '../../components/UI.jsx';
import Logo from '../../components/Logo.jsx';
import { workspaceSections, workspaceTabs } from '../../components/trainer/workspaceNav.js';
import '../../components/trainer/workspace.css';

/**
 * THE OWNER & TRAINER WORKSPACE SHELL.
 *
 * Navigation used to be a drawer behind a hamburger at every screen size:
 * on a laptop the whole map of the product was one click away and out of
 * sight, so an owner had to remember where things were instead of seeing
 * them. Now it follows what gym and SaaS dashboards converge on:
 *   - a computer gets a permanent sidebar, grouped by job;
 *   - a phone gets a bottom tab bar for the four most-used places, and
 *     More, a page of every section as big tiles.
 * Both read the same list (workspaceNav.js).
 */
export default function TrainerLayout() {
  const { user, logout, isOwner, isTrainer } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();

  // The workspace face and type scale (theme.css, html.ws). On <html> so
  // dialogs and sheets that portal to <body> pick it up too.
  useEffect(() => {
    document.documentElement.classList.add('ws');
    return () => document.documentElement.classList.remove('ws');
  }, []);

  // ── GUIDED APP TOUR ──
  // Triggered when JoinGym.jsx (trainer QR join) or EnterpriseOnboarding.jsx
  // (owner payment) sets localStorage 'sk-os-start-tour-next' before
  // redirecting here; consumed once so a refresh never restarts it.
  const [tourActive, setTourActive] = useState(false);
  useEffect(() => {
    const flag = localStorage.getItem('sk-os-start-tour-next');
    if (flag) {
      localStorage.removeItem('sk-os-start-tour-next');
      if (!isTourDone(user?.id)) setTourActive(true);
    }
  }, [user?.id]);
  useEffect(() => {
    const startTour = () => setTourActive(true);
    window.addEventListener('sk-os:start-tour', startTour);
    return () => window.removeEventListener('sk-os:start-tour', startTour);
  }, []);

  /* One unread count for the whole workspace. Silent on failure: a badge
     is a convenience, never a reason the navigation fails to render. */
  const unread = useFetch(() => api('/messages/unread'));
  const badges = { messages: unread.data?.total || 0 };
  const reloadUnread = unread.reload;
  useEffect(() => {
    const onRead = () => reloadUnread({ silent: true });
    window.addEventListener('sk-os:messages-read', onRead);
    return () => window.removeEventListener('sk-os:messages-read', onRead);
  }, [reloadUnread]);
  useEffect(() => { reloadUnread({ silent: true }); }, [loc.pathname, reloadUnread]);

  const sections = workspaceSections(isOwner);
  const roleLabel = user?.role === 'GYM_OWNER' ? 'Gym owner' : user?.role === 'TRAINER' ? 'Trainer' : 'Admin';

  return (
    <div className="ws-shell min-h-screen" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
      {/* ── computer: the permanent sidebar ── */}
      <aside className="ws-side" aria-label="Workspace">
        <button className="ws-brand" onClick={() => nav('/app/trainer')}>
          <Logo alt="" aria-hidden="true" className="w-9 h-9 rounded-xl object-cover shrink-0" />
          <span className="min-w-0 text-left">
            <span className="ws-brand-name">Barbell</span>
            <span className="ws-brand-gym">{user?.orgName || 'Workspace'}</span>
          </span>
        </button>

        <nav className="ws-nav" data-tour="trainer-hamburger" aria-label="Main">
          {sections.map((sec, i) => (
            <div key={sec.title || i} className="ws-nav-group">
              {sec.title && <div className="ws-nav-title">{sec.title}</div>}
              {sec.items.filter((it) => it.sidebar !== false).map((it) => (
                <NavLink key={it.to} to={it.to} end={!!it.end} className={({ isActive }) => `ws-nav-item${isActive ? ' is-active' : ''}`}>
                  <Icon name={it.icon} size={19} strokeWidth={1.8} />
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.badgeKey && badges[it.badgeKey] > 0 && <span className="ws-badge">{badges[it.badgeKey]}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="ws-side-foot">
          <ThemeSwitch compact />
          <div className="flex items-center gap-2.5 mt-2.5">
            <Avatar name={user?.name} size={36} />
            <div className="min-w-0 flex-1">
              <div className="ws-user-name truncate">{user?.name}</div>
              <div className="ws-user-role">{roleLabel}</div>
            </div>
            <button onClick={logout} className="ws-icon-btn" aria-label="Sign out" title="Sign out">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ── phone & tablet: a slim top bar ── */}
      <header className="ws-top app-header">
        <button className="flex items-center gap-2.5 min-w-0" onClick={() => nav('/app/trainer')}>
          <Logo alt="" aria-hidden="true" className="w-8 h-8 rounded-lg object-cover shrink-0" />
          <span className="min-w-0 text-left">
            <span className="ws-brand-name">Barbell</span>
            {/* truncate: a long gym name must not push the bar wider than a 360px phone */}
            <span className="ws-brand-gym truncate">{user?.orgName || 'Workspace'}</span>
          </span>
        </button>
        <div className="ml-auto shrink-0"><ThemeSwitch compact /></div>
      </header>

      <main className="ws-main">
        <div className="ws-content">
          {/* Outside the pathname-keyed div so neither remounts (and
              refetches or restarts its countdown) on every navigation. */}
          <DemoBanner />
          <AnnouncementBanner />
          <div key={loc.pathname} className="anim-route">
            <Outlet />
          </div>
        </div>
      </main>

      {/* ── phone & tablet: the bottom tab bar ── */}
      <div className="ws-tabs">
        <GlassTabBar items={workspaceTabs(isOwner)} ariaLabel="Workspace" tourId="trainer-hamburger" />
      </div>

      <AppTour
        active={tourActive}
        userId={user?.id}
        onDone={() => setTourActive(false)}
        isTrainer={isTrainer && !isOwner}
        isOwner={isOwner}
      />
    </div>
  );
}
