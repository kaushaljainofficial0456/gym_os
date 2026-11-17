/**
 * The one exercise picker -- search + muscle/equipment chips + results.
 * The workout builder and the in-session "Add exercise" both use it, so
 * they share the same alias-aware search (GET /workouts/exercises). With
 * no text and no filter it shows `fallback` (the cached full library).
 *
 * Each row has two controls: the name opens the exercise's detail (demo,
 * muscles, form cue) through `onPick`, and the round "+" adds it straight
 * away through `onQuickAdd`, without leaving the search. Without
 * `onQuickAdd` a row is a single button that picks.
 *
 * "By muscle" swaps the search for the 3D body: turn it, tap a muscle,
 * and the list underneath is that muscle's exercises (MusclePicker).
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Info, PersonStanding, Plus, Search } from 'lucide-react';
import { api } from '../../api.js';
import { exerciseLabel } from '../../utils.js';

const REGIONS = [['chest', 'Chest'], ['back', 'Back'], ['shoulders', 'Shoulders'], ['arms', 'Arms'], ['legs', 'Legs'], ['core', 'Core']];
const EQUIP = [['barbell', 'Barbell'], ['dumbbell', 'Dumbbell'], ['machine', 'Machine'], ['cable', 'Cable'], ['bodyweight', 'Bodyweight'], ['kettlebell', 'Kettlebell'], ['bands', 'Bands']];

const pretty = (s) => String(s || '').replace(/_/g, ' ').toLowerCase();

// The picker (and with it the muscle map) loads only when "By muscle" is
// opened; the 3D body inside it is lazier still.
const MusclePicker = lazy(() => import('../anatomy/MusclePicker.jsx'));
const MUSCLE_ALIASES = {
  CHEST: ['CHEST', 'UPPER CHEST', 'LOWER CHEST'],
  'FRONT DELTS': ['FRONT DELTS', 'SHOULDERS'],
  'SIDE DELTS': ['SIDE DELTS', 'SHOULDERS'],
  'REAR DELTS': ['REAR DELTS', 'SHOULDERS'],
  'LOWER BACK': ['LOWER BACK', 'POSTERIOR CHAIN'],
  HAMSTRINGS: ['HAMSTRINGS', 'POSTERIOR CHAIN'],
  ABS: ['ABS', 'CORE'],
};
const GROUP_LABEL = {
  CHEST: 'Chest', 'FRONT DELTS': 'Front delts', 'SIDE DELTS': 'Side delts', 'REAR DELTS': 'Rear delts', TRAPS: 'Traps',
  'UPPER BACK': 'Upper back', LATS: 'Lats', BICEPS: 'Biceps', TRICEPS: 'Triceps', FOREARMS: 'Forearms', ABS: 'Abs',
  CORE: 'Core', 'LOWER BACK': 'Lower back', GLUTES: 'Glutes', QUADS: 'Quads', HAMSTRINGS: 'Hamstrings', CALVES: 'Calves',
};

function ChipRow({ options, value, onChange, label }) {
  return (
    <div className="wk-fchips no-scrollbar" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className="wk-fchip" aria-pressed={value === v}
          onClick={() => onChange(v === value ? '' : v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * MULTI-SELECT (`selected` + `onToggle`): a row tap selects or deselects,
 * the circle on the left shows the order the exercises will be added in,
 * and the "i" opens the detail (`onPick`). The session uses this, so a
 * member can pick several exercises in one go instead of re-opening the
 * search for each.
 */
