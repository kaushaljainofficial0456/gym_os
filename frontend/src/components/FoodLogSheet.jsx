/**
 * FOOD LOG SHEET — search → choose portion → (oil) → add.
 *
 * WHY A SHEET RATHER THAN MORE ROWS IN THE PICKER:
 * Logging a food is three decisions (which food, how much, how it was
 * cooked) and the old picker only asked the first, defaulting the rest
 * silently. Portion size is the single largest error source after picking
 * the wrong food entirely — "1 katori dal" is 150 g and "1 bowl" is 250 g,
 * a 66% difference on the same dish — so it deserves a real control, not
 * an assumption.
 *
 * WHAT IS DELIBERATELY *NOT* COMPUTED HERE:
 * grams, macros and the oil adjustment all come from the server
 * (`/me/foods/resolve`). Portion→grams depends on the food's own density
 * and measured serving weight, and the oil model applies the chosen level
 * as a DELTA from the dish's own recipe oil — so picking "low" on an
 * already-oily dish correctly *reduces* calories. Re-implementing either
 * here is how the UI and the model start disagreeing, which is exactly the
 * class of bug that made the old estimator untrustworthy.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Pressable } from '../design/index.js';
import Icon from './Icon.jsx';
import BarcodeScanner from './BarcodeScanner.jsx';

const OIL_LEVELS = [
  ['none', 'None'],
  ['low', 'Low'],
  ['moderate', 'Moderate'],
  ['high', 'High'],
  ['very_high', 'Very high'],
];

/** Portion groups, in the order a person actually reaches for them. */
const GROUP_ORDER = ['count', 'bowl', 'plate', 'glass', 'spoon', 'misc'];

