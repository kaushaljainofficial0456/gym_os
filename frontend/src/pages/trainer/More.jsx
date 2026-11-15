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
import { Avatar, Card } from '../../components/UI.jsx';
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
    <div className="space-y-7">
      <h1 className="t-title">Everything</h1>

      {isOwner && (
        <input className="input w-full" type="search" placeholder="Search any feature" aria-label="Search any feature"
          value={q} onChange={(e) => setQ(e.target.value)} />
      )}

      {groups.map((sec) => (
        <section key={sec.title}>
          <div className="ws-section-head"><h2 className="ws-section-title">{sec.title}</h2></div>
          <div className="ws-more-grid">
            {sec.items.map((it) => (
              <Link key={it.to} to={it.to} className="ws-more-tile">
                <span className="ws-action-icon ws-tile" style={tileStyle(it.tint)}><Icon name={it.icon} size={18} strokeWidth={1.8} /></span>
                <span className="min-w-0 leading-tight">{it.label}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      {!groups.length && (
        <p className="t-sub" role="status">Nothing matches &ldquo;{q.trim()}&rdquo;. Try another word, like payments or workouts.</p>
      )}

      <section>
        <div className="ws-section-head"><h2 className="ws-section-title">You</h2></div>
        <Card className="p-4 space-y-4">
          <div className="flex items-center gap-3">
            <Avatar name={user?.name} size={44} />
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold truncate" style={{ color: 'var(--ink)' }}>{user?.name}</div>
              <div className="text-[13px] truncate" style={{ color: 'var(--mute)' }}>{user?.email}</div>
            </div>
          </div>
          <ThemeSwitch />
          <button type="button" className="btn w-full" onClick={logout} style={{ color: 'var(--bad)' }}>Sign out</button>
        </Card>
      </section>
    </div>
  );
}
