/**
 * SECTION TABS -- the pages inside one of the owner's sections, as an
 * Apple segmented control: a soft track, and a raised pill that glides to
 * the page you open (one shared pill, so you see where you went from and
 * to). Real links, one per page, with aria-current on the one you are on.
 *
 * The owner sidebar lists sections, not pages (workspaceNav.js), so the
 * pages of a section with more than one -- Front desk is Attendance, Live
 * crowd, Access control and Join QR codes -- sit here, at the top of each
 * of them. Settings is a list, not tabs (SettingsHub.jsx), so it has none.
 *
 * Shown only on a section's own pages: a client's profile or a
 * tournament's detail screen is a step deeper, and has its own way back.
 * On a narrow phone the track scrolls sideways and keeps the current page
 * in view.
 */
import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { tabPageForPath } from './workspaceNav.js';
import { GLIDE } from './wsMotion.jsx';

export default function SectionTabs({ badges = {} }) {
  const { pathname } = useLocation();
  const at = tabPageForPath(pathname);
  const track = useRef(null);
  const show = !!at && at.hub.pages.length > 1 && at.hub.tabs !== false;

  // Keep the current segment in view when the track scrolls (phones).
  useEffect(() => {
    if (!show) return;
    const el = track.current?.querySelector('[aria-current="page"]');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pathname, show]);

  if (!show) return null;
  return (
    <nav className="ws-seg-wrap" aria-label={`${at.hub.label} pages`}>
      <div className="ws-seg no-scrollbar" ref={track}>
        {at.hub.pages.map((p) => (
          <NavLink key={p.to} to={p.to} end className={({ isActive }) => `ws-seg-item${isActive ? ' is-active' : ''}`}>
            {({ isActive }) => (
              <>
                {isActive && <motion.span layoutId={`ws-seg-${at.hub.key}`} className="ws-seg-thumb" transition={GLIDE} aria-hidden="true" />}
                <span className="ws-seg-label">{p.label}</span>
                {p.badgeKey && badges[p.badgeKey] > 0 && <span className="ws-badge">{badges[p.badgeKey]}</span>}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
