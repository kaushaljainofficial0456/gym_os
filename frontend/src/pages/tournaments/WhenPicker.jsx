/**
 * PICKING A DATE. A fixture strip of days and a drum of hours and minutes,
 * opening in place under the row it belongs to, one at a time.
 *
 * Why not <input type="datetime-local">: on a phone it has a wide minimum
 * size it will not give up, which is what pushed two of them over each other,
 * and it opens the phone's own calendar with nothing of this app in it.
 *
 * Values stay datetime-local strings ("2026-11-07T07:00"), so nothing around
 * this had to change. Days are built from local date parts, never from
 * toISOString, or a late-evening start lands on the wrong gym day.
 *
 * The motion is cheap on purpose. The wheels are native scroll with CSS snap,
 * so they run on the compositor; one rAF only writes transforms to the few
 * rows in view, without going through React. The day pill is a single
 * element sliding on transform.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Flag, Lock, Rocket, Unlock } from './icons.jsx';

const ROW = 42;
const DAY_W = 58;
const DAY_GAP = 6;
const DAYS_AHEAD = 240;
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));
const PERIODS = ['AM', 'PM'];
const HOUR_MS = 3600000;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localString = (d) => `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const shifted = (local, ms) => localString(new Date(new Date(local).getTime() + ms));
const motionOff = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const buzz = () => { try { navigator.vibrate?.(3); } catch { /* not every phone */ } };

export const whenLabel = (local) => {
  if (!local) return '';
  const d = new Date(local);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};

function roundToFive(d) {
  const out = new Date(d);
  out.setMinutes(Math.round(out.getMinutes() / 5) * 5, 0, 0);
  return out;
}

function partsOf(date) {
  const h = date.getHours();
  return { day: dayKey(date), hour: (h + 11) % 12, minute: date.getMinutes() / 5, period: h >= 12 ? 1 : 0 };
}

function build({ day, hour, minute, period }) {
  const h = (hour + 1) % 12 + (period ? 12 : 0);
  return `${day}T${pad(h)}:${pad(minute * 5)}`;
}

const buildDays = (selected) => {
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  const until = new Date(`${selected}T12:00`);
  const total = Math.max(DAYS_AHEAD, Math.ceil((until - start) / 86400000) + 14);
  const today = dayKey(start);
  return Array.from({ length: total }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = dayKey(d);
    return {
      key,
      week: key === today ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }),
      date: d.getDate(),
      month: d.toLocaleDateString(undefined, { month: 'short' }),
      monthKey: key.slice(0, 7),
      weekend: d.getDay() === 0 || d.getDay() === 6,
    };
  });
};

const Day = memo(function Day({ day, on, off, onPick }) {
  return (
    <button type="button" className="tr-day" role="option" aria-selected={on} disabled={off} data-weekend={day.weekend || undefined}
      aria-label={`${day.week} ${day.date} ${day.month}`} onClick={() => onPick(day.key)}>
      <small>{day.week}</small>
      <b>{day.date}</b>
    </button>
  );
});

function DayStrip({ selected, onPick, isOff }) {
  const [days] = useState(() => buildDays(selected));
  const ref = useRef(null);
  const frame = useRef(0);
  const index = Math.max(0, days.findIndex((d) => d.key === selected));
  const months = useMemo(() => {
    const seen = new Map();
    days.forEach((d, i) => { if (!seen.has(d.monthKey)) seen.set(d.monthKey, { key: d.monthKey, label: d.month, index: i }); });
    return [...seen.values()];
  }, [days]);
  const [month, setMonth] = useState(days[index]?.monthKey);

  const centre = useCallback((i, smooth) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ left: i * (DAY_W + DAY_GAP) - (el.clientWidth - DAY_W) / 2, behavior: smooth && !motionOff() ? 'smooth' : 'auto' });
  }, []);

  useLayoutEffect(() => { centre(index, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { centre(index, true); }, [index, centre]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const i = Math.round((el.scrollLeft + el.clientWidth / 2 - DAY_W / 2) / (DAY_W + DAY_GAP));
      const next = days[Math.max(0, Math.min(days.length - 1, i))]?.monthKey;
      setMonth((m) => (m === next ? m : next));
    });
  };

  return (
    <div className="tr-days-wrap">
      <div className="tr-months" role="group" aria-label="Month">
        {months.slice(0, 9).map((m) => (
          <button type="button" key={m.key} aria-pressed={month === m.key} onClick={() => centre(m.index, true)}>{m.label}</button>
        ))}
      </div>
      <div className="tr-days-scroll" ref={ref} onScroll={onScroll} role="listbox" aria-label="Day">
        <div className="tr-days" style={{ width: days.length * (DAY_W + DAY_GAP) - DAY_GAP }}>
          <i className="tr-day-pill" aria-hidden="true" style={{ transform: `translateX(${index * (DAY_W + DAY_GAP)}px)` }} />
          {days.map((d) => <Day key={d.key} day={d} on={d.key === selected} off={isOff(d.key)} onPick={onPick} />)}
        </div>
      </div>
    </div>
  );
}

