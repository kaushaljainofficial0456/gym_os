/**
 * SECTION TABS -- the pages inside one of the owner's eight sections.
 *
 * The owner sidebar lists sections, not pages (workspaceNav.js), so the
 * pages of a section with more than one -- Members is Clients, Attendance,
 * Live crowd and Access control -- sit as tabs along the top of each of
 * them. Real links, one per page, with aria-current on the one you are on.
 *
 * Shown only on a section's own pages: a client's profile or a
 * tournament's detail screen is a step deeper, and has its own way back.
 */
import { NavLink, useLocation } from 'react-router-dom';
import { tabPageForPath } from './workspaceNav.js';

export default function SectionTabs({ badges = {} }) {
  const { pathname } = useLocation();
  const at = tabPageForPath(pathname);
  if (!at || at.hub.pages.length < 2) return null;

  return (
    <nav className="ws-subnav no-scrollbar" aria-label={`${at.hub.label} pages`}>
      {at.hub.pages.map((p) => (
        <NavLink key={p.to} to={p.to} end className={({ isActive }) => `ws-subnav-item${isActive ? ' is-active' : ''}`}>
          {p.label}
          {p.badgeKey && badges[p.badgeKey] > 0 && <span className="ws-badge">{badges[p.badgeKey]}</span>}
        </NavLink>
      ))}
    </nav>
  );
}
