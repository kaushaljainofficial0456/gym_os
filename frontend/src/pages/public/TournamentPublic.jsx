/**
 * WHAT A TOURNAMENT QR OPENS — /t/:code
 *
 * PUBLIC on purpose. The QR is on a wall or a phone in someone's hand, and
 * half the people scanning it have no account. They can read the board and
 * enter with a name, and their results wait for them under a key kept on
 * this device until they make an account. That last step is the point: this
 * page is how a member of another gym meets Barbell.
 *
 * Someone already signed in goes straight into the app. The exception is a
 * visitor to a gym-only tournament, who stays here and enters with the code.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CalendarDays, Check, LogIn, MapPin, Monitor, Scale, Sparkles, Trophy, UserRound, Users } from '../tournaments/icons.jsx';
import { api, setReturnTo } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import Logo from '../../components/Logo.jsx';
import { Spinner, Toast } from '../../components/UI.jsx';
import { eventIcon, eventStyle, fmtWhen, Hero, joinUrl, PhaseChip, RailItem, themeClass } from '../tournaments/shared.jsx';
import ResultsView, { shareDetails } from '../tournaments/ResultsView.jsx';
import { shareResultCard } from '../tournaments/shareCard.js';

const guestKey = (tournamentId) => `tournament-guest:${tournamentId}`;
const readGuest = (tournamentId) => {
  try { return JSON.parse(localStorage.getItem(guestKey(tournamentId)) || 'null'); } catch { return null; }
};
const saveGuest = (tournamentId, value) => {
  try {
    if (value) localStorage.setItem(guestKey(tournamentId), JSON.stringify(value));
    else localStorage.removeItem(guestKey(tournamentId));
  } catch { /* private window: the entry still counts, the shortcut does not */ }
};

function JoinPanel({ page, signedInAs, onJoin, busy, error }) {
  const [name, setName] = useState('');
  const [gym, setGym] = useState('');
  const [weight, setWeight] = useState('');
  const [picked, setPicked] = useState(() => (page.matched_event_id ? [page.matched_event_id] : page.events.length === 1 ? [page.events[0].id] : []));
  const [teams, setTeams] = useState({});
  const toggle = (id) => setPicked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const teamEvents = page.events.filter((e) => e.is_team && picked.includes(e.id));
  const ready = picked.length && (signedInAs || name.trim().length >= 2) && teamEvents.every((e) => (teams[e.id] || '').trim());
  return (
    <section className="tr-panel tr-section">
      <div className="tr-section-title"><Check size={16} />Enter</div>
      {!signedInAs && (
        <div className="tr-pair">
          <label className="tr-field"><span className="tr-label"><UserRound size={14} />Your name</span>
            <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
          <label className="tr-field"><span className="tr-label"><Users size={14} />Gym</span>
            <input className="input" maxLength={80} value={gym} onChange={(e) => setGym(e.target.value)} placeholder="Optional" />
          </label>
        </div>
      )}
      <div className="tr-choice-grid">
        {page.events.map((e, i) => {
          const Icon = eventIcon(e);
          const on = picked.includes(e.id);
          return (
            <button type="button" key={e.id} className="tr-tile" aria-pressed={on} style={eventStyle(i)} onClick={() => toggle(e.id)}>
              {on && <span className="tr-tile-check"><Check size={12} /></span>}
              <Icon size={22} />{e.name}
            </button>
          );
        })}
      </div>
      {teamEvents.map((e) => (
        <label key={e.id} className="tr-field"><span className="tr-label"><Users size={14} />Team for {e.name}</span>
          <input className="input" maxLength={40} value={teams[e.id] || ''} onChange={(ev) => setTeams((t) => ({ ...t, [e.id]: ev.target.value }))} />
        </label>
      ))}
      <label className="tr-field"><span className="tr-label"><Scale size={14} />Body weight, kg (optional)</span>
        <input className="input" type="number" inputMode="decimal" min="20" max="400" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Breaks ties on lifts" />
      </label>
      {error && <div role="alert" style={{ color: 'rgb(var(--bad-rgb))', fontSize: '.8125rem', fontWeight: 600 }}>{error}</div>}
      <button type="button" className="tr-cta" disabled={!ready || busy} onClick={() => onJoin({ name: name.trim(), gym_label: gym.trim() || undefined, body_weight: weight ? Number(weight) : null, event_ids: picked, teams })}>
        <Check size={16} />{busy ? 'Entering…' : signedInAs ? `Enter as ${signedInAs}` : 'Enter'}
      </button>
    </section>
  );
}

