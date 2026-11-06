/**
 * MORE -- every part of the workspace on one screen, as big tiles. The
 * phone tab bar has room for four places; this is where the rest live, so
 * nothing is ever hidden behind a menu you have to remember to open.
 */
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import Icon from '../../components/Icon.jsx';
import { Avatar, Card } from '../../components/UI.jsx';
import ThemeSwitch from '../../components/trainer/ThemeSwitch.jsx';
import { workspaceSections, tileStyle } from '../../components/trainer/workspaceNav.js';

export default function More() {
  const { user, logout, isOwner } = useAuth();
  const sections = workspaceSections(isOwner).filter((s) => s.title);

  return (
    <div className="space-y-7">
      <h1 className="t-title">Everything</h1>

      {sections.map((sec) => (
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