/** One drum. The list never re-renders while it turns. */
const Wheel = memo(function Wheel({ items, index, onChange, label }) {
  const ref = useRef(null);
  const frame = useRef(0);
  const reported = useRef(index);
  const change = useRef(onChange);
  change.current = onChange;

  const paint = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const pos = el.scrollTop / ROW;
    const rows = el.children;
    const from = Math.max(0, Math.floor(pos) - 3);
    const to = Math.min(items.length - 1, Math.ceil(pos) + 3);
    for (let i = from; i <= to; i += 1) {
      const d = i - pos;
      const far = Math.min(Math.abs(d), 3);
      rows[i + 1].style.transform = `rotateX(${(-d * 22).toFixed(1)}deg) scale(${(1 - far * 0.07).toFixed(3)})`;
      rows[i + 1].style.opacity = String(Math.max(0.16, 1 - far * 0.3));
    }
    const nearest = Math.max(0, Math.min(items.length - 1, Math.round(pos)));
    if (nearest !== reported.current) {
      reported.current = nearest;
      buzz();
      change.current(nearest);
    }
  }, [items.length]);

  useLayoutEffect(() => {
    ref.current.scrollTop = index * ROW;
    paint();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Follows a change that did not come from this wheel, such as a shortcut.
  useEffect(() => {
    if (index === reported.current) return;
    reported.current = index;
    ref.current?.scrollTo({ top: index * ROW, behavior: motionOff() ? 'auto' : 'smooth' });
  }, [index]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(paint);
  };
  const go = (i) => ref.current?.scrollTo({ top: Math.max(0, Math.min(items.length - 1, i)) * ROW, behavior: motionOff() ? 'auto' : 'smooth' });
  const onKeyDown = (e) => {
    const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    go(index + step);
  };

  return (
    <div className="tr-wheel" ref={ref} onScroll={onScroll} onKeyDown={onKeyDown} tabIndex={0} role="listbox" aria-label={label}>
      <span className="tr-wheel-gap" aria-hidden="true" />
      {items.map((item, i) => (
        <button type="button" key={item} className="tr-wheel-item" tabIndex={-1} role="option" aria-selected={i === index} onClick={() => go(i)}>{item}</button>
      ))}
      <span className="tr-wheel-gap" aria-hidden="true" />
    </div>
  );
});