export default function ExerciseSearchList({ fallback, addedIds, onPick, onQuickAdd, selected, onToggle, placeholder = 'Search exercises — e.g. incline, DB curl' }) {
  const [mode, setMode] = useState('search'); // search | body
  const [muscle, setMuscle] = useState(null);
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('');
  const [equip, setEquip] = useState('');
  const [results, setResults] = useState(null); // null => show fallback
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map());

  useEffect(() => {
    const active = q.trim() || region || equip;
    if (!active) { setResults(null); setLoading(false); return undefined; }
    const key = `${q.trim().toLowerCase()}|${region}|${equip}`;
    if (cache.current.has(key)) { setResults(cache.current.get(key)); return undefined; }
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const p = new URLSearchParams();
        if (q.trim()) p.set('q', q.trim());
        if (region) p.set('region', region);
        if (equip) p.set('equipment', equip);
        const r = await api(`/workouts/exercises?${p.toString()}`);
        const list = r.exercises || [];
        cache.current.set(key, list);
        setResults(list);
      } catch { setResults([]); } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(h);
  }, [q, region, equip]);

  const byMuscle = useMemo(() => {
    if (!muscle) return [];
    const want = new Set(MUSCLE_ALIASES[muscle] || [muscle]);
    return (fallback || []).filter((x) => want.has(String(x.primary_muscle || '').toUpperCase()));
  }, [muscle, fallback]);

  const list = mode === 'body' ? byMuscle : (results ?? (fallback || []));
  return (
    <div className="grid grid-cols-1 gap-2.5">
      <div className="wk-modes" role="tablist" aria-label="Find exercises">
        <button type="button" role="tab" aria-selected={mode === 'search'} onClick={() => setMode('search')}>
          <Search size={15} strokeWidth={2} aria-hidden="true" />Search
        </button>
        <button type="button" role="tab" aria-selected={mode === 'body'} onClick={() => setMode('body')}>
          <PersonStanding size={16} strokeWidth={2} aria-hidden="true" />By muscle
        </button>
      </div>
      {mode === 'search' ? (
        <>
          <label className="wk-search">
            <Search size={16} strokeWidth={2} aria-hidden="true" />
            <input className="input" aria-label="Search exercises" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <ChipRow options={REGIONS} value={region} onChange={setRegion} label="Filter by muscle group" />
          <ChipRow options={EQUIP} value={equip} onChange={setEquip} label="Filter by equipment" />
        </>
      ) : (
        <>
          <Suspense fallback={<div className="wk-bodywait" aria-hidden="true" />}>
            <MusclePicker selected={muscle} onSelect={setMuscle} />
          </Suspense>
          <div className="wk-musclehead" aria-live="polite">
            {muscle
              ? <><b>{GROUP_LABEL[muscle] || pretty(muscle)}</b> · {fallback ? `${byMuscle.length} ${byMuscle.length === 1 ? 'exercise' : 'exercises'}` : 'loading…'}</>
              : 'Tap a muscle to see its exercises'}
          </div>
        </>
      )}
      <div className="wk-pick" aria-busy={loading || undefined}>
        {mode === 'search' && loading && <div className="text-[12px] px-1 py-1" style={{ color: 'var(--mute)' }}>Searching…</div>}
        {!loading && fallback == null && (mode === 'body' || results == null) && <div className="text-[12px] px-1 py-3 text-center" style={{ color: 'var(--mute)' }}>Loading the library…</div>}
        {mode === 'search' && !loading && (results != null || fallback != null) && !list.length && (
          <div className="text-[12.5px] px-1 py-4 text-center" style={{ color: 'var(--mute)' }}>No exercises match — try fewer filters.</div>
        )}
        {mode === 'body' && muscle && fallback && !list.length && (
          <div className="text-[12.5px] px-1 py-4 text-center" style={{ color: 'var(--mute)' }}>No exercises for this muscle in your library yet.</div>
        )}
        {list.slice(0, 40).map((x) => {
          const added = addedIds?.has(x.id);
          const meta = `${pretty(x.primary_muscle)}${x.equipment ? ` · ${pretty(x.equipment)}` : ''}`;
          if (onToggle) {
            const order = selected ? selected.indexOf(x.id) : -1;
            const on = order >= 0;
            const name = exerciseLabel(x.name);
            return (
              <div key={x.id} className={`wk-pick__row wk-pick__row--sel${on ? ' is-selected' : ''}`} aria-disabled={added || undefined}>
                <button type="button" className="wk-pick__main" aria-pressed={on} disabled={added}
                  aria-label={added ? `${name}, already in your workout` : on ? `${name}, selected ${order + 1}. Tap to remove` : `Select ${name}`}
                  onClick={() => onToggle(x)}>
                  <span className="wk-pick__tick" aria-hidden="true">
                    {added ? <Check size={14} strokeWidth={3} /> : on ? <b key={order}>{order + 1}</b> : null}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="wk-pick__name truncate">{name}</span>
                    <span className="wk-pick__meta">{added ? 'In your workout' : meta}</span>
                  </span>
                </button>
                {onPick && (
                  <button type="button" className="wk-iconbtn wk-iconbtn--sm" aria-label={`About ${name}`} onClick={() => onPick(x)}>
                    <Info size={16} strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          }
          if (!onQuickAdd) {
            return (
              <button key={x.id} type="button" className="wk-pick__row" disabled={added} aria-disabled={added || undefined} onClick={() => onPick(x)}>
                <span className="flex-1 min-w-0">
                  <span className="wk-pick__name truncate">{exerciseLabel(x.name)}</span>
                  <span className="wk-pick__meta">{meta}</span>
                </span>
                {added && <Check size={16} strokeWidth={2.4} aria-hidden="true" style={{ color: 'var(--good)' }} />}
              </button>
            );
          }
          return (
            <div key={x.id} className="wk-pick__row" aria-disabled={added || undefined}>
              <button type="button" className="flex-1 min-w-0 text-left" onClick={() => onPick(x)}>
                <span className="wk-pick__name truncate">{exerciseLabel(x.name)}</span>
                <span className="wk-pick__meta">{added ? 'In your workout' : meta}</span>
              </button>
              <button type="button" className={`wk-iconbtn wk-iconbtn--sm${added ? '' : ' wk-iconbtn--add'}`} disabled={added}
                aria-label={added ? `${exerciseLabel(x.name)} added` : `Add ${exerciseLabel(x.name)}`}
                onClick={(e) => { e.stopPropagation(); if (!added) onQuickAdd(x); }}>
                {added
                  ? <Check size={15} strokeWidth={2.4} aria-hidden="true" style={{ color: 'var(--good)' }} />
                  : <Plus size={16} strokeWidth={2.4} aria-hidden="true" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
