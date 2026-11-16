/**
 * MORE -- every part of the workspace on one screen. The phone tab bar has
 * room for a few places; this is where the rest live, so nothing is ever
 * hidden behind a menu you have to remember to open.
 *
 * An owner's is every page grouped the way the sidebar groups them
 * (workspaceNav.js everythingGroups), with a search box: type "fees",
 * "diet" or "QR" and the page it lives on is the one left standing.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import Icon from '../../components/Icon.jsx';
import { ChevronRight } from 'lucide-react';
import { Avatar } from '../../components/UI.jsx';
import ThemeSwitch from '../../components/trainer/ThemeSwitch.jsx';
import { workspaceSections, everythingGroups, tileStyle } from '../../components/trainer/workspaceNav.js';

export default function More() {
  const { user, logout, isOwner } = useAuth();
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const all = isOwner ? everythingGroups() : workspaceSections(false).filter((s) => s.title);
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all
      .map((g) => ({ ...g, items: g.items.filter((it) => `${it.label} ${g.title} ${it.keywords || ''}`.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length);
  }, [isOwner, q]);

  return (
    <div className="ws-settings ws-more">
      <h1 className="t-title">Everything</h1>

      {isOwner && (
        <input className="input w-full" type="search" placeholder="Search any feature" aria-label="Search any feature"
          value={q} onChange={(e) => setQ(e.target.value)} />
      )}

      {groups.map((sec) => (
        <section key={sec.title} className="ws-group-wrap">
          <h2 className="ws-group-title">{sec.title}</h2>
          <div className="ws-group">
            {sec.items.map((it) => (
              <Link key={it.to} to={it.to} className="ws-row ws-row--nav">
                <span className="ws-tile ws-row-icon" style={{ ...tileStyle(it.tint), '--s': '34px' }}><Icon name={it.icon} size={17} strokeWidth={1.8} /></span>
                <span className="ws-row-main"><span className="ws-row-title">{it.label}</span></span>
                <ChevronRight className="ws-row-chev" size={18} strokeWidth={2} aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>
      ))}

      {!groups.length && (
        <p className="t-sub" role="status">Nothing matches &ldquo;{q.trim()}&rdquo;. Try another word, like payments or workouts.</p>
      )}

      <section className="ws-group-wrap">
        <h2 className="ws-group-title">You</h2>
        <div className="ws-group">
          <div className="ws-row ws-row--static">
            <Avatar name={user?.name} size={36} />
            <span className="ws-row-main">
              <span className="ws-row-title">{user?.name}</span>
              <span className="ws-row-sub">{user?.email}</span>
            </span>
          </div>
          <div className="ws-row ws-row--static">
            <span className="ws-row-main"><span className="ws-row-title">Appearance</span></span>
            <ThemeSwitch compact />
          </div>
          <button type="button" className="ws-row ws-row--danger" onClick={logout}>Sign out</button>
        </div>
      </section>
    </div>
  );
}
