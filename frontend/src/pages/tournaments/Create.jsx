/**
 * HOST A TOURNAMENT. Five short steps, and nothing is created until the last
 * one. `?from=<id>` starts a rematch from an old tournament's competitions.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight, Building2, CalendarClock, Check, Crown, Flag, Gift, Globe, Lock, MapPin, Medal, Palette,
  Plus, Rocket, ShieldCheck, Sparkles, Swords, Timer, Trash2, Trophy, Unlock, Users, X,
} from './icons.jsx';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch } from '../../utils.js';
import { ErrorState, PageSkeleton } from '../../components/UI.jsx';
import {
  eventIcon, eventStyle, fmtDay, fromLocalInput, Hero, METRIC_ICON, METRIC_WORD, PeopleSearch, Stepper, TAvatar, themeClass, toLocalInput, useTournamentBase,
} from './shared.jsx';

const STEPS = [
  { id: 'look', label: 'Name it', icon: Sparkles },
  { id: 'events', label: 'Pick the competitions', icon: Swords },
  { id: 'time', label: 'Set the dates', icon: CalendarClock },
  { id: 'who', label: 'Who can enter', icon: Users },
  { id: 'go', label: 'Bring in co-hosts', icon: Rocket },
];
const THEMES = ['ember', 'neon', 'ocean', 'volt', 'royal'];
const CAPS = [[0, 'No limit'], [60, '1 min'], [120, '2 min'], [300, '5 min']];

const nextSaturday = (weeks) => {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7) + weeks * 7);
  d.setHours(7, 0, 0, 0);
  return d;
};
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); return d; };

const eventKey = (e) => e.kind || e.name;

function EventConfig({ e, index, onChange, onRemove }) {
  const Icon = eventIcon(e);
  const MetricIcon = METRIC_ICON[e.metric];
  const timed = e.metric === 'reps' || e.metric === 'time_high' || e.metric === 'wins';
  return (
    <div className="tr-event-config" style={eventStyle(index)}>
      <div className="tr-row">
        <span className="tr-event-icon"><Icon size={20} /></span>
        <div className="tr-grow">
          <b style={{ color: 'var(--ink)', fontSize: '.875rem' }}>{e.name}</b>
          <div className="tr-faint"><MetricIcon size={11} style={{ display: 'inline', marginRight: 4 }} />{METRIC_WORD[e.metric]}{e.is_team ? ' · Teams' : ''}</div>
        </div>
        <button type="button" className="tr-icon-btn" aria-label={`Remove ${e.name}`} onClick={onRemove}><Trash2 size={15} /></button>
      </div>
      <div className="tr-row" style={{ justifyContent: 'space-between' }}>
        <span className="tr-label"><Medal size={14} />Winners</span>
        <Stepper label={`Winners in ${e.name}`} value={e.win_positions} onChange={(v) => onChange({ win_positions: v })} />
      </div>
      {(e.metric === 'weight' || e.metric === 'distance') && (
        <div className="tr-row" style={{ justifyContent: 'space-between' }}>
          <span className="tr-label"><Flag size={14} />Attempts</span>
          <Stepper label={`Attempts in ${e.name}`} value={e.attempts} max={5} onChange={(v) => onChange({ attempts: v })} />
        </div>
      )}
      {timed && (
        <div className="tr-field">
          <span className="tr-label"><Timer size={14} />Time limit</span>
          <div className="tr-mini">
            {CAPS.map(([sec, label]) => (
              <button type="button" key={sec} aria-pressed={(e.time_cap_sec || 0) === sec} onClick={() => onChange({ time_cap_sec: sec || null })}>{label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Create() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const base = useTournamentBase();
  const { isClient, isIndependent } = useAuth();
  const options = useFetch(() => api('/tournaments/options'));
  const from = params.get('from');

  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '', tagline: '', venue: '', prize: '', rules: '', theme: 'ember',
    visibility: 'public', reach: isIndependent ? 'everyone' : 'gym', audience: 'everyone',
    capacity: '', overall_positions: 3, starts_at: '', registration_opens_at: '', registration_closes_at: '', withdraw_closes_at: '',
  });
  const [events, setEvents] = useState([]);
  const [cohosts, setCohosts] = useState([]);
  const [custom, setCustom] = useState({ open: false, name: '', metric: 'reps', is_team: false });

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!from) return;
    api(`/tournaments/${from}`).then((t) => {
      set({ name: t.name, tagline: t.tagline || '', venue: t.venue || '', prize: t.prize || '', rules: t.rules || '', theme: t.theme, visibility: t.visibility, reach: t.reach, audience: t.audience, overall_positions: t.overall_positions });
      setEvents(t.events.map((e) => ({ kind: e.kind, name: e.name, metric: e.metric, attempts: e.attempts, time_cap_sec: e.time_cap_sec, win_positions: e.win_positions, is_team: e.is_team })));
    }).catch(() => {});
  }, [from]);

  const startsAt = form.starts_at;
  const setStart = (local) => {
    const ms = Date.parse(local);
    const patch = { starts_at: local };
    // The deadlines people forget get sensible defaults, only while empty.
    if (!Number.isNaN(ms)) {
      if (!form.registration_closes_at) patch.registration_closes_at = toLocalInput(new Date(ms - 3600000).toISOString());
      const dayBefore = ms - 86400000;
      if (!form.withdraw_closes_at && dayBefore > Date.now()) patch.withdraw_closes_at = toLocalInput(new Date(dayBefore).toISOString());
    }
    set(patch);
  };

  const toggleEvent = (preset) => {
    setEvents((list) => (list.some((e) => eventKey(e) === preset.kind)
      ? list.filter((e) => eventKey(e) !== preset.kind)
      : [...list, { kind: preset.kind, name: preset.name, metric: preset.metric, attempts: preset.attempts || 1, win_positions: 3, time_cap_sec: null, is_team: !!preset.team }]));
  };
  const addCustom = () => {
    const name = custom.name.trim();
    if (name.length < 2) return;
    setEvents((list) => [...list, { name, metric: custom.metric, attempts: custom.metric === 'weight' ? 3 : 1, win_positions: 3, time_cap_sec: null, is_team: custom.is_team }]);
    setCustom({ open: false, name: '', metric: 'reps', is_team: false });
  };

  const dateProblem = useMemo(() => {
    const ms = (v) => (v ? Date.parse(v) : null);
    const [opens, closes, leave, starts] = [form.registration_opens_at, form.registration_closes_at, form.withdraw_closes_at, form.starts_at].map(ms);
    if (starts && starts < Date.now()) return 'The start time is in the past';
    if (opens && closes && opens >= closes) return 'Registration has to open before it closes';
    if (closes && starts && closes > starts) return 'Registration has to close before the start';
    if (leave && starts && leave > starts) return 'The last day to leave has to be before the start';
    return '';
  }, [form]);

  const blocked = [
    form.name.trim().length < 2 ? 'Give it a name' : '',
    events.length ? '' : 'Pick at least one competition',
    dateProblem,
    '',
    '',
  ][step];

  const launch = async () => {
    setSaving(true); setError('');
    try {
      const body = {
        name: form.name.trim(), theme: form.theme, visibility: form.visibility, reach: form.reach, audience: form.audience,
        tagline: form.tagline.trim() || null, venue: form.venue.trim() || null, prize: form.prize.trim() || null, rules: form.rules.trim() || null,
        capacity: form.capacity ? Number(form.capacity) : null, overall_positions: form.overall_positions,
        starts_at: fromLocalInput(form.starts_at), registration_opens_at: fromLocalInput(form.registration_opens_at),
        registration_closes_at: fromLocalInput(form.registration_closes_at), withdraw_closes_at: fromLocalInput(form.withdraw_closes_at),
        events: events.map(({ kind, name, metric, attempts, time_cap_sec: cap, win_positions: wins, is_team: team }) => ({
          ...(kind ? { kind } : {}), name, metric, attempts, time_cap_sec: cap || null, win_positions: wins, is_team: !!team,
        })),
      };
      const { id } = await api('/tournaments', { method: 'POST', body: JSON.stringify(body) });
      // The tournament exists now: a failed invite must not lose it.
      await Promise.all(cohosts.map((c) => api(`/tournaments/${id}/hosts`, { method: 'POST', body: JSON.stringify({ user_id: c.id }) }).catch(() => null)));
      nav(`${base}/${id}?tab=share`, { replace: true });
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  if (options.loading && !options.data) return <PageSkeleton />;
  if (options.error && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />;
  const { catalog, metrics } = options.data;
  const chosen = new Set(events.map(eventKey));
  const Current = STEPS[step].icon;
  const customEvents = events.filter((e) => !e.kind);

  return (
    <div className={`tr-root ${themeClass(form.theme)}`}>
      <Hero back={{ label: 'Back', onClick: () => (step ? setStep(step - 1) : nav(base)) }}
        eyebrow={<span className="tr-tag">Step {step + 1} of {STEPS.length}</span>}
        title={form.name.trim() || 'Host a tournament'} tagline={form.tagline.trim()} />

      <div className="tr-progress">
        {STEPS.map((s, i) => (
          <button type="button" key={s.id} data-on={i <= step} aria-label={s.label} aria-current={i === step ? 'step' : undefined} disabled={i > step} onClick={() => setStep(i)} />
        ))}
      </div>
      <div className="tr-step-label"><Current size={18} />{STEPS[step].label}</div>

      {step === 0 && (
        <section className="tr-panel tr-section">
          <label className="tr-field"><span className="tr-label"><Trophy size={14} />Tournament name</span>
            <input className="input" value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Iron Wars 2026" autoFocus />
          </label>
          <label className="tr-field"><span className="tr-label"><Sparkles size={14} />Tagline</span>
            <input className="input" value={form.tagline} maxLength={140} onChange={(e) => set({ tagline: e.target.value })} placeholder="Two gyms enter. One keeps the trophy." />
          </label>
          <div className="tr-field"><span className="tr-label"><Palette size={14} />Colours</span>
            <div className="tr-swatches">
              {THEMES.map((t) => (
                <button type="button" key={t} className={`tr-swatch ${themeClass(t)}`} aria-pressed={form.theme === t} aria-label={`${t} colours`} onClick={() => set({ theme: t })}>
                  {form.theme === t && <Check size={16} />}
                </button>
              ))}
            </div>
          </div>
          <div className="tr-pair">
            <label className="tr-field"><span className="tr-label"><MapPin size={14} />Venue</span>
              <input className="input" value={form.venue} maxLength={120} onChange={(e) => set({ venue: e.target.value })} placeholder="Main floor" />
            </label>
            <label className="tr-field"><span className="tr-label"><Gift size={14} />Prize</span>
              <input className="input" value={form.prize} maxLength={200} onChange={(e) => set({ prize: e.target.value })} placeholder="3 months free" />
            </label>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="tr-section">
          <div className="tr-choice-grid">
            {catalog.map((c) => {
              const Icon = eventIcon(c);
              const on = chosen.has(c.kind);
              const order = events.findIndex((e) => eventKey(e) === c.kind);
              return (
                <button type="button" key={c.kind} className="tr-tile" aria-pressed={on} style={on ? eventStyle(order) : undefined} onClick={() => toggleEvent(c)}>
                  {on && <span className="tr-tile-check"><Check size={12} /></span>}
                  <Icon size={22} />{c.name}
                </button>
              );
            })}
            <button type="button" className="tr-tile" aria-pressed={custom.open} onClick={() => setCustom((c) => ({ ...c, open: !c.open }))}>
              <Plus size={22} />Your own
            </button>
          </div>
          {custom.open && (
            <div className="tr-panel tr-section">
              <input className="input" value={custom.name} maxLength={80} onChange={(e) => setCustom((c) => ({ ...c, name: e.target.value }))} placeholder="Tyre flips" aria-label="Competition name" />
              <div className="tr-mini" role="group" aria-label="How it is scored">
                {metrics.map((m) => (
                  <button type="button" key={m.key} aria-pressed={custom.metric === m.key} onClick={() => setCustom((c) => ({ ...c, metric: m.key }))}>{METRIC_WORD[m.key]}</button>
                ))}
              </div>
              <div className="tr-mini">
                <button type="button" aria-pressed={custom.is_team} onClick={() => setCustom((c) => ({ ...c, is_team: !c.is_team }))}>Teams</button>
              </div>
              <button type="button" className="tr-cta" disabled={custom.name.trim().length < 2} onClick={addCustom}><Plus size={16} />Add</button>
            </div>
          )}
          {events.length > 0 && <div className="tr-section-title"><Medal size={14} />Your competitions</div>}
          {events.length > 0 && (
            <div className="tr-list">
              {events.map((e, i) => (
                <EventConfig key={eventKey(e)} e={e} index={i}
                  onChange={(patch) => setEvents((list) => list.map((x) => (eventKey(x) === eventKey(e) ? { ...x, ...patch } : x)))}
                  onRemove={() => setEvents((list) => list.filter((x) => eventKey(x) !== eventKey(e)))} />
              ))}
            </div>
          )}
          {customEvents.length === 0 && events.length === 0 && <div className="tr-faint">Pick any number. You can change them until the tournament starts.</div>}
        </section>
      )}

      {step === 2 && (
        <section className="tr-panel tr-section">
          <div className="tr-field"><span className="tr-label"><Rocket size={14} />Starts</span>
            <input className="input" type="datetime-local" value={startsAt} onChange={(e) => setStart(e.target.value)} aria-label="Tournament start" />
            <div className="tr-mini">
              <button type="button" onClick={() => setStart(toLocalInput(tomorrow().toISOString()))}>Tomorrow</button>
              <button type="button" onClick={() => setStart(toLocalInput(nextSaturday(0).toISOString()))}>Saturday</button>
              <button type="button" onClick={() => setStart(toLocalInput(nextSaturday(1).toISOString()))}>Next Saturday</button>
            </div>
          </div>
          <div className="tr-pair">
            <label className="tr-field"><span className="tr-label"><Unlock size={14} />Entries open</span>
              <input className="input" type="datetime-local" value={form.registration_opens_at} onChange={(e) => set({ registration_opens_at: e.target.value })} />
            </label>
            <label className="tr-field"><span className="tr-label"><Lock size={14} />Entries close</span>
              <input className="input" type="datetime-local" value={form.registration_closes_at} onChange={(e) => set({ registration_closes_at: e.target.value })} />
            </label>
          </div>
          <label className="tr-field"><span className="tr-label"><Flag size={14} />Last chance to leave</span>
            <input className="input" type="datetime-local" value={form.withdraw_closes_at} onChange={(e) => set({ withdraw_closes_at: e.target.value })} />
          </label>
          <div className="tr-faint">{dateProblem ? <span style={{ color: 'rgb(var(--bad-rgb))' }}>{dateProblem}</span> : 'All optional. Leave them empty and entries stay open until you start the first competition.'}</div>
        </section>
      )}

      {step === 3 && (
        <section className="tr-section">
          <div className="tr-pair">
            <button type="button" className="tr-option" aria-pressed={form.visibility === 'public'} onClick={() => set({ visibility: 'public' })}>
              <span className="tr-option-icon"><Unlock size={18} /></span><span><b>Open</b><small>Anyone joins directly</small></span>
            </button>
            <button type="button" className="tr-option" aria-pressed={form.visibility === 'private'} onClick={() => set({ visibility: 'private' })}>
              <span className="tr-option-icon"><Lock size={18} /></span><span><b>By request</b><small>You approve each person</small></span>
            </button>
            <button type="button" className="tr-option" aria-pressed={form.reach === 'gym'} disabled={isIndependent} onClick={() => set({ reach: 'gym' })}>
              <span className="tr-option-icon"><Building2 size={18} /></span><span><b>My gym</b><small>Intra-gym</small></span>
            </button>
            <button type="button" className="tr-option" aria-pressed={form.reach === 'everyone'} onClick={() => set({ reach: 'everyone' })}>
              <span className="tr-option-icon"><Globe size={18} /></span><span><b>All gyms</b><small>Inter-gym, shown to everyone</small></span>
            </button>
            {!isClient && (
              <button type="button" className="tr-option" aria-pressed={form.audience === 'staff'} onClick={() => set({ audience: form.audience === 'staff' ? 'everyone' : 'staff' })}>
                <span className="tr-option-icon"><ShieldCheck size={18} /></span><span><b>Staff only</b><small>Trainers and owners. Hidden from clients</small></span>
              </button>
            )}
          </div>
          <div className="tr-panel tr-section">
            <div className="tr-row" style={{ justifyContent: 'space-between' }}>
              <span className="tr-label"><Crown size={14} />Overall winners</span>
              <Stepper label="Overall winners" value={form.overall_positions} onChange={(v) => set({ overall_positions: v })} />
            </div>
            <label className="tr-field"><span className="tr-label"><Users size={14} />Spots (empty for unlimited)</span>
              <input className="input" type="number" min="0" inputMode="numeric" value={form.capacity} onChange={(e) => set({ capacity: e.target.value })} placeholder="Unlimited" />
            </label>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="tr-section">
          <div className="tr-panel tr-section">
            <div className="tr-faint">Optional. They can add people and record scores, and they get a request first.</div>
            {cohosts.map((c) => (
              <div key={c.id} className="tr-row">
                <TAvatar name={c.name} /><span className="tr-grow tr-ellipsis" style={{ color: 'var(--ink)', fontWeight: 700, fontSize: '.875rem' }}>{c.name}</span>
                <span className="tr-chip">{c.relation_label}</span>
                <button type="button" className="tr-icon-btn" aria-label={`Remove ${c.name}`} onClick={() => setCohosts((l) => l.filter((x) => x.id !== c.id))}><X size={15} /></button>
              </div>
            ))}
            <PeopleSearch picked={cohosts.map((c) => c.id)} onPick={(p) => setCohosts((l) => [...l, p])} />
          </div>
          <div className="tr-kpis">
            <div className="tr-kpi"><Swords size={17} /><strong>{events.length}</strong><span>Competitions</span></div>
            <div className="tr-kpi"><Medal size={17} /><strong>{form.overall_positions}</strong><span>Winners</span></div>
            <div className="tr-kpi"><Rocket size={17} /><strong>{form.starts_at ? fmtDay(fromLocalInput(form.starts_at)) : 'Open'}</strong><span>Start</span></div>
          </div>
          {error && <div role="alert" style={{ color: 'rgb(var(--bad-rgb))', fontSize: '.8125rem', fontWeight: 600 }}>{error}</div>}
        </section>
      )}

      <div className="tr-action">
        <span className="tr-grow tr-faint">{blocked}</span>
        {step < STEPS.length - 1 ? (
          <button type="button" className="tr-cta" disabled={!!blocked} onClick={() => setStep(step + 1)}>Next<ArrowRight size={16} /></button>
        ) : (
          <button type="button" className="tr-cta" disabled={saving} onClick={launch}><Rocket size={16} />{saving ? 'Creating…' : 'Create tournament'}</button>
        )}
      </div>
    </div>
  );
}
