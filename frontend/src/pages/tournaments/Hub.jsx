/**
 * TOURNAMENTS: home. What is live, what you can enter, what you are in, and
 * what you have won. Shared by clients, trainers and owners.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check, Compass, Crown, Dumbbell, Plus, Radio, ScanLine, Search, Trophy, Users, X,
} from './icons.jsx';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState, PageSkeleton, Toast } from '../../components/UI.jsx';
import QrScanner from '../../components/QrScanner.jsx';
import TournamentIdentity from '../../components/TournamentIdentity.jsx';
import { TSheet } from './DetailSheets.jsx';
import { EVENT_COLORS, eventIcon, Hero, PhaseChip, RailItem, themeClass, useTournamentBase } from './shared.jsx';

function Ticket({ t, onOpen }) {
  const when = t.starts_at ? new Date(t.starts_at) : null;
  const full = t.capacity ? t.entrants >= t.capacity : false;
  return (
    <button type="button" className={`tr-ticket ${themeClass(t.theme)}`} onClick={() => onOpen(t)}>
      <span className="tr-ticket-stub">
        {when ? (
          <>
            <small>{when.toLocaleDateString(undefined, { weekday: 'short' })}</small>
            <b>{when.getDate()}</b>
            <small>{when.toLocaleDateString(undefined, { month: 'short' })}</small>
          </>
        ) : <Trophy size={26} aria-hidden="true" />}
      </span>
      <span className="tr-ticket-main">
        <span className="tr-ticket-top">
          <PhaseChip phase={t.phase} />
          {t.my_host_role && <span className="tr-chip tr-chip-host"><Crown size={11} />Hosting</span>}
          {!t.my_host_role && t.my_entry === 'active' && <span className="tr-chip tr-chip-host"><Check size={11} />Entered</span>}
          {t.my_entry === 'pending' && <span className="tr-chip">Requested</span>}
          {t.audience === 'staff' && <span className="tr-chip">Staff only</span>}
        </span>
        <span className="tr-ticket-name">{t.name}</span>
        {(t.gym_name || t.venue) && <span className="tr-ticket-sub tr-ellipsis">{[t.gym_name, t.venue].filter(Boolean).join(' · ')}</span>}
        <span className="tr-ticket-foot">
          <span className="tr-ticket-events" aria-label={t.events.map((e) => e.name).join(', ')}>
            {t.events.slice(0, 5).map((e, i) => {
              const Icon = eventIcon(e);
              return <Icon key={e.id} size={18} strokeWidth={2.2} aria-hidden="true" style={{ color: EVENT_COLORS[i % EVENT_COLORS.length][0] }} />;
            })}
            {t.events.length > 5 && <span>+{t.events.length - 5}</span>}
          </span>
          <span className="tr-ticket-count tr-num" style={full ? { color: 'var(--t-accent)' } : undefined}>
            {t.capacity ? <span className="tr-spots" aria-hidden="true"><i style={{ width: `${Math.min(100, (t.entrants / t.capacity) * 100)}%` }} /></span> : <Users size={14} aria-hidden="true" />}
            {t.entrants}{t.capacity ? `/${t.capacity}` : ''}
          </span>
        </span>
      </span>
    </button>
  );
}

export default function Hub() {
  const nav = useNavigate();
  const base = useTournamentBase();
  const hub = useFetch(() => api('/tournaments'));
  const shelf = useFetch(() => api('/tournaments/trophies'));
  const [tab, setTab] = useState(null);
  const [query, setQuery] = useState('');
  const [scan, setScan] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(null);
  const [identity, setIdentity] = useState(false);

  // Live tournaments move on their own, so the list keeps up while it is open.
  const { reload } = hub;
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) reload({ silent: true }); }, 30000);
    return () => clearInterval(id);
  }, [reload]);

  const groups = useMemo(() => {
    const d = hub.data;
    if (!d) return null;
    const everything = [...d.mine, ...d.discover];
    return {
      live: everything.filter((t) => t.status === 'live'),
      discover: d.discover.filter((t) => t.status === 'upcoming'),
      mine: d.mine.filter((t) => t.status !== 'completed'),
      results: [...d.mine.filter((t) => t.status === 'completed'), ...d.results],
    };
  }, [hub.data]);

  if (hub.loading && !hub.data) return <PageSkeleton />;
  if (hub.error && !hub.data) return <ErrorState error={hub.error} onRetry={hub.reload} />;

  const open = (t) => nav(`${base}/${t.id}`);
  const answer = async (t, accept) => {
    setBusy(t.id);
    try {
      await api(`/tournaments/${t.id}/hosts/respond`, { method: 'POST', body: JSON.stringify({ accept }) });
      if (accept) { nav(`${base}/${t.id}`); return; }
      setToast('Invitation declined');
      hub.reload({ silent: true });
    } catch (e) { setToast(e.message); } finally { setBusy(null); }
  };
  const scanned = (raw) => {
    const code = String(raw).trim().split('/').pop().split('?')[0].toUpperCase();
    setScan(false);
    if (code) nav(`/t/${code}`);
  };

  const tabs = [
    { id: 'live', label: 'Live', icon: Radio, rows: groups.live },
    { id: 'discover', label: 'Discover', icon: Compass, rows: groups.discover },
    { id: 'mine', label: 'Mine', icon: Dumbbell, rows: groups.mine },
    { id: 'results', label: 'Results', icon: Trophy, rows: groups.results },
  ];
  const current = tab || tabs.find((x) => x.rows.length)?.id || 'discover';
  const term = query.trim().toLowerCase();
  const list = tabs.find((x) => x.id === current).rows;
  const rows = list.filter((t) => !term || `${t.name} ${t.gym_name || ''} ${t.venue || ''}`.toLowerCase().includes(term));
  const s = shelf.data;

  return (
    <div className="tr-root">
      <Hero
        actions={<button type="button" className="tr-hero-back" aria-label="Scan a tournament QR" onClick={() => setScan(true)}><ScanLine size={18} /></button>}
        lead={(
          <button type="button" className="tr-handle" aria-label="Your tournament username" onClick={() => setIdentity(true)}>
            {hub.data.me.username ? `@${hub.data.me.username}` : 'Set a username'}
          </button>
        )}
        title="Tournaments"
        tagline="Every rep counted. Every place earned.">
        <div className="tr-rail">
          <RailItem value={s?.played ?? '–'} label="Played" />
          <RailItem value={s?.gold ?? '–'} label="Gold" place={1} />
          <RailItem value={s?.silver ?? '–'} label="Silver" place={2} />
          <RailItem value={s?.bronze ?? '–'} label="Bronze" place={3} />
        </div>
        <button type="button" className="tr-cta tr-cta-block" onClick={() => nav(`${base}/new`)}><Plus size={18} />Host a tournament</button>
      </Hero>

      {hub.data.invites.length > 0 && (
        <div className="tr-list">
          {hub.data.invites.map((t) => (
            <div key={t.id} className={`tr-event-row ${themeClass(t.theme)}`}>
              <span className="tr-event-icon"><Crown size={20} /></span>
              <div className="tr-grow">
                <b className="tr-ellipsis">{t.name}</b>
                <span className="tr-faint">{t.host_name} asked you to co-host</span>
              </div>
              <button type="button" className="tr-icon-btn" aria-label={`Decline co-hosting ${t.name}`} disabled={busy === t.id} onClick={() => answer(t, false)}><X size={17} /></button>
              <button type="button" className="tr-cta tr-cta-small" disabled={busy === t.id} onClick={() => answer(t, true)}><Check size={15} />Accept</button>
            </div>
          ))}
        </div>
      )}

      <div className="tr-tabs" role="tablist">
        {tabs.map((x) => (
          <button type="button" key={x.id} role="tab" className="tr-tab" aria-selected={current === x.id} onClick={() => setTab(x.id)}>
            <x.icon size={15} />{x.label}{x.rows.length > 0 && <span className="tr-tab-count">{x.rows.length}</span>}
          </button>
        ))}
      </div>

      {list.length > 4 && (
        <div className="tr-search">
          <Search size={16} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tournaments" aria-label="Search tournaments" />
        </div>
      )}

      {rows.length ? (
        <div className="tr-grid">{rows.map((t) => <Ticket key={t.id} t={t} onOpen={open} />)}</div>
      ) : (
        <div className="tr-empty">
          <span className="tr-empty-mark"><Trophy size={30} /></span>
          <b>{term ? 'No match' : current === 'live' ? 'Nothing live right now' : current === 'results' ? 'No results yet' : 'Nothing here yet'}</b>
          <p>{term ? 'Try another name.' : 'Your gym’s tournaments and open ones from other gyms land here.'}</p>
        </div>
      )}

      <TSheet open={identity} onClose={() => { setIdentity(false); hub.reload({ silent: true }); }} title="How people find you">
        <TournamentIdentity />
      </TSheet>
      <QrScanner open={scan} onClose={() => setScan(false)} onScanned={scanned} title="Scan a tournament QR" placeholder="Tournament code" actionLabel="Open" hint="Or type the code under the QR." />
      <Toast message={toast} tone="error" onDone={() => setToast('')} />
    </div>
  );
}