export default function FoodLogSheet({ open, onClose, onAdd }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [food, setFood] = useState(null);
  const [portionKey, setPortionKey] = useState(null);
  const [count, setCount] = useState(1);
  const [grams, setGrams] = useState('');
  const [oil, setOil] = useState(null);
  const [resolved, setResolved] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [listening, setListening] = useState(false);
  const inputRef = useRef(null);

  const startVoice = () => {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) { setErr('Voice input not available on this device'); return; }
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setListening(true);
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      setQ(text);
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  };

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 120);
    if (!open) {
      setQ(''); setResults([]); setFood(null); setResolved(null);
      setPortionKey(null); setCount(1); setGrams(''); setOil(null); setErr('');
    }
  }, [open]);

  // Type-ahead. Debounced so a fast typist does not fire a request per key.
  useEffect(() => {
    const term = q.trim();
    if (food || term.length < 2) { setResults([]); setSearching(false); return undefined; }
    setSearching(true);
    let dead = false;
    const h = setTimeout(() => {
      api(`/me/foods/search?q=${encodeURIComponent(term)}`)
        .then((r) => { if (!dead) setResults(r.foods || []); })
        .catch(() => { if (!dead) setResults([]); })
        .finally(() => { if (!dead) setSearching(false); });
    }, 200);
    return () => { dead = true; clearTimeout(h); };
  }, [q, food]);

  // Ask the server for grams + macros whenever the quantity changes.
  useEffect(() => {
    if (!food) { setResolved(null); return undefined; }
    let dead = false;
    const h = setTimeout(() => {
      api('/me/foods/resolve', {
        method: 'POST',
        body: JSON.stringify({
          source_id: food.source_id, name: food.name,
          portion_key: portionKey || undefined,
          count: Number(count) || 1,
          grams: grams ? Number(grams) : undefined,
          oil_level: oil || undefined,
        }),
      })
        .then((r) => { if (!dead) { setResolved(r); setErr(''); } })
        .catch((e) => { if (!dead) { setResolved(null); setErr(e.message || 'Could not price that quantity'); } });
    }, 120);
    return () => { dead = true; clearTimeout(h); };
  }, [food, portionKey, count, grams, oil]);

  const groups = useMemo(() => {
    const ps = food?.portions || [];
    const by = {};
    for (const p of ps) (by[p.group] ||= []).push(p);
    return GROUP_ORDER.filter((g) => by[g]?.length).map((g) => [g, by[g]]);
  }, [food]);

  if (!open) return null;

  const pick = (f) => {
    setFood(f);
    setResults([]);
    // Default to the food's own serving when it has one, else grams entry.
    const first = (f.portions || []).find((p) => p.basis === 'serving')
      || (f.portions || []).find((p) => p.group === 'bowl')
      || (f.portions || [])[0];
    setPortionKey(first?.key || null);
    if (!first) setGrams('100');
  };

  const commit = async () => {
    if (!food || !resolved) return;
    setBusy(true);
    try {
      await onAdd({ food, resolved });
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not add that food');
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
         style={{ background: 'rgb(var(--bg-rgb) / .72)', backdropFilter: 'blur(4px)' }}
         onClick={onClose}>
      <div className="card w-full sm:max-w-md max-h-[88vh] overflow-y-auto rounded-b-none sm:rounded-2xl"
           onClick={(e) => e.stopPropagation()}>

        <div className="sticky top-0 z-10 px-4 pt-4 pb-3" style={{ background: 'var(--panel)' }}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>
              {food ? 'How much?' : 'Add food'}
            </div>
            <button onClick={onClose} aria-label="Close" style={{ color: 'var(--mute)' }}>✕</button>
          </div>

          {!food && (
            <>
            <div className="mt-2 flex gap-2">
              <input
                ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Search any food…" aria-label="Search foods"
                className="input flex-1 !py-2.5 text-[14px]" />
              <Pressable onClick={startVoice} aria-label="Voice input"
                         className={`btn !px-3 !py-2.5 shrink-0 ${listening ? 'btn-primary' : ''}`}>
                <Icon name="mic" size={17} />
              </Pressable>
              <Pressable onClick={() => setScanning(true)} aria-label="Scan barcode"
                         className="btn !px-3 !py-2.5 shrink-0">
                <Icon name="camera" size={17} />
              </Pressable>
            </div>
            {listening && <div className="text-[10px] mt-1.5 anim-pulse-soft" style={{ color: 'var(--accent)' }}>Listening…</div>}
            </>
          )}
        </div>

        <div className="px-4 pb-4">
          {/* ── results ── */}
          {!food && (
            <div className="space-y-1">
              {searching && !results.length && (
                <div className="text-[11px] py-3" style={{ color: 'var(--faint)' }}>Searching…</div>
              )}
              {!searching && q.trim().length >= 2 && !results.length && (
                <div className="text-[11px] py-3" style={{ color: 'var(--faint)' }}>
                  Nothing matched “{q.trim()}”.
                </div>
              )}
              {results.map((f) => (
                <button key={f.id || f.source_id} onClick={() => pick(f)}
                        disabled={f.trustworthy === false}
                        className="w-full text-left rounded-xl px-3 py-2 flex items-center justify-between gap-2 disabled:opacity-45"
                        style={{ border: '1px solid var(--line)' }}>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{f.name}</span>
                    <span className="text-[10px]" style={{ color: 'var(--mute)' }}>
                      {f.trustworthy === false
                        ? (f.data_quality_flag || 'Data quality flagged')
                        : `${f.calories == null ? '—' : Math.round(f.calories)} kcal / 100 g`}
                      {f.brand ? ` · ${f.brand}` : ''}
                    </span>
                  </span>
                  {f.confidence && f.confidence !== 'high' && (
                    <span className="text-[8px] uppercase tracking-wider shrink-0" style={{ color: 'var(--faint)' }}>
                      {f.confidence}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* ── quantity ── */}
          {food && (
            <div className="space-y-4">
              <div>
                <div className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>{food.name}</div>
                <button onClick={() => { setFood(null); setResolved(null); }}
                        className="text-[10px] underline mt-0.5" style={{ color: 'var(--mute)' }}>
                  change food
                </button>
              </div>

              {groups.map(([group, ps]) => (
                <div key={group}>
                  <div className="text-[9px] uppercase tracking-[.16em] mb-1.5" style={{ color: 'var(--faint)' }}>
                    {group}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ps.map((p) => {
                      const on = portionKey === p.key && !grams;
                      return (
                        <button key={p.key}
                                onClick={() => { setPortionKey(p.key); setGrams(''); }}
                                className="rounded-full px-2.5 py-1 text-[11px] transition-colors"
                                style={on
                                  ? { background: 'var(--accent)', color: 'var(--accent-contrast)', border: '1px solid var(--accent)' }
                                  : { border: '1px solid var(--line)', color: 'var(--mute)' }}>
                          {p.label}
                          <span className="opacity-60"> · {Math.round(p.grams)}g</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="flex items-end gap-3">
                <label className="flex-1">
                  <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>How many</span>
                  <input type="number" min="0.25" step="0.25" value={count}
                         onChange={(e) => setCount(e.target.value)}
                         className="input w-full !py-2 mt-1 tabular-nums" aria-label="Portion count" />
                </label>
                <span className="pb-2.5 text-[10px]" style={{ color: 'var(--faint)' }}>or</span>
                <label className="flex-1">
                  <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Weigh it (g)</span>
                  <input type="number" min="1" step="1" value={grams} placeholder="—"
                         onChange={(e) => { setGrams(e.target.value); if (e.target.value) setPortionKey(null); }}
                         className="input w-full !py-2 mt-1 tabular-nums" aria-label="Grams" />
                </label>
              </div>

              {/* Oil only for things that are cooked — offering it on an
                  apple is noise. */}
              {food.oil_applicable && (
                <div>
                  <div className="text-[9px] uppercase tracking-[.16em] mb-1.5" style={{ color: 'var(--faint)' }}>
                    Oil used
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {OIL_LEVELS.map(([key, label]) => {
                      const on = oil === key;
                      return (
                        <button key={key} onClick={() => setOil(on ? null : key)}
                                className="rounded-full px-2.5 py-1 text-[11px]"
                                style={on
                                  ? { background: 'var(--accent)', color: 'var(--accent-contrast)', border: '1px solid var(--accent)' }
                                  : { border: '1px solid var(--line)', color: 'var(--mute)' }}>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {resolved?.oil && (
                    <div className="text-[10px] mt-1.5" style={{ color: 'var(--mute)' }}>
                      {resolved.oil.delta_kcal >= 0 ? '+' : ''}{Math.round(resolved.oil.delta_kcal)} kcal vs this dish’s usual oil
                    </div>
                  )}
                </div>
              )}

              {/* Always show the resolved grams — it is how a user catches a
                  bad unit conversion before it reaches their day's total. */}
              <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--accent-soft)', border: '1px solid var(--line)' }}>
                {resolved ? (
                  <>
                    <div className="flex items-baseline justify-between">
                      <span className="font-black text-[22px] tabular-nums" style={{ color: 'var(--ink)' }}>
                        {resolved.totals?.energy_kcal == null ? '—' : Math.round(resolved.totals.energy_kcal)}
                      </span>
                      <span className="text-[11px] tabular-nums" style={{ color: 'var(--mute)' }}>
                        {resolved.grams} g · {resolved.quantity_label}
                      </span>
                    </div>
                    <div className="text-[10px] mt-1" style={{ color: 'var(--mute)' }}>
                      {/* null means NOT MEASURED, never 0. */}
                      P {resolved.totals?.protein_g ?? '—'} · C {resolved.totals?.carb_g ?? '—'} · F {resolved.totals?.fat_g ?? '—'}
                    </div>
                    {resolved.grams_basis === 'assumed_100g' && (
                      <div className="text-[10px] mt-1" style={{ color: 'var(--warn)' }}>
                        No serving size on record — assuming 100 g. Adjust if you know better.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>{err || 'Working it out…'}</div>
                )}
              </div>

              <Pressable onClick={commit} disabled={!resolved || busy}
                         className="btn-primary w-full !py-3.5 text-[13px] font-bold">
                {busy ? 'Adding…' : 'Add to log'}
              </Pressable>
            </div>
          )}

          {err && !food && <div className="text-[11px] mt-2" style={{ color: 'var(--bad)' }}>{err}</div>}
        </div>
      </div>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onScanned={(item) => {
          setScanning(false);
          if (!item) return;
          // A scan already knows the product AND its serving, so it drops
          // straight into the quantity step rather than back into search.
          setFood({
            source_id: item.food.source_id,
            name: item.food.food_name,
            brand: item.food.brand,
            calories: item.food.energy_kcal,
            portions: [],
            oil_applicable: false,
          });
          setGrams(String(item.quantity.grams));
          setPortionKey(null);
        }}
      />
    </div>
  );
}