export default function TournamentPublic() {
  const { code } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { user, ready, isClient } = useAuth();
  const [page, setPage] = useState(null);
  const [report, setReport] = useState(null);
  const [guest, setGuest] = useState(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const appBase = isClient ? '/app/client/tournaments' : '/app/trainer/tournaments';

  const load = useCallback(async () => {
    const next = await api(`/tournaments-public/${encodeURIComponent(code)}`);
    setPage(next);
    const mine = readGuest(next.id);
    setGuest(mine);
    if (mine?.key) {
      const own = await api(`/tournaments-public/${encodeURIComponent(code)}/me`, { method: 'POST', body: JSON.stringify({ key: mine.key }) }).catch(() => null);
      if (own) setReport(own);
      else { saveGuest(next.id, null); setGuest(null); }
    }
    return next;
  }, [code]);

  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    (async () => {
      let next = null;
      try { next = await load(); } catch (e) { if (e.status !== 404) setError(e.message); }
      if (!alive) return;
      if (user) {
        const held = next ? readGuest(next.id) : null;
        if (held?.key && params.get('claim')) {
          await api(`/tournaments/${next.id}/claim`, { method: 'POST', body: JSON.stringify({ key: held.key }) }).catch(() => null);
          saveGuest(next.id, null);
          nav(`${appBase}/${next.id}`, { replace: true });
          return;
        }
        const found = await api(`/tournaments/code/${encodeURIComponent(code)}`).catch(() => null);
        if (!alive) return;
        if (found?.visible) {
          const query = new URLSearchParams({ code });
          if (found.event_id) query.set('event', found.event_id);
          nav(`${appBase}/${found.id}?${query}`, { replace: true });
          return;
        }
      }
      if (!next) setMissing(true);
    })();
    return () => { alive = false; };
  }, [ready, user, code]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = page?.status === 'live';
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 6000);
    return () => clearInterval(timer);
  }, [live, load]);

  const shown = report || page?.results;
  const anyScores = useMemo(() => (shown?.events || []).some((e) => e.summary.scored > 0), [shown]);

  const join = async (body) => {
    setBusy(true); setError('');
    try {
      if (user) {
        await api(`/tournaments/${page.id}/join`, { method: 'POST', body: JSON.stringify({ event_ids: body.event_ids, teams: body.teams, body_weight: body.body_weight, code }) });
        nav(`${appBase}/${page.id}`);
        return;
      }
      const res = await api(`/tournaments-public/${encodeURIComponent(code)}/join`, { method: 'POST', body: JSON.stringify(body) });
      saveGuest(page.id, { key: res.key, name: body.name });
      await load();
      setToast("You're in");
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const toAccount = (path) => {
    setReturnTo(`/t/${code}?claim=1`);
    nav(path);
  };
  const share = async () => {
    const outcome = await shareResultCard(shareDetails(report, joinUrl(code)));
    if (outcome === 'saved') setToast('Card saved. Post it anywhere');
  };

  if (missing) {
    return (
      <div className="tr-public tr-root">
        <div className="tr-public-top"><Logo alt="Barbell" className="w-8 h-8 rounded-lg object-cover" /></div>
        <div className="tr-panel"><b style={{ color: 'var(--ink)' }}>We could not find that tournament</b><p className="tr-muted" style={{ margin: '4px 0 0' }}>The code may be mistyped, or the host made a new one.</p></div>
      </div>
    );
  }
  if (!page) return <div className="tr-public"><Spinner /></div>;

  const canEnter = page.can_join && !guest;
  return (
    <div className={`tr-public tr-root ${themeClass(page.theme)}`}>
      <Hero lead={<Logo alt="Barbell" className="w-8 h-8 rounded-lg object-cover" />}
        actions={!user && <button type="button" className="btn btn-sm" onClick={() => toAccount('/login')}><LogIn size={15} />Sign in</button>}
        eyebrow={<><PhaseChip phase={page.phase} onHero />{page.gym_name && <span className="tr-tag">{page.gym_name}</span>}</>} title={page.name} tagline={page.tagline}>
        {(page.starts_at || page.venue) && (
          <div className="tr-meta">
            {page.starts_at && <span><CalendarDays size={13} />{fmtWhen(page.starts_at)}</span>}
            {page.venue && <span><MapPin size={13} /><span>{page.venue}</span></span>}
          </div>
        )}
        <div className="tr-rail">
          <RailItem value={page.entrants} label="Athletes" />
          <RailItem value={page.events.length} label="Events" />
        </div>
      </Hero>

      {canEnter && <JoinPanel page={page} signedInAs={user?.name} onJoin={join} busy={busy} error={error} />}

      {guest && !user && (
        <div className="tr-claim">
          <Trophy size={22} />
          <div className="tr-grow"><b>{guest.name}, you're in</b><div style={{ fontSize: '.75rem', opacity: 0.88 }}>Keep your results and medals with a free account.</div></div>
          <button type="button" className="tr-clock-btn" data-go="true" onClick={() => toAccount('/signup')}>Keep them</button>
        </div>
      )}

      {anyScores ? <ResultsView report={shown} onShare={share} /> : !canEnter && <div className="tr-panel tr-muted">Scores appear here as they are recorded.</div>}

      {!user && !guest && (
        <div className="tr-panel tr-row">
          <Sparkles size={20} style={{ color: 'var(--t-accent)', flex: 'none' }} />
          <div className="tr-grow"><b style={{ color: 'var(--ink)', fontSize: '.875rem' }}>Run your own</b><div className="tr-faint">Host a tournament at your gym on Barbell.</div></div>
          <button type="button" className="btn btn-sm" onClick={() => toAccount('/signup')}>Start</button>
        </div>
      )}
      <button type="button" className="btn" onClick={() => nav(`/t/${code}/screen`)}><Monitor size={16} />Big screen</button>
      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}
