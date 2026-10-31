/**
 * Every sheet on the tournament page. They portal to <body>, outside the
 * themed page, so TSheet carries the tournament's colours in with them.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Check, ClipboardList, Crown, Flag, Medal, Plus, Scale, Search, Timer, Trash2, UserPlus, Users, X,
} from './icons.jsx';
import { api } from '../../api.js';
import { Sheet, Spinner } from '../../components/UI.jsx';
import {
  eventIcon, eventStyle, fmtWhen, fromLocalInput, METRIC_WORD, PeopleSearch, Stepper, TAvatar, themeClass, toLocalInput,
} from './shared.jsx';

export function TSheet({ theme, footer, children, ...rest }) {
  return (
    <Sheet {...rest} footer={footer && <div className={`tr-sheet ${themeClass(theme)}`}>{footer}</div>}>
      <div className={`tr-sheet tr-section ${themeClass(theme)}`}>{children}</div>
    </Sheet>
  );
}

const Problem = ({ text }) => (text ? <div role="alert" style={{ color: 'rgb(var(--bad-rgb))', fontSize: '.8125rem', fontWeight: 600 }}>{text}</div> : null);

function EventPicker({ events, picked, onToggle, isDisabled }) {
  return (
    <div className="tr-choice-grid">
      {events.map((e, i) => {
        const Icon = eventIcon(e);
        const on = picked.includes(e.id);
        const disabled = isDisabled?.(e);
        return (
          <button type="button" key={e.id} className="tr-tile" aria-pressed={on} disabled={disabled} style={{ ...eventStyle(i), opacity: disabled ? 0.45 : undefined }} onClick={() => onToggle(e.id)}>
            {on && <span className="tr-tile-check"><Check size={12} /></span>}
            <Icon size={22} />{e.name}
            {disabled && <small className="tr-faint">Full</small>}
          </button>
        );
      })}
    </div>
  );
}

function TeamFields({ events, picked, teams, setTeams }) {
  const teamEvents = events.filter((e) => e.is_team && picked.includes(e.id));
  if (!teamEvents.length) return null;
  return teamEvents.map((e) => (
    <label key={e.id} className="tr-field">
      <span className="tr-label"><Users size={14} />Team for {e.name}</span>
      <input className="input" list={`teams-${e.id}`} maxLength={40} value={teams[e.id] || ''} placeholder="Team name"
        onChange={(ev) => setTeams((t) => ({ ...t, [e.id]: ev.target.value }))} />
      <datalist id={`teams-${e.id}`}>{e.teams?.map((name) => <option key={name} value={name} />)}</datalist>
    </label>
  ));
}

const missingTeam = (events, picked, teams) => events.some((e) => e.is_team && picked.includes(e.id) && !(teams[e.id] || '').trim());
const toggled = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

export function JoinSheet({ open, onClose, t, code, focusEvent, onDone }) {
  const [picked, setPicked] = useState([]);
  const [teams, setTeams] = useState({});
  const [weight, setWeight] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entered = t.you.entry_status === 'active' || t.you.entry_status === 'pending';

  useEffect(() => {
    if (!open) return;
    const mine = entered ? t.you.event_ids : [];
    setPicked(mine.length ? mine : focusEvent ? [focusEvent] : t.events.length === 1 ? [t.events[0].id] : []);
    setTeams(t.you.teams || {});
    setWeight(t.you.body_weight ?? '');
    setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true); setError('');
    try {
      const mine = entered ? t.you.event_ids : [];
      const dropped = mine.filter((x) => !picked.includes(x));
      await api(`/tournaments/${t.id}/join`, {
        method: 'POST',
        body: JSON.stringify({ event_ids: picked, teams, body_weight: weight ? Number(weight) : null, ...(code ? { code } : {}) }),
      });
      if (dropped.length) await api(`/tournaments/${t.id}/leave`, { method: 'POST', body: JSON.stringify({ event_ids: dropped }) });
      onDone();
    } catch (e) { setError(e.message); setBusy(false); return; }
    setBusy(false);
  };

  const blocked = !picked.length || missingTeam(t.events, picked, teams);
  const label = entered ? 'Save' : t.you.needs_approval && !code ? 'Send request' : 'Join';
  return (
    <TSheet theme={t.theme} open={open} onClose={onClose} title={entered ? 'Your competitions' : `Enter ${t.name}`}
      sub={t.you.needs_approval && !code ? 'The host approves each entry' : 'Pick what you want to compete in'}
      footer={<button type="button" className="tr-cta tr-cta-block" disabled={blocked || busy} onClick={save}><Check size={16} />{busy ? 'Saving…' : label}</button>}>
      <EventPicker events={t.events} picked={picked} onToggle={(id) => setPicked((l) => toggled(l, id))}
        isDisabled={(e) => !!e.capacity && e.entrants >= e.capacity && !t.you.event_ids.includes(e.id)} />
      <TeamFields events={t.events} picked={picked} teams={teams} setTeams={setTeams} />
      <label className="tr-field">
        <span className="tr-label"><Scale size={14} />Body weight, kg (optional)</span>
        <input className="input" type="number" inputMode="decimal" min="20" max="400" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Breaks ties on lifts" />
      </label>
      <Problem text={error} />
    </TSheet>
  );
}

export function AddPeopleSheet({ open, onClose, t, preselect, onDone }) {
  const [mode, setMode] = useState('names');
  const [text, setText] = useState('');
  const [gym, setGym] = useState('');
  const [people, setPeople] = useState([]);
  const [picked, setPicked] = useState([]);
  const [teams, setTeams] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setText(''); setPeople([]); setError(''); setTeams({});
    setPicked(preselect ? [preselect] : t.events.length === 1 ? [t.events[0].id] : []);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useMemo(() => text.split('\n').map((n) => n.trim()).filter(Boolean), [text]);
  const total = mode === 'names' ? names.length : people.length;

  const save = async () => {
    setBusy(true); setError('');
    const rows = mode === 'names'
      ? names.map((name) => ({ name, gym_label: gym.trim() || null, event_ids: picked, teams }))
      : people.map((p) => ({ user_id: p.id, event_ids: picked, teams }));
    try {
      await api(`/tournaments/${t.id}/entrants`, { method: 'POST', body: JSON.stringify({ people: rows }) });
      onDone(`${rows.length} added`);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <TSheet theme={t.theme} open={open} onClose={onClose} title="Add people"
      footer={<button type="button" className="tr-cta tr-cta-block" disabled={!total || !picked.length || total > 100 || missingTeam(t.events, picked, teams) || busy} onClick={save}><UserPlus size={16} />{busy ? 'Adding…' : `Add ${total || ''}`}</button>}>
      <div className="tr-toggle" role="group" aria-label="How to add">
        <button type="button" aria-pressed={mode === 'names'} onClick={() => setMode('names')}><ClipboardList size={14} />Type names</button>
        <button type="button" aria-pressed={mode === 'search'} onClick={() => setMode('search')}><Search size={14} />Find on Barbell</button>
      </div>
      {mode === 'names' ? (
        <>
          <label className="tr-field">
            <span className="tr-label"><ClipboardList size={14} />One name on each line</span>
            <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Rohan Mehta\nPriya Singh'} />
          </label>
          <label className="tr-field">
            <span className="tr-label"><Flag size={14} />Gym (optional)</span>
            <input className="input" maxLength={80} value={gym} onChange={(e) => setGym(e.target.value)} placeholder={t.gym_name || 'Which gym they represent'} />
          </label>
        </>
      ) : (
        <>
          {people.map((p) => (
            <div key={p.id} className="tr-row">
              <TAvatar name={p.name} /><span className="tr-grow tr-ellipsis" style={{ color: 'var(--ink)', fontWeight: 700, fontSize: '.875rem' }}>{p.name}</span>
              <button type="button" className="tr-icon-btn" aria-label={`Remove ${p.name}`} onClick={() => setPeople((l) => l.filter((x) => x.id !== p.id))}><X size={15} /></button>
            </div>
          ))}
          <PeopleSearch picked={people.map((p) => p.id)} onPick={(p) => setPeople((l) => [...l, p])} />
        </>
      )}
      <div className="tr-label"><Medal size={14} />Competitions</div>
      <EventPicker events={t.events} picked={picked} onToggle={(id) => setPicked((l) => toggled(l, id))} />
      <TeamFields events={t.events} picked={picked} teams={teams} setTeams={setTeams} />
      <Problem text={error} />
    </TSheet>
  );
}

export function EntrantSheet({ person, onClose, t, onDone, onRemove }) {
  const [name, setName] = useState('');
  const [gym, setGym] = useState('');
  const [weight, setWeight] = useState('');
  const [picked, setPicked] = useState([]);
  const [teams, setTeams] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!person) return;
    setName(person.name); setGym(person.gym_label || ''); setWeight('');
    setPicked(person.event_ids); setTeams(person.teams || {}); setError('');
  }, [person]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api(`/tournaments/${t.id}/entrants/${person.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), gym_label: gym.trim() || null, event_ids: picked, teams, ...(weight ? { body_weight: Number(weight) } : {}) }),
      });
      onDone('Saved');
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <TSheet theme={t.theme} open={!!person} onClose={onClose} title={person?.name || ''}
      footer={<button type="button" className="tr-cta tr-cta-block" disabled={name.trim().length < 2 || !picked.length || missingTeam(t.events, picked, teams) || busy} onClick={save}><Check size={16} />Save</button>}>
      <div className="tr-pair">
        <label className="tr-field"><span className="tr-label">Name</span><input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="tr-field"><span className="tr-label">Gym</span><input className="input" maxLength={80} value={gym} onChange={(e) => setGym(e.target.value)} /></label>
      </div>
      <label className="tr-field"><span className="tr-label"><Scale size={14} />Body weight, kg</span>
        <input className="input" type="number" inputMode="decimal" min="20" max="400" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Leave empty to keep it" />
      </label>
      <EventPicker events={t.events} picked={picked} onToggle={(id) => setPicked((l) => toggled(l, id))} />
      <TeamFields events={t.events} picked={picked} teams={teams} setTeams={setTeams} />
      <button type="button" className="btn-danger-quiet btn-base" onClick={onRemove}><Trash2 size={15} />Remove from tournament</button>
      <Problem text={error} />
    </TSheet>
  );
}

const CAPS = [[0, 'None'], [60, '1 min'], [120, '2 min'], [300, '5 min']];

export function EventSheet({ event, onClose, t, onDone, onRemove, onAddPeople }) {
  const [wins, setWins] = useState(3);
  const [attempts, setAttempts] = useState(1);
  const [cap, setCap] = useState(0);
  const [spots, setSpots] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!event) return;
    setWins(event.win_positions); setAttempts(event.attempts); setCap(event.time_cap_sec || 0); setSpots(event.capacity || ''); setError('');
  }, [event]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api(`/tournaments/${t.id}/events/${event.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ win_positions: wins, attempts, time_cap_sec: cap || null, capacity: spots ? Number(spots) : null }),
      });
      onDone('Saved');
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const timed = event && ['reps', 'time_high', 'wins'].includes(event.metric);
  return (
    <TSheet theme={t.theme} open={!!event} onClose={onClose} title={event?.name || ''} sub={event ? METRIC_WORD[event.metric] : ''}
      footer={<button type="button" className="tr-cta tr-cta-block" disabled={busy} onClick={save}><Check size={16} />Save</button>}>
      <div className="tr-row" style={{ justifyContent: 'space-between' }}><span className="tr-label"><Medal size={14} />Winners</span><Stepper label="Winners" value={wins} onChange={setWins} /></div>
      <div className="tr-row" style={{ justifyContent: 'space-between' }}><span className="tr-label"><Flag size={14} />Attempts</span><Stepper label="Attempts" value={attempts} max={5} onChange={setAttempts} /></div>
      {timed && (
        <div className="tr-field"><span className="tr-label"><Timer size={14} />Time limit</span>
          <div className="tr-mini">{CAPS.map(([s, l]) => <button type="button" key={s} aria-pressed={cap === s} onClick={() => setCap(s)}>{l}</button>)}</div>
        </div>
      )}
      <label className="tr-field"><span className="tr-label"><Users size={14} />Spots</span>
        <input className="input" type="number" min="0" inputMode="numeric" value={spots} onChange={(e) => setSpots(e.target.value)} placeholder="Unlimited" />
      </label>
      {event && event.status !== 'completed' && <button type="button" className="btn" onClick={() => onAddPeople(event)}><UserPlus size={16} />Add people to {event.name}</button>}
      {event?.status === 'upcoming' && <button type="button" className="btn-danger-quiet btn-base" onClick={onRemove}><Trash2 size={15} />Remove competition</button>}
      <Problem text={error} />
    </TSheet>
  );
}

export function AddEventSheet({ open, onClose, t, onDone }) {
  const [options, setOptions] = useState(null);
  const [name, setName] = useState('');
  const [metric, setMetric] = useState('reps');
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && !options) api('/tournaments/options').then(setOptions).catch((e) => setError(e.message));
  }, [open, options]);

  const add = async (body) => {
    setError('');
    try {
      await api(`/tournaments/${t.id}/events`, { method: 'POST', body: JSON.stringify(body) });
      onDone(`${body.name} added`);
    } catch (e) { setError(e.message); }
  };
  const taken = new Set(t.events.map((e) => e.kind));
  return (
    <TSheet theme={t.theme} open={open} onClose={onClose} title="Add a competition">
      {!options && !error && <Spinner />}
      {options && (
        <>
          <div className="tr-choice-grid">
            {options.catalog.filter((c) => !taken.has(c.kind)).map((c) => {
              const Icon = eventIcon(c);
              return (
                <button type="button" key={c.kind} className="tr-tile" onClick={() => add({ kind: c.kind, name: c.name, metric: c.metric, attempts: c.attempts || 1, is_team: !!c.team })}>
                  <Icon size={22} />{c.name}
                </button>
              );
            })}
          </div>
          <div className="tr-sep" />
          <label className="tr-field"><span className="tr-label"><Plus size={14} />Your own</span>
            <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tyre flips" />
          </label>
          <div className="tr-mini">{options.metrics.map((m) => <button type="button" key={m.key} aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>{METRIC_WORD[m.key]}</button>)}</div>
          <button type="button" className="tr-cta" disabled={name.trim().length < 2} onClick={() => add({ name: name.trim(), metric, attempts: metric === 'weight' ? 3 : 1 })}><Plus size={16} />Add</button>
        </>
      )}
      <Problem text={error} />
    </TSheet>
  );
}

export function EditSheet({ open, onClose, t, onDone }) {
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setF({
      name: t.name, tagline: t.tagline || '', venue: t.venue || '', prize: t.prize || '', rules: t.rules || '',
      visibility: t.visibility, capacity: t.capacity || '', overall_positions: t.overall_positions,
      starts_at: toLocalInput(t.starts_at), registration_opens_at: toLocalInput(t.registration_opens_at),
      registration_closes_at: toLocalInput(t.registration_closes_at), withdraw_closes_at: toLocalInput(t.withdraw_closes_at),
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api(`/tournaments/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: f.name.trim(), tagline: f.tagline.trim() || null, venue: f.venue.trim() || null, prize: f.prize.trim() || null, rules: f.rules.trim() || null,
          visibility: f.visibility, capacity: f.capacity ? Number(f.capacity) : null, overall_positions: f.overall_positions,
          starts_at: fromLocalInput(f.starts_at), registration_opens_at: fromLocalInput(f.registration_opens_at),
          registration_closes_at: fromLocalInput(f.registration_closes_at), withdraw_closes_at: fromLocalInput(f.withdraw_closes_at),
        }),
      });
      onDone('Saved');
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const text = (key, label, max) => (
    <label className="tr-field"><span className="tr-label">{label}</span>
      <input className="input" maxLength={max} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </label>
  );
  const date = (key, label) => (
    <label className="tr-field"><span className="tr-label">{label}</span>
      <input className="input" type="datetime-local" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </label>
  );

  return (
    <TSheet theme={t.theme} open={open} onClose={onClose} title="Edit tournament"
      footer={<button type="button" className="tr-cta tr-cta-block" disabled={busy || !f || f.name.trim().length < 2} onClick={save}><Check size={16} />Save</button>}>
      {f && (
        <>
          {text('name', 'Name', 80)}
          {text('tagline', 'Tagline', 140)}
          <div className="tr-pair">{text('venue', 'Venue', 120)}{text('prize', 'Prize', 200)}</div>
          <label className="tr-field"><span className="tr-label">Rules</span>
            <textarea className="input" rows={3} maxLength={1000} value={f.rules} onChange={(e) => setF({ ...f, rules: e.target.value })} />
          </label>
          <div className="tr-toggle" role="group" aria-label="Entry">
            <button type="button" aria-pressed={f.visibility === 'public'} onClick={() => setF({ ...f, visibility: 'public' })}>Open</button>
            <button type="button" aria-pressed={f.visibility === 'private'} onClick={() => setF({ ...f, visibility: 'private' })}>By request</button>
          </div>
          <div className="tr-row" style={{ justifyContent: 'space-between' }}><span className="tr-label"><Crown size={14} />Overall winners</span>
            <Stepper label="Overall winners" value={f.overall_positions} onChange={(v) => setF({ ...f, overall_positions: v })} /></div>
          <label className="tr-field"><span className="tr-label">Spots</span>
            <input className="input" type="number" min="0" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} placeholder="Unlimited" />
          </label>
          {date('starts_at', 'Starts')}
          <div className="tr-pair">{date('registration_opens_at', 'Entries open')}{date('registration_closes_at', 'Entries close')}</div>
          {date('withdraw_closes_at', 'Last chance to leave')}
        </>
      )}
      <Problem text={error} />
    </TSheet>
  );
}

const AUDIT_WORDS = {
  score_corrected: 'Corrected a score', score_cleared: 'Cleared a score', event_started: 'Started', event_finished: 'Finished',
  event_reopened: 'Reopened', event_removed: 'Removed', tournament_finished: 'Finished the tournament', tournament_cancelled: 'Cancelled',
};

export function AuditSheet({ open, onClose, t }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!open) return;
    setRows(null);
    api(`/tournaments/${t.id}/audit`).then((r) => setRows(r.entries)).catch(() => setRows([]));
  }, [open, t.id]);
  return (
    <TSheet theme={t.theme} open={open} onClose={onClose} title="Activity" sub="Every change to a score stays here">
      {!rows && <Spinner />}
      {rows?.length === 0 && <div className="tr-muted">Nothing yet.</div>}
      {rows?.map((r, i) => (
        <div key={`${r.created_at}-${i}`} className="tr-row" style={{ alignItems: 'flex-start' }}>
          <div className="tr-grow">
            <div style={{ color: 'var(--ink)', fontSize: '.8125rem', fontWeight: 700 }}>{AUDIT_WORDS[r.action] || r.action.replace(/_/g, ' ')}{r.detail ? `: ${r.detail}` : ''}</div>
            <div className="tr-faint">{r.actor || 'Someone'} · {fmtWhen(r.created_at)}</div>
          </div>
        </div>
      ))}
    </TSheet>
  );
}
