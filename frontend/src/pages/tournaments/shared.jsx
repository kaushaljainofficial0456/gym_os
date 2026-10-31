/**
 * What every tournament screen shares: icons, themes, time, the search box.
 * Importing this file is what loads tournaments.css, so anything outside the
 * feature (the Home banner) must not import it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, BicepsFlexed, Bike, Bus, Car, DoorOpen, Dumbbell, Film, Flag, Flame, Footprints, Hourglass, Lock,
  Mountain, Music, Piano, Radio, Repeat, Rocket, Ruler, Search, Swords, Target, Timer, Trophy, UserRound,
  Users, Weight, X, Zap, Building2, Check,
} from './icons.jsx';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import './tournaments.css';

const KIND_ICON = {
  squats: Dumbbell, push_ups: Flame, pull_ups: BicepsFlexed, burpees: Zap, sit_ups: Target,
  plank: Timer, wall_sit: Timer, dead_hang: Timer, deadlift: Dumbbell, bench_press: Dumbbell, back_squat: Dumbbell,
  farmer_carry: Footprints, sprint: Rocket, rowing: Rocket, tug_of_war: Swords, relay: Swords,
};
export const METRIC_ICON = { reps: Repeat, time_high: Timer, time_low: Zap, weight: Weight, distance: Ruler, wins: Swords };
export const METRIC_WORD = {
  reps: 'Most reps', time_high: 'Longest hold', time_low: 'Fastest time', weight: 'Heaviest lift', distance: 'Furthest', wins: 'Most wins',
};
export const eventIcon = (e) => KIND_ICON[e?.kind] || METRIC_ICON[e?.metric] || Trophy;

/** The icon names insights.js sends with each physical comparison. */
export const COMPARE_ICON = {
  bike: Bike, bus: Bus, car: Car, film: Film, flame: Flame, footprints: Footprints,
  mountain: Mountain, music: Music, piano: Piano, rocket: Rocket, target: Target,
};

export const themeClass = (theme) => (theme ? `tr-theme-${theme}` : '');

/**
 * Each competition's own colour, by its place in the tournament: the base
 * passes the colour-blind checks on both surfaces, the second stop is its
 * glow. The same pair is its icon, its bars and its ring on every screen.
 */
export const EVENT_COLORS = [
  ['#0A84FF', '#4CD2FF'], ['#F4511E', '#FFB340'], ['#00AE68', '#8BEB4A'],
  ['#A64DFF', '#F45BDC'], ['#BF8600', '#FFD84D'], ['#FF2E7E', '#FF9CC0'],
];
export const eventStyle = (index) => {
  const [a, b] = EVENT_COLORS[Math.max(0, index) % EVENT_COLORS.length];
  return { '--e-a': a, '--e-b': b };
};
export const useTournamentBase = () => {
  const { isClient } = useAuth();
  return isClient ? '/app/client/tournaments' : '/app/trainer/tournaments';
};
export const joinUrl = (code) => `${window.location.origin}/t/${code}`;

export const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
}) : '');
export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

/** ISO <-> the local time a datetime-local input shows. */
export const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export const ordinal = (n) => {
  const rest = n % 100;
  const suffix = rest >= 11 && rest <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
};

const PHASE = {
  live: { label: 'Live', tone: 'tr-chip-live', icon: Radio },
  open: { label: 'Open', tone: 'tr-chip-open', icon: DoorOpen },
  soon: { label: 'Opens soon', tone: 'tr-chip-warn', icon: Hourglass },
  closed: { label: 'Entries closed', tone: '', icon: Lock },
  completed: { label: 'Finished', tone: '', icon: Flag },
  cancelled: { label: 'Cancelled', tone: '', icon: X },
};

/** The top of every tournament screen. `lead` sits in the bar, left of the actions. */
export function Hero({ back, actions, lead, eyebrow, title, tagline, children }) {
  return (
    <section className="tr-hero">
      {(back || actions || lead) && (
        <div className="tr-hero-top">
          {back ? <button type="button" className="tr-hero-back" aria-label={back.label} onClick={back.onClick}><ArrowLeft size={18} /></button> : (lead || <span />)}
          {actions && <div className="tr-hero-actions">{actions}</div>}
        </div>
      )}
      {eyebrow && <div className="tr-eyebrow">{eyebrow}</div>}
      <h1 className="tr-title">{title}</h1>
      {tagline && <p className="tr-tagline">{tagline}</p>}
      {children}
    </section>
  );
}

