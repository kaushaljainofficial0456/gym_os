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
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Plus, Search } from 'lucide-react';
import { api } from '../../api.js';
import { exerciseLabel } from '../../utils.js';

const REGIONS = [['chest', 'Chest'], ['back', 'Back'], ['shoulders', 'Shoulders'], ['arms', 'Arms'], ['legs', 'Legs'], ['core', 'Core']];
const EQUIP = [['barbell', 'Barbell'], ['dumbbell', 'Dumbbell'], ['machine', 'Machine'], ['cable', 'Cable'], ['bodyweight', 'Bodyweight'], ['kettlebell', 'Kettlebell'], ['bands', 'Bands']];

const pretty = (s) => String(s || '').replace(/_/g, ' ').toLowerCase();

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

export default function ExerciseSearchList({ fallback, addedIds, onPick, onQuickAdd, placeholder = 'Search exercises — e.g. incline, DB curl' }) {
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

  const list = results ?? (fallback || []);
  return (
    <div className="grid gap-2.5">
      <label className="wk-search">
        <Search size={16} strokeWidth={2} aria-hidden="true" />
        <input className="input" aria-label="Search exercises" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <ChipRow options={REGIONS} value={region} onChange={setRegion} label="Filter by muscle group" />
      <ChipRow options={EQUIP} value={equip} onChange={setEquip} label="Filter by equipment" />
      <div className="wk-pick" aria-busy={loading || undefined}>
        {loading && <div className="text-[12px] px-1 py-1" style={{ color: 'var(--mute)' }}>Searching…</div>}
        {!loading && fallback == null && results == null && <div className="text-[12px] px-1 py-3 text-center" style={{ color: 'var(--mute)' }}>Loading the library…</div>}
        {!loading && (results != null || fallback != null) && !list.length && (
          <div className="text-[12.5px] px-1 py-4 text-center" style={{ color: 'var(--mute)' }}>No exercises match — try fewer filters.</div>
        )}
        {list.slice(0, 40).map((x) => {
          const added = addedIds?.has(x.id);
          const meta = `${pretty(x.primary_muscle)}${x.equipment ? ` · ${pretty(x.equipment)}` : ''}`;
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
