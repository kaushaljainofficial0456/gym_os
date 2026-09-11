/**
 * EXERCISE PICKER — the part of programming that has to be fast.
 *
 * THE PROBLEM IT REPLACES. Adding an exercise used to mean opening a
 * control, choosing one, confirming, closing, and reopening for the next
 * one. A six-exercise session is that loop six times. Programming is
 * inherently repetitive, so friction here multiplies by every exercise of
 * every session of every client.
 *
 * So this STAYS OPEN. Each result has its own "+" and the sheet does not
 * dismiss when you use it: a trainer building a push day taps + four
 * times and closes once. A running count of what was added this session
 * gives the feedback that closing used to provide.
 *
 * IT OPENS ON WHAT YOU ACTUALLY USE. Recent exercises come from this
 * trainer's own programming history, because the same twenty movements
 * cover most sessions and an alphabetical wall of six hundred is the
 * slowest possible starting point. A trainer with no history sees
 * categories instead -- never a fabricated "popular" list.
 *
 * NAMES ARE HUMAN. The library stores names already; nothing here ever
 * renders a slug like front_squat. Where a raw identifier is all we have,
 * prettyName turns it into words rather than showing the database.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';

/** Turn a raw identifier into words, for the rare row whose name is a
 *  slug. Never used to REPLACE a real name -- only as a last resort. */