function Picker({ value, fallback, min, max, presets, onCommit, onDone, canClear, onClear, onSkip }) {
  const [parts, setParts] = useState(() => partsOf(roundToFive(new Date(value || fallback))));
  const draft = build(parts);

  const set = useCallback((patch) => {
    setParts((p) => ({ ...p, ...patch }));
  }, []);

  // Keeps the row above in step as the wheels turn. What the picker opens on
  // is only a suggestion, so opening an empty row must not fill it in.
  const opened = useRef(draft);
  useEffect(() => {
    if (draft === opened.current) return;
    opened.current = null;
    onCommit(draft);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const setHour = useCallback((hour) => set({ hour }), [set]);
  const setMinute = useCallback((minute) => set({ minute }), [set]);
  const setPeriod = useCallback((period) => set({ period }), [set]);
  const setDay = useCallback((day) => { buzz(); set({ day }); }, [set]);
  const isOff = useCallback((key) => (min && key < min.slice(0, 10)) || (max && key > max.slice(0, 10)), [min, max]);

  const readDay = new Date(draft).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const readTime = new Date(draft).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const late = (max && draft > max) || (min && draft < min);

  return (
    <div className="tr-when">
      <div className="tr-when-read" aria-live="polite">
        <b key={readDay}>{readDay}</b>
        <span key={readTime}>{readTime}</span>
      </div>
      {presets?.length > 0 && (
        <div className="tr-mini">
          {presets.map((p) => (
            <button type="button" key={p.label} onClick={() => { if (p.value) setParts(partsOf(roundToFive(new Date(p.value)))); else onClear(); }}>{p.label}</button>
          ))}
        </div>
      )}
      <DayStrip selected={parts.day} onPick={setDay} isOff={isOff} />
      <div className="tr-wheels">
        <Wheel items={HOURS} index={parts.hour} onChange={setHour} label="Hour" />
        <Wheel items={MINUTES} index={parts.minute} onChange={setMinute} label="Minute" />
        <Wheel items={PERIODS} index={parts.period} onChange={setPeriod} label="AM or PM" />
      </div>
      {late && <div role="alert" className="tr-when-problem">{max && draft > max ? 'This has to be before the start.' : 'This time has already passed.'}</div>}
      <div className="tr-when-foot">
        <button type="button" className="tr-icon-text" onClick={canClear ? onClear : onSkip}>{canClear ? 'Clear' : 'Not now'}</button>
        <button type="button" className="tr-cta tr-cta-small" onClick={() => { onCommit(draft); onDone(); }}><Check size={15} />Done</button>
      </div>
    </div>
  );
}

function WhenRow({ icon: Icon, label, empty, value, open, onToggle, picker }) {
  const ref = useRef(null);
  const mounted = useRef(false);
  // Brings the whole picker on screen, except when the page opens with it.
  useEffect(() => {
    if (open && mounted.current) ref.current?.scrollIntoView({ block: 'start', behavior: motionOff() ? 'auto' : 'smooth' });
    mounted.current = true;
  }, [open]);
  return (
    <div className="tr-when-row" ref={ref} data-open={open || undefined}>
      <button type="button" className="tr-when-head" aria-expanded={open} onClick={onToggle}>
        <span className="tr-option-icon"><Icon size={18} /></span>
        <span className="tr-grow">
          <small>{label}</small>
          <b data-empty={!value || undefined}>{value ? whenLabel(value) : empty}</b>
        </span>
        <ChevronDown size={18} className="tr-when-chevron" aria-hidden="true" />
      </button>
      {open && <div className="tr-when-open"><div>{picker}</div></div>}
    </div>
  );
}

/**
 * The four moments of a tournament, as one list. `values` holds local
 * strings, and `onChange(key, value)` gets '' when one is cleared.
 */
export function WhenList({ values, onChange, firstOpen = null, onOpenChange }) {
  const [open, setOpen] = useState(firstOpen);
  useEffect(() => { onOpenChange?.(!!open); }, [open, onOpenChange]);
  const start = values.starts_at;
  const nowLocal = useMemo(() => localString(new Date()), []);
  const tomorrow = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(7, 0, 0, 0); return localString(d); }, []);

  const saturday = (weeks) => {
    const d = new Date();
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7) + weeks * 7);
    d.setHours(7, 0, 0, 0);
    return localString(d);
  };
  const tomorrowEvening = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); return localString(d); };
  const before = (hours, label) => (start && Date.parse(start) - hours * HOUR_MS > Date.now()
    ? { label, value: shifted(start, -hours * HOUR_MS) } : null);

  const rows = [
    {
      key: 'starts_at', label: 'Starts', icon: Rocket, empty: 'Pick a date', min: nowLocal, fallback: tomorrow,
      presets: [{ label: 'Tomorrow evening', value: tomorrowEvening() }, { label: 'Saturday', value: saturday(0) }, { label: 'Next Saturday', value: saturday(1) }],
    },
    {
      key: 'registration_opens_at', label: 'Entries open', icon: Unlock, empty: 'Right away', max: start || null, fallback: nowLocal,
      presets: [{ label: 'Right away', value: null }],
    },
    {
      key: 'registration_closes_at', label: 'Entries close', icon: Lock, empty: 'When it starts', max: start || null, fallback: start ? shifted(start, -HOUR_MS) : tomorrow,
      presets: [before(1, '1 hour before'), before(24, '1 day before'), before(72, '3 days before')].filter(Boolean),
    },
    {
      key: 'withdraw_closes_at', label: 'Last chance to leave', icon: Flag, empty: 'Until it starts', max: start || null, fallback: start ? shifted(start, -24 * HOUR_MS) : tomorrow,
      presets: [before(24, '1 day before'), before(48, '2 days before'), before(168, '1 week before')].filter(Boolean),
    },
  ];

  return (
    <div className="tr-list">
      {rows.map((r) => (
        <WhenRow key={r.key} icon={r.icon} label={r.label} empty={r.empty} value={values[r.key]} open={open === r.key}
          onToggle={() => setOpen(open === r.key ? null : r.key)}
          picker={(
            <Picker value={values[r.key]} fallback={r.fallback} min={r.min} max={r.max} presets={r.presets}
              canClear={!!values[r.key]} onCommit={(v) => onChange(r.key, v)} onDone={() => setOpen(null)} onSkip={() => setOpen(null)}
              onClear={() => { onChange(r.key, ''); setOpen(null); }} />
          )} />
      ))}
    </div>
  );
}