export const RailItem = ({ value, label, place }) => (
  <div className="tr-rail-item"><b>{place && <i className="tr-mini-medal" data-place={place} />}{value}</b><span>{label}</span></div>
);

export function PhaseChip({ phase, onHero }) {
  const p = PHASE[phase] || PHASE.closed;
  if (onHero) {
    return <span className="tr-phase" data-phase={phase}>{phase === 'live' ? <i className="tr-dot-live" /> : phase === 'open' ? <i /> : null}{p.label}</span>;
  }
  return (
    <span className={`tr-chip ${p.tone}`}>
      {phase === 'live' ? <i className="tr-dot-live" /> : <p.icon size={12} />}{p.label}
    </span>
  );
}

export function Stepper({ value, min = 1, max = 10, onChange, label }) {
  return (
    <span className="tr-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer: ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <span>{value}</span>
      <button type="button" aria-label={`More: ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </span>
  );
}

export const initialsOf = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
export const TAvatar = ({ name }) => <span className="tr-avatar" aria-hidden="true">{initialsOf(name)}</span>;

/** Ticks once a second until the moment passes, then reports it has. */
export function useCountdown(iso) {
  const [now, setNow] = useState(() => Date.now());
  const target = iso ? Date.parse(iso) : null;
  useEffect(() => {
    if (!target || target < Date.now()) return undefined;
    // Once a second only in the last hour: with days left, a redraw a second
    // would change nothing on screen.
    const id = setInterval(() => setNow(Date.now()), target - Date.now() > 3600000 ? 30000 : 1000);
    return () => clearInterval(id);
  }, [target]);
  if (!target) return null;
  const left = Math.max(0, target - now);
  const d = Math.floor(left / 86400000);
  const h = Math.floor(left / 3600000) % 24;
  const m = Math.floor(left / 60000) % 60;
  const s = Math.floor(left / 1000) % 60;
  return { over: left === 0, text: d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s` };
}

/** Its own component so its ticking redraws one number, not the whole page. */
export function Countdown({ to, label }) {
  const c = useCountdown(to);
  if (!c || c.over) return null;
  return <RailItem value={c.text} label={label} />;
}

const RELATION_ICON = { same_gym: Building2, community: Users, other_gym: Dumbbell, independent: UserRound };

/**
 * The global search box, for co-hosts and for adding members. Every result
 * says how the person relates to you, so "Rahul" from your gym and a Rahul
 * you have never met do not look the same.
 */
export function PeopleSearch({ onPick, picked = [], placeholder = 'Search name or @username' }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRows(null); setBusy(false); return undefined; }
    setBusy(true);
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api(`/tournaments/people?q=${encodeURIComponent(term)}`)
        .then((r) => { if (seq.current === mine) setRows(r.people); })
        .catch(() => { if (seq.current === mine) setRows([]); })
        .finally(() => { if (seq.current === mine) setBusy(false); });
    }, 260);
    return () => clearTimeout(timer);
  }, [q]);

  const pickedIds = useMemo(() => new Set(picked), [picked]);
  return (
    <div className="tr-section">
      <div className="tr-search">
        <Search size={16} />
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="Search people" autoComplete="off" />
      </div>
      {busy && !rows && <div className="tr-faint">Searching…</div>}
      {rows?.length === 0 && !busy && <div className="tr-faint">Nobody by that name. People can hide themselves from search.</div>}
      {rows?.map((p) => {
        const Icon = RELATION_ICON[p.relation] || UserRound;
        const on = pickedIds.has(p.id);
        return (
          <button type="button" key={p.id} className="tr-option" aria-pressed={on} disabled={on} onClick={() => onPick(p)}>
            <TAvatar name={p.name} />
            <span className="tr-grow">
              <b className="tr-ellipsis">{p.name}</b>
              <small className="tr-ellipsis"><Icon size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />{p.relation_label}{p.username ? ` · @${p.username}` : ''}</small>
            </span>
            {on && <Check size={16} />}
          </button>
        );
      })}
    </div>
  );
}