export function prettyName(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (!/[_-]/.test(s) && /[a-z]/.test(s) && /[A-Z\s]/.test(s)) return s;
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Muscle groups, labelled for people. The values are what the API
 *  filters on; the labels are what a coach says out loud. */
const MUSCLES = [
  ['', 'All'],
  ['CHEST', 'Chest'],
  ['BACK', 'Back'],
  ['SHOULDERS', 'Shoulders'],
  ['BICEPS', 'Arms'],
  ['QUADS', 'Legs'],
  ['GLUTES', 'Glutes'],
  ['CORE', 'Core'],
];

export default function ExercisePicker({ open, onClose, onAdd, onOpenMuscleMap, addedCount = 0 }) {
  const [query, setQuery] = useState('');
  const [muscle, setMuscle] = useState('');
  const [results, setResults] = useState([]);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [justAdded, setJustAdded] = useState(null);
  const inputRef = useRef(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!open) return;
    api('/workouts/exercises/recent')
      .then((r) => setRecent(r.recent || []))
      .catch(() => setRecent([]));
    setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  /* Debounced, and guarded by a request id: without the guard a slow
     response for "ben" can land after the fast one for "bench" and
     overwrite the better results with worse ones. */
  useEffect(() => {
    if (!open) return undefined;
    const mine = ++reqId.current;
    const t = setTimeout(async () => {
      setLoading(true); setErr('');
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set('q', query.trim());
        if (muscle) params.set('muscle', muscle);
        const r = await api(`/workouts/exercises?${params.toString()}`);
        if (reqId.current === mine) setResults((r.exercises || []).slice(0, 60));
      } catch (e) {
        if (reqId.current === mine) { setErr(e.message || 'Could not load exercises'); setResults([]); }
      }
      if (reqId.current === mine) setLoading(false);
    }, query.trim() ? 220 : 0);
    return () => clearTimeout(t);
  }, [open, query, muscle]);

  const add = useCallback((ex) => {
    onAdd(ex);
    // A brief tick on the row that was used: the sheet stays open, so
    // without it there is no confirmation that the tap landed.
    setJustAdded(ex.id || ex.exerciseId);
    setTimeout(() => setJustAdded(null), 900);
  }, [onAdd]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const showRecent = !query.trim() && !muscle && recent.length > 0;

  /* PORTALLED TO document.body ON PURPOSE. An ancestor of this screen
     carries .anim-fadeUp, and any transform -- even the identity matrix
     an finished animation leaves behind -- makes that element the
     containing block for position:fixed descendants. Rendered in place,
     this overlay was therefore laid out against the scrolled page rather
     than the viewport: measured on a 375x812 screen it began 1292px
     above the fold and ran 2309px tall. The same fix is already used by
     FoodLogSheet and the client Workout builder for the same reason. */
  return createPortal((
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
      style={{ background: 'rgba(0,0,0,.55)' }}
      onClick={onClose}
      role="dialog" aria-modal="true" aria-label="Add exercise"
    >
      <div
        className="w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl flex flex-col"
        style={{
          background: 'var(--bg)', border: '1px solid var(--line)',
          maxHeight: 'min(86vh, 720px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 pb-3 shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="font-grotesk font-bold text-[15px]" style={{ color: 'var(--ink)' }}>
              Add exercise
            </h2>
            <button
              type="button" onClick={onClose}
              className="rounded-lg px-3 text-[12px] font-semibold"
              style={{ minHeight: 38, color: 'var(--mute)' }}
            >
              {addedCount > 0 ? `Done · ${addedCount} added` : 'Close'}
            </button>
          </div>

          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search exercises"
            aria-label="Search exercises"
            className="input w-full text-[13px]"
            style={{ minHeight: 44 }}
          />

          {/* The anatomical picker is still here, one tap away, rather
              than as a second dashed button competing with this one.
              The chips cover the same intent faster; the map is for
              people who think in bodies, not lists. */}
          {onOpenMuscleMap && (
            <button
              type="button"
              onClick={onOpenMuscleMap}
              className="mt-2 text-[11.5px] font-semibold"
              style={{ color: 'var(--accent)' }}
            >
              Browse the muscle map instead
            </button>
          )}

          <div className="flex gap-1.5 mt-2.5 overflow-x-auto pb-1" role="tablist" aria-label="Muscle group">
            {MUSCLES.map(([value, label]) => {
              const on = muscle === value;
              return (
                <button
                  key={label} role="tab" aria-selected={on}
                  onClick={() => setMuscle(value)}
                  className="rounded-lg px-3 text-[11.5px] font-semibold shrink-0"
                  style={{
                    minHeight: 34,
                    background: on ? 'var(--accent-soft)' : 'transparent',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                    color: on ? 'var(--accent)' : 'var(--mute)',
                  }}
                >{label}</button>
              );
            })}
          </div>
        </div>

        <div className="overflow-y-auto p-3 flex-1">
          {showRecent && (
            <>
              <div className="t-micro mb-2 px-1">Recent</div>
              <div className="space-y-1.5 mb-4">
                {recent.map((r) => (
                  <Row
                    key={`recent-${r.exerciseId}`}
                    title={prettyName(r.name)}
                    sub={r.uses > 1 ? `used ${r.uses} times` : 'used once'}
                    added={justAdded === r.exerciseId}
                    onAdd={() => add({ id: r.exerciseId, name: r.name })}
                  />
                ))}
              </div>
              <div className="t-micro mb-2 px-1">All exercises</div>
            </>
          )}

          {loading && results.length === 0 && (
            <div className="text-[12px] py-6 text-center" style={{ color: 'var(--mute)' }}>Searching…</div>
          )}
          {err && <div className="text-[12px] py-4 text-center" style={{ color: 'var(--bad)' }}>{err}</div>}
          {!loading && !err && results.length === 0 && (
            <div className="py-8 text-center">
              <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>
                No exercises match “{query.trim()}”
              </div>
              <div className="text-[11.5px] mt-1" style={{ color: 'var(--mute)' }}>
                Try a shorter word, or clear the muscle filter.
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            {results.map((ex) => (
              <Row
                key={ex.id}
                title={prettyName(ex.name)}
                sub={[prettyName(ex.primary_muscle), prettyName(ex.equipment)].filter(Boolean).join(' · ')}
                added={justAdded === ex.id}
                onAdd={() => add(ex)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  ), document.body);
}

function Row({ title, sub, added, onAdd }) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-3 py-2"
      style={{ minHeight: 52, background: 'var(--panel)', border: '1px solid var(--line)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{title}</div>
        {sub && <div className="text-[10.5px] mt-0.5 truncate" style={{ color: 'var(--mute)' }}>{sub}</div>}
      </div>
      <button
        type="button"
        onClick={onAdd}
        aria-label={`Add ${title}`}
        className="shrink-0 rounded-lg font-bold transition-colors"
        style={{
          minWidth: 44, minHeight: 38,
          background: added ? 'var(--good)' : 'var(--accent-soft)',
          border: `1px solid ${added ? 'var(--good)' : 'var(--accent)'}`,
          color: added ? 'var(--accent-contrast)' : 'var(--accent)',
        }}
      >
        {added ? '✓' : '+'}
      </button>
    </div>
  );
}
