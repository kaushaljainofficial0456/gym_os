/**
 * ONE TOURNAMENT. A competitor sees what they can enter and how it is going;
 * a host sees the same page with the controls switched on. `?event=` and
 * `?code=` arrive from a scanned QR, `?tab=` from the create flow.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import {
  BarChart3, CalendarDays, CalendarPlus, Check, ChevronRight, ClipboardList, Copy, Crown, Download, Flag, Gift, Lock, LogOut,
  MapPin, Monitor, Pencil, Play, Plus, QrCode, Radio, RefreshCw, Rocket, Search, Settings2, Share2, Swords, Trash2, Trophy,
  Unlock, UserPlus, Users, X,
} from './icons.jsx';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch } from '../../utils.js';
import { ErrorState, PageSkeleton, Toast, useConfirm } from '../../components/UI.jsx';
import {
  Countdown, eventIcon, eventStyle, fmtDay, fmtWhen, Hero, joinUrl, METRIC_WORD, PeopleSearch, PhaseChip, RailItem, TAvatar, themeClass, useTournamentBase,
} from './shared.jsx';
import { AddEventSheet, AddPeopleSheet, AuditSheet, EditSheet, EntrantSheet, EventSheet, JoinSheet } from './DetailSheets.jsx';
import { downloadPoster } from './shareCard.js';

function downloadCalendar(t) {
  const stamp = (d) => new Date(d).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const esc = (s) => String(s).replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Barbell//Tournaments//EN', 'BEGIN:VEVENT',
    `UID:${t.id}@barbell`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(t.starts_at)}`,
    `DTEND:${stamp(Date.parse(t.starts_at) + 3 * 3600000)}`, `SUMMARY:${esc(t.name)}`,
    ...(t.venue ? [`LOCATION:${esc(t.venue)}`] : []), 'END:VEVENT', 'END:VCALENDAR',
  ];
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
  link.download = 'tournament.ics';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

async function shareLink(t, url, setToast) {
  if (navigator.share) {
    try { await navigator.share({ title: t.name, text: `Join ${t.name} on Barbell`, url }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  await navigator.clipboard?.writeText(url);
  setToast('Link copied');
}

function Timeline({ t }) {
  const steps = [
    t.registration_opens_at && { at: t.registration_opens_at, label: 'Entries open', icon: Unlock },
    t.registration_closes_at && { at: t.registration_closes_at, label: 'Entries close', icon: Lock },
    t.withdraw_closes_at && { at: t.withdraw_closes_at, label: 'Last to leave', icon: LogOut },
    t.starts_at && { at: t.starts_at, label: 'Start', icon: Rocket },
  ].filter(Boolean);
  if (!steps.length) return null;
  const now = Date.now();
  return (
    <div className="tr-panel">
      <div className="tr-timeline">
        {steps.map((s) => (
          <div key={s.label} className="tr-timeline-step" data-past={Date.parse(s.at) <= now || t.status !== 'upcoming'}>
            <span className="tr-timeline-dot"><s.icon size={14} /></span>
            <b>{s.label}</b>{fmtDay(s.at)}
          </div>
        ))}
      </div>
    </div>
  );
}

function QrCard({ t, title, sub, code, setToast }) {
  const ref = useRef(null);
  const url = joinUrl(code);
  return (
    <div className="tr-qr">
      <QRCodeCanvas ref={ref} value={url} size={480} level="M" marginSize={1} style={{ width: '100%', maxWidth: 168, height: 'auto' }} aria-label={`QR code for ${title}`} />
      <b>{title}</b>
      <code>{code}</code>
      <div className="tr-row" style={{ gap: 6 }}>
        <button type="button" className="tr-icon-btn" aria-label={`Copy the link for ${title}`} onClick={async () => { await navigator.clipboard?.writeText(url); setToast('Link copied'); }}><Copy size={15} /></button>
        <button type="button" className="tr-icon-btn" aria-label={`Share ${title}`} onClick={() => shareLink(t, url, setToast)}><Share2 size={15} /></button>
        <button type="button" className="tr-icon-btn" aria-label={`Download a poster for ${title}`} onClick={() => { downloadPoster({ tournament: t.name, title, sub, code, url, theme: t.theme, qr: ref.current }); setToast('Poster saved'); }}><Download size={15} /></button>
      </div>
    </div>
  );
}

function EventRow({ e, index, t, base, nav, mine, onStart, onEdit, busy }) {
  const Icon = eventIcon(e);
  const isHost = t.you.is_host;
  const open = () => nav(`${base}/${t.id}/live/${e.id}`);
  return (
    <div className="tr-event-row" style={eventStyle(index)}>
      <span className="tr-event-icon"><Icon size={21} /></span>
      <button type="button" className="tr-grow" style={{ textAlign: 'left' }} onClick={open}>
        <b className="tr-name"><span className="tr-ellipsis">{e.name}</span>{mine && <Check size={15} strokeWidth={3} aria-label="You are in" />}</b>
        <span className="tr-faint tr-num tr-ellipsis" style={{ display: 'block' }}>{METRIC_WORD[e.metric]} · {e.entrants}{e.capacity ? `/${e.capacity}` : ''} in</span>
      </button>
      {e.status === 'live' && <PhaseChip phase="live" />}
      {e.status === 'completed' && <span className="tr-chip"><Check size={12} />Done</span>}
      {isHost && t.status !== 'completed' && (
        <button type="button" className="tr-icon-btn" aria-label={`Edit ${e.name}`} onClick={() => onEdit(e)}><Settings2 size={15} /></button>
      )}
      {isHost && e.status === 'upcoming' && t.status !== 'completed' ? (
        <button type="button" className="tr-cta tr-cta-small" disabled={busy} onClick={() => onStart(e)}><Play size={14} />Start</button>
      ) : e.status !== 'completed' && (
        <button type="button" className="tr-icon-btn" aria-label={`Open ${e.name}`} onClick={open}><ChevronRight size={17} /></button>
      )}
    </div>
  );
}

export default function Detail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const base = useTournamentBase();
  const { user } = useAuth();
  const res = useFetch(() => api(`/tournaments/${id}`), [id]);
  const [confirm, confirmDialog] = useConfirm();
  const [tab, setTab] = useState(params.get('tab') || 'events');
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [eventFilter, setEventFilter] = useState('all');

  const code = params.get('code');
  const focusEvent = params.get('event');
  const t = res.data;
  const { reload } = res;

  const ongoing = t?.status === 'live' || t?.you?.is_host;
  useEffect(() => {
    if (!ongoing) return undefined;
    const timer = setInterval(() => { if (!document.hidden) reload({ silent: true }); }, 12000);
    return () => clearInterval(timer);
  }, [ongoing, reload]);

  // A QR for one competition lands here ready to enter it.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (t && !autoOpened.current && (code || focusEvent) && t.you.can_join && !t.you.is_host) {
      autoOpened.current = true;
      setSheet('join');
    }
  }, [t, code, focusEvent]);

  const people = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (t?.people || []).filter((p) => (eventFilter === 'all' || p.event_ids.includes(eventFilter)) && (!term || p.name.toLowerCase().includes(term)));
  }, [t, query, eventFilter]);

  if (res.loading && !t) return <PageSkeleton />;
  if (res.error && !t) return <ErrorState error={res.error} onRetry={res.reload} />;

  const done = (message) => {
    setSheet(null);
    if (message) setToast(message);
    reload({ silent: true });
  };
  const act = async (fn, message) => {
    setBusy(true);
    try { await fn(); done(message); return true; } catch (e) { setToast(e.message); return false; } finally { setBusy(false); }
  };
  const post = (path, body) => api(`/tournaments/${id}${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });

  const you = t.you;
  const isHost = you.is_host;
  const finished = t.status === 'completed';
  const openEvents = t.events.filter((e) => e.status !== 'completed').length;
  const isIn = you.entry_status === 'active';
  const url = t.code ? joinUrl(t.code) : null;

  const startEvent = async (e) => {
    const ok = await act(() => post(`/events/${e.id}/start`));
    if (ok) nav(`${base}/${id}/live/${e.id}`);
  };
  const finishAll = async () => {
    const yes = await confirm({ title: 'Finish the tournament?', body: 'Results become final and everyone gets their summary.', confirmLabel: 'Finish', cancelLabel: 'Not yet' });
    if (yes && await act(() => post('/finish'))) nav(`${base}/${id}/results`);
  };
  const cancelAll = async () => {
    const yes = await confirm({ title: 'Cancel this tournament?', body: 'Everyone entered is told. This cannot be undone.', confirmLabel: 'Cancel tournament', cancelLabel: 'Keep it', danger: true });
    if (yes && await act(() => api(`/tournaments/${id}`, { method: 'DELETE' }))) nav(base);
  };
  const leave = async () => {
    const pending = you.entry_status === 'pending';
    const yes = await confirm({ title: pending ? 'Take back your request?' : 'Leave this tournament?', confirmLabel: pending ? 'Take back' : 'Leave', cancelLabel: 'Stay', danger: true });
    if (yes) await act(() => post('/leave', {}), pending ? 'Request taken back' : 'You have left');
  };
  const removeEntrant = async () => {
    const person = sheet.entrant;
    const yes = await confirm({ title: `Remove ${person.name}?`, confirmLabel: 'Remove', cancelLabel: 'Keep', danger: true });
    if (yes) await act(() => api(`/tournaments/${id}/entrants/${person.id}`, { method: 'DELETE' }), 'Removed');
  };
  const removeEvent = async () => {
    const event = sheet.event;
    const yes = await confirm({ title: `Remove ${event.name}?`, body: 'Entries for it go too.', confirmLabel: 'Remove', cancelLabel: 'Keep', danger: true });
    if (yes) await act(() => api(`/tournaments/${id}/events/${event.id}`, { method: 'DELETE' }), 'Removed');
  };
  const rotate = async () => {
    const yes = await confirm({ title: 'Make new codes?', body: 'Every printed QR stops working.', confirmLabel: 'Make new codes', cancelLabel: 'Keep these', danger: true });
    if (yes) await act(() => post('/rotate-codes'), 'New codes ready');
  };
  const removeHost = async (h) => {
    const self = !you.is_prime;
    const yes = await confirm({ title: self ? 'Stop co-hosting?' : `Remove ${h.name}?`, confirmLabel: self ? 'Stop' : 'Remove', cancelLabel: 'Keep', danger: true });
    if (!yes) return;
    if (await act(() => api(`/tournaments/${id}/hosts/${h.user_id}`, { method: 'DELETE' }), 'Done') && self) nav(base);
  };

  const tabs = [
    { id: 'events', label: 'Events', icon: Swords },
    { id: 'people', label: 'People', icon: Users, count: (t.requests.length || t.people.length) },
    ...(isHost ? [
      { id: 'share', label: 'QR', icon: QrCode },
      { id: 'hosts', label: 'Hosts', icon: Crown },
      { id: 'manage', label: 'Manage', icon: Settings2 },
    ] : []),
  ];
  const current = tabs.some((x) => x.id === tab) ? tab : 'events';
  const pickTab = (next) => {
    setTab(next);
    if (params.has('tab')) { params.delete('tab'); setParams(params, { replace: true }); }
  };

  return (
    <div className={`tr-root ${themeClass(t.theme)}`}>
      <Hero back={{ label: 'Back to tournaments', onClick: () => nav(base) }}
        actions={(
          <>
            {t.starts_at && !finished && <button type="button" className="tr-hero-back" aria-label="Add to calendar" onClick={() => downloadCalendar(t)}><CalendarPlus size={18} /></button>}
            {url && <button type="button" className="tr-hero-back" aria-label="Share this tournament" onClick={() => shareLink(t, url, setToast)}><Share2 size={18} /></button>}
          </>
        )}
        eyebrow={(
          <>
            <PhaseChip phase={t.phase} onHero />
            {t.visibility === 'private' && <span className="tr-tag">By request</span>}
            {t.audience === 'staff' && <span className="tr-tag">Staff only</span>}
            <span className="tr-tag">{t.reach === 'everyone' ? 'All gyms' : 'One gym'}</span>
          </>
        )}
        title={t.name} tagline={t.tagline}>
        {(t.starts_at || t.venue || t.prize) && (
          <div className="tr-meta">
            {t.starts_at && <span><CalendarDays size={13} />{fmtWhen(t.starts_at)}</span>}
            {t.venue && <span><MapPin size={13} /><span>{t.venue}</span></span>}
            {t.prize && <span><Gift size={13} /><span>{t.prize}</span></span>}
          </div>
        )}
        <div className="tr-rail">
          <RailItem value={`${t.entrants}${t.capacity ? `/${t.capacity}` : ''}`} label="Athletes" />
          <RailItem value={t.events.length} label="Events" />
          {t.phase === 'open' && t.registration_closes_at && <Countdown to={t.registration_closes_at} label="Closes in" />}
          {t.phase !== 'open' && t.status === 'upcoming' && t.starts_at && <Countdown to={t.starts_at} label="Starts in" />}
        </div>
      </Hero>

      {you.invited_to_host && (
        <div className="tr-list">
          <div className="tr-event-row" data-mine="true">
            <span className="tr-event-icon"><Crown size={18} /></span>
            <div className="tr-grow"><b>Co-host this?</b><span className="tr-faint">{t.host_name} asked you</span></div>
            <button type="button" className="tr-icon-btn" aria-label="Decline" disabled={busy} onClick={() => act(() => post('/hosts/respond', { accept: false }), 'Declined')}><X size={17} /></button>
            <button type="button" className="tr-cta tr-cta-small" disabled={busy} onClick={() => act(() => post('/hosts/respond', { accept: true }), 'You are a co-host')}><Check size={15} />Accept</button>
          </div>
        </div>
      )}

      <div className="tr-tabs" data-stack="true" role="tablist">
        {tabs.map((x) => (
          <button type="button" key={x.id} role="tab" className="tr-tab" aria-selected={current === x.id} onClick={() => pickTab(x.id)}>
            <x.icon size={16} /><span>{x.label}{x.count > 0 && <span className="tr-tab-count"> {x.count}</span>}</span>
          </button>
        ))}
      </div>

      {current === 'events' && (
        <section className="tr-section">
          {t.status === 'upcoming' && <Timeline t={t} />}
          <div className="tr-list">
            {t.events.map((e, i) => (
              <EventRow key={e.id} e={e} index={i} t={t} base={base} nav={nav} busy={busy} mine={you.event_ids.includes(e.id)} onStart={startEvent} onEdit={(ev) => setSheet({ event: ev })} />
            ))}
          </div>
          {isHost && !finished && <button type="button" className="btn" onClick={() => setSheet('addEvent')}><Plus size={16} />Add a competition</button>}
          {t.status === 'live' && (
            <button type="button" className="btn" onClick={() => nav(`${base}/${id}/results`)}><BarChart3 size={16} />Standings so far</button>
          )}
          {t.rules && <div className="tr-panel"><div className="tr-section-title"><ClipboardList size={14} />Rules</div><p className="tr-muted" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{t.rules}</p></div>}
          <div className="tr-faint">Hosted by {t.hosts.filter((h) => h.status === 'accepted').map((h) => h.name).join(', ')}{t.gym_name ? ` · ${t.gym_name}` : ''}</div>
        </section>
      )}

      {current === 'people' && (
        <section className="tr-section">
          {t.requests.length > 0 && (
            <div className="tr-panel tr-section">
              <div className="tr-section-title"><UserPlus size={14} />Waiting for you ({t.requests.length})</div>
              {t.requests.map((p) => (
                <div key={p.id} className="tr-row">
                  <TAvatar name={p.name} />
                  <div className="tr-grow"><div className="tr-ellipsis" style={{ color: 'var(--ink)', fontWeight: 700, fontSize: '.875rem' }}>{p.name}</div><div className="tr-faint tr-ellipsis">{p.gym_label}</div></div>
                  <button type="button" className="tr-icon-btn" aria-label={`Decline ${p.name}`} disabled={busy} onClick={() => act(() => post(`/entrants/${p.id}/decision`, { accept: false }), 'Declined')}><X size={16} /></button>
                  <button type="button" className="tr-icon-btn" data-go="true" aria-label={`Accept ${p.name}`} disabled={busy} onClick={() => act(() => post(`/entrants/${p.id}/decision`, { accept: true }), `${p.name} is in`)}><Check size={16} /></button>
                </div>
              ))}
            </div>
          )}
          {isHost && !finished && <button type="button" className="tr-cta" onClick={() => setSheet('add')}><UserPlus size={16} />Add people</button>}
          {t.people.length > 6 && (
            <div className="tr-search"><Search size={16} /><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people" aria-label="Search people" /></div>
          )}
          {t.events.length > 1 && (
            <div className="tr-mini">
              <button type="button" aria-pressed={eventFilter === 'all'} onClick={() => setEventFilter('all')}>All</button>
              {t.events.map((e) => <button type="button" key={e.id} aria-pressed={eventFilter === e.id} onClick={() => setEventFilter(e.id)}>{e.name}</button>)}
            </div>
          )}
          {people.length === 0 && <div className="tr-panel tr-muted">Nobody here yet.</div>}
          {people.length > 0 && (
            <div className="tr-list">
              {people.map((p) => (
                <button type="button" key={p.id} className="tr-event-row" data-mine={p.is_me || undefined} disabled={!isHost} onClick={() => setSheet({ entrant: p })}>
                  <TAvatar name={p.name} />
                  <span className="tr-grow"><b className="tr-ellipsis">{p.name}{p.is_me ? ' (you)' : ''}</b><span className="tr-faint tr-ellipsis" style={{ display: 'block' }}>{[p.gym_label, `${p.event_ids.length} ${p.event_ids.length === 1 ? 'competition' : 'competitions'}`].filter(Boolean).join(' · ')}</span></span>
                  {isHost && <Pencil size={15} style={{ color: 'var(--faint)' }} />}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {current === 'share' && (
        <section className="tr-section">
          <div className="tr-faint">Scanning the tournament code lets people pick competitions. A competition code goes straight to that one.</div>
          <div className="tr-qr-grid">
            <QrCard t={t} title={t.name} sub="All competitions" code={t.code} setToast={setToast} />
            {t.events.map((e) => <QrCard key={e.id} t={t} title={e.name} sub={t.name} code={e.code} setToast={setToast} />)}
          </div>
          <div className="tr-pair">
            <button type="button" className="btn" onClick={() => window.open(`/t/${t.code}/screen`, '_blank', 'noopener')}><Monitor size={16} />Gym big screen</button>
            <button type="button" className="btn" disabled={busy} onClick={rotate}><RefreshCw size={16} />New codes</button>
          </div>
        </section>
      )}

      {current === 'hosts' && (
        <section className="tr-section">
          <div className="tr-list">
            {t.hosts.map((h) => (
              <div key={h.user_id} className="tr-event-row">
                <TAvatar name={h.name} />
                <div className="tr-grow"><b className="tr-ellipsis">{h.name}</b><span className="tr-faint tr-ellipsis" style={{ display: 'block' }}>{h.username ? `@${h.username}` : ''}</span></div>
                <span className={`tr-chip ${h.role === 'prime' ? 'tr-chip-host' : ''}`}>{h.role === 'prime' ? <><Crown size={11} />Main host</> : h.status === 'pending' ? 'Invited' : 'Co-host'}</span>
                {h.role !== 'prime' && you.is_prime && <button type="button" className="tr-icon-btn" aria-label={`Remove ${h.name}`} disabled={busy} onClick={() => removeHost(h)}><Trash2 size={15} /></button>}
              </div>
            ))}
          </div>
          {you.is_prime && !finished && (
            <div className="tr-panel tr-section">
              <div className="tr-section-title"><UserPlus size={14} />Add a co-host</div>
              <PeopleSearch picked={t.hosts.map((h) => h.user_id)} onPick={(p) => act(() => post('/hosts', { user_id: p.id }), `Request sent to ${p.name}`)} />
            </div>
          )}
          {!you.is_prime && <button type="button" className="btn" onClick={() => removeHost({ user_id: user.id })}><LogOut size={16} />Stop co-hosting</button>}
        </section>
      )}

      {current === 'manage' && (
        <section className="tr-section">
          {!finished && <button type="button" className="tr-option" onClick={() => setSheet('edit')}><span className="tr-option-icon"><Pencil size={18} /></span><span><b>Edit details</b><small>Name, dates, spots, winners</small></span></button>}
          <button type="button" className="tr-option" onClick={() => setSheet('audit')}><span className="tr-option-icon"><ClipboardList size={18} /></span><span><b>Activity</b><small>Who changed what</small></span></button>
          {finished && you.is_prime && <button type="button" className="tr-option" onClick={() => nav(`${base}/new?from=${id}`)}><span className="tr-option-icon"><Rocket size={18} /></span><span><b>Run it back</b><small>Same competitions, new date</small></span></button>}
          {t.status === 'live' && <button type="button" className="tr-option" disabled={busy || openEvents > 0} onClick={finishAll}><span className="tr-option-icon"><Flag size={18} /></span><span><b>Finish tournament</b><small>{openEvents ? `${openEvents} still open` : 'Lock results and send summaries'}</small></span></button>}
          {you.is_prime && !finished && <button type="button" className="btn-danger-quiet btn-base" disabled={busy} onClick={cancelAll}><X size={15} />Cancel tournament</button>}
        </section>
      )}

      {finished ? (
        <div className="tr-action">
          <span className="tr-grow tr-muted">Finished</span>
          <button type="button" className="tr-cta" onClick={() => nav(`${base}/${id}/results`)}><Trophy size={16} />See results</button>
        </div>
      ) : t.status === 'live' ? (
        <div className="tr-action">
          <span className="tr-grow tr-muted">{isHost ? (openEvents ? `${openEvents} still open` : 'All competitions done') : isIn ? 'You are competing' : 'Happening now'}</span>
          {isHost && !openEvents
            ? <button type="button" className="tr-cta" disabled={busy} onClick={finishAll}><Flag size={16} />Finish</button>
            : <button type="button" className="tr-cta" onClick={() => nav(`${base}/${id}/results`)}><Radio size={16} />Standings</button>}
        </div>
      ) : (
        <div className="tr-action">
          <span className="tr-grow">
            <span className="tr-muted" style={{ display: 'block' }}>
              {you.entry_status === 'pending' ? 'Waiting for the host' : isIn ? `In ${you.event_ids.length} ${you.event_ids.length === 1 ? 'competition' : 'competitions'}` : t.phase === 'soon' ? 'Entries are not open yet' : t.phase === 'closed' ? 'Entries have closed' : 'Entries are open'}
            </span>
            {isIn && !you.can_leave && <span className="tr-faint"><Lock size={11} style={{ display: 'inline', marginRight: 3 }} />Locked in</span>}
          </span>
          {you.can_leave && <button type="button" className="tr-icon-btn" aria-label={you.entry_status === 'pending' ? 'Take back request' : 'Leave'} disabled={busy} onClick={leave}><LogOut size={16} /></button>}
          {you.can_join && you.entry_status !== 'pending' && (
            <button type="button" className="tr-cta" onClick={() => setSheet('join')}>
              {isIn ? <><Pencil size={15} />Change</> : you.needs_approval && !code ? <><UserPlus size={16} />Request</> : <><Check size={16} />Join</>}
            </button>
          )}
        </div>
      )}

      <JoinSheet open={sheet === 'join'} onClose={() => setSheet(null)} t={t} code={code} focusEvent={focusEvent} onDone={() => done(you.needs_approval && !code && !isIn ? 'Request sent' : "You're in")} />
      <AddPeopleSheet open={sheet === 'add' || !!sheet?.addTo} onClose={() => setSheet(null)} t={t} preselect={sheet?.addTo} onDone={done} />
      <EntrantSheet person={sheet?.entrant || null} onClose={() => setSheet(null)} t={t} onDone={done} onRemove={removeEntrant} />
      <EventSheet event={sheet?.event || null} onClose={() => setSheet(null)} t={t} onDone={done} onRemove={removeEvent} onAddPeople={(e) => setSheet({ addTo: e.id })} />
      <AddEventSheet open={sheet === 'addEvent'} onClose={() => setSheet(null)} t={t} onDone={done} />
      <EditSheet open={sheet === 'edit'} onClose={() => setSheet(null)} t={t} onDone={done} />
      <AuditSheet open={sheet === 'audit'} onClose={() => setSheet(null)} t={t} />
      {confirmDialog}
      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}
