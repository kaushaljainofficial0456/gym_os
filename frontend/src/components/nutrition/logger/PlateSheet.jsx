/**
 * THE PLATE LOGGER — say or type the meal, check it, log it once.
 *
 * Replaces "search one food, choose a portion, log, reopen, repeat" for the
 * common case. The flow is the one the best loggers converged on (a staging
 * plate before anything is written, natural units first, learned usuals):
 *
 *   1. Describe: "2 roti, 1 katori dal and a cup of chai" -- typed or
 *      spoken. The server's meal parser prices each food against measured
 *      data in the unit it was said in.
 *   2. Adjust on the plate: − / + in that unit, switch unit, swap to an
 *      alternative ("buffalo milk"), remove. Every change re-prices
 *      instantly from grams the server supplied.
 *   3. Log the plate to its meal, in one write. Undo is a toast, not a
 *      confirmation dialog in the way.
 *
 * Typing a single food name ("paneer") searches instead of parsing, so the
 * same box is also the search box. Barcode, custom macros and photo
 * estimates stay in the classic sheet, one tap away.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api.js';
import { Sheet } from '../../UI.jsx';
import Icon from '../../Icon.jsx';
import { motion, AnimatePresence, useReducedMotion, AnimatedNumber } from '../../../design/motion/index.jsx';
import {
  SLOTS, slotLabel, fromPlateItem, fromSearchFood, fromUsual, priceItem, plateTotals,
  stepQty, switchUnit, unitOf, toLogItems, looksLikeMeal, amountLabel,
} from './plate.js';
import { useSpeech } from './useSpeech.js';

const EXAMPLES = ['2 roti, 1 katori dal and a cup of chai', '2 eggs and 2 slices toast', '1 plate chicken biryani', '1 scoop whey in 300ml milk'];

const Glyph = ({ d, size = 16, sw = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const MINUS = 'M5 12h14';
const PLUS = 'M12 5v14M5 12h14';
const CROSS = 'M18 6 6 18M6 6l12 12';
const ARROW = 'M5 12h14M13 5l7 7-7 7';
const REPEAT = 'M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3';

function ConfidenceTag({ confidence }) {
  if (!confidence || confidence === 'high') return null;
  const low = confidence === 'low' || confidence === 'unreliable';
  return (
    <span
      className="shrink-0 font-grotesk text-[9.5px] font-bold uppercase tracking-[.08em] px-1.5 py-0.5 rounded-md"
      style={low
        ? { background: 'rgb(var(--warn-rgb) / .14)', color: 'var(--warn)' }
        : { background: 'var(--accent-soft)', color: 'var(--mute)' }}
      title={low ? 'Closest match we could find — check it is what you ate' : 'Typical recipe or portion — yours may differ a little'}
    >
      {low ? 'Check' : '≈ Typical'}
    </span>
  );
}

function PlateRow({ item, onChange, onRemove, onSwap, swapping, reduced }) {
  const p = priceItem(item);
  const unit = unitOf(item);
  const [draft, setDraft] = useState(null);
  const commitDraft = () => {
    const n = Number(String(draft).replace(',', '.'));
    if (Number.isFinite(n) && n > 0 && n < 10000) onChange({ ...item, qty: Math.round(n * 100) / 100 });
    setDraft(null);
  };
  const others = item.units.filter((u) => u.key !== item.unitKey);

  return (
    <motion.li
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: -40, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className="rounded-2xl p-3"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-grotesk text-[14px] font-bold truncate" style={{ color: 'var(--ink)' }}>{item.name}</span>
            <ConfidenceTag confidence={item.confidence} />
          </div>
          <div className="font-grotesk text-[11px] mt-0.5 tabular-nums" style={{ color: 'var(--mute)' }}>
            P {p.protein} · C {p.carbs} · F {p.fat}{p.grams != null && unit?.key !== 'g' ? ` · ${p.grams} g` : ''}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-grotesk text-[16px] font-black tabular-nums leading-none" style={{ color: 'var(--ink)' }}>
            <AnimatedNumber value={p.calories} />
          </div>
          <div className="font-grotesk text-[9.5px] uppercase tracking-[.1em] mt-0.5" style={{ color: 'var(--faint)' }}>kcal</div>
        </div>
        <button type="button" onClick={onRemove} aria-label={`Remove ${item.name}`}
                className="shrink-0 w-8 h-8 -mr-1 -mt-1 grid place-items-center rounded-lg" style={{ color: 'var(--faint)' }}>
          <Glyph d={CROSS} size={15} />
        </button>
      </div>

      <div className="mt-2.5 flex items-center gap-2 min-w-0">
        <div className="flex items-center rounded-xl shrink-0" style={{ background: 'var(--accent-soft)' }}>
          <button type="button" className="w-9 h-9 grid place-items-center" style={{ color: 'var(--ink)' }}
                  onClick={() => onChange({ ...item, qty: stepQty(item, -1) })} aria-label={`Less ${item.name}`}>
            <Glyph d={MINUS} />
          </button>
          <input
            className="w-12 text-center bg-transparent outline-none font-grotesk text-[14px] font-bold tabular-nums"
            style={{ color: 'var(--ink)' }}
            inputMode="decimal"
            aria-label={`Amount of ${item.name} in ${unit?.label || 'servings'}`}
            value={draft ?? String(item.qty)}
            onFocus={(e) => { setDraft(String(item.qty)); requestAnimationFrame(() => e.target.select()); }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
          <button type="button" className="w-9 h-9 grid place-items-center" style={{ color: 'var(--ink)' }}
                  onClick={() => onChange({ ...item, qty: stepQty(item, +1) })} aria-label={`More ${item.name}`}>
            <Glyph d={PLUS} />
          </button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar min-w-0 py-0.5" role="group" aria-label={`Unit for ${item.name}`}>
          {[unit, ...others].filter(Boolean).map((u) => {
            const on = u.key === item.unitKey;
            return (
              <button key={u.key} type="button" aria-pressed={on}
                      onClick={() => !on && onChange(switchUnit(item, u.key))}
                      className="shrink-0 px-2.5 h-8 rounded-lg font-grotesk text-[12px] font-semibold whitespace-nowrap transition-colors"
                      style={on
                        ? { background: 'var(--ink)', color: 'var(--bg)' }
                        : { background: 'transparent', color: 'var(--mute)', border: '1px solid var(--line)' }}>
                {u.label}
              </button>
            );
          })}
        </div>
      </div>

      {item.alternatives?.length > 0 && (
        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
          <span className="font-grotesk text-[11px]" style={{ color: 'var(--faint)' }}>Or was it</span>
          {item.alternatives.map((a) => (
            <button key={a.source_id} type="button" disabled={swapping}
                    onClick={() => onSwap(a)}
                    className="px-2 h-7 rounded-lg font-grotesk text-[11.5px] font-semibold transition-opacity"
                    style={{ border: '1px dashed var(--line)', color: 'var(--ink)', opacity: swapping ? 0.5 : 1 }}>
              {a.name}
            </button>
          ))}
        </div>
      )}
    </motion.li>
  );
}

function LoggedBurst({ label, kcal, reduced }) {
  return (
    <motion.div
      className="absolute inset-0 z-20 grid place-items-center"
      style={{ background: 'color-mix(in srgb, var(--bg) 88%, transparent)', backdropFilter: 'blur(6px)' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      role="status" aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="relative w-20 h-20">
          {!reduced && [0, 1, 2].map((i) => (
            <motion.span key={i} className="absolute inset-0 rounded-full"
                         style={{ border: '2px solid var(--accent)' }}
                         initial={{ scale: 0.6, opacity: 0.7 }}
                         animate={{ scale: 1.9 + i * 0.35, opacity: 0 }}
                         transition={{ duration: 0.9, delay: i * 0.12, ease: [0.22, 0.8, 0.3, 1] }} />
          ))}
          <motion.div className="absolute inset-0 rounded-full grid place-items-center"
                      style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                      initial={reduced ? false : { scale: 0.3, rotate: -40 }}
                      animate={{ scale: 1, rotate: 0 }}
                      transition={{ type: 'spring', stiffness: 380, damping: 18 }}>
            <Icon name="check" size={34} />
          </motion.div>
        </div>
        <div className="text-center">
          <div className="font-grotesk text-[16px] font-black" style={{ color: 'var(--ink)' }}>{label}</div>
          <div className="font-grotesk text-[12px] mt-0.5 tabular-nums" style={{ color: 'var(--mute)' }}>{kcal} kcal added</div>
        </div>
      </div>
    </motion.div>
  );
}

export default function PlateSheet({ open, onClose, initialSlot = 'snack', initialText = '', seed = null, onLogged, onClassic }) {
  const reduced = useReducedMotion();
  const [slot, setSlot] = useState(initialSlot);
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);
  const [unresolved, setUnresolved] = useState([]);
  const [describing, setDescribing] = useState(false);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [usuals, setUsuals] = useState([]);
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState('');
  const [logging, setLogging] = useState(false);
  const [done, setDone] = useState(null);
  const [swapping, setSwapping] = useState(null);
  const [announce, setAnnounce] = useState('');
  const inputRef = useRef(null);

  const describe = useCallback(async (raw) => {
    const q = String(raw || '').trim();
    if (!q) return;
    setDescribing(true); setError(''); setResults([]);
    try {
      const r = await api('/me/nutrition/describe', { method: 'POST', body: JSON.stringify({ text: q }) });
      const added = (r.items || []).map(fromPlateItem);
      setItems((cur) => [...cur, ...added]);
      setUnresolved(r.unresolved || []);
      setText('');
      setAnnounce(added.length ? `Added ${added.map((a) => a.name).join(', ')}` : 'Nothing recognised');
      if (!added.length && !(r.unresolved || []).length) setError('Nothing recognised — try naming the food.');
    } catch (e) {
      setError(e.message || 'Could not read that meal');
    } finally {
      setDescribing(false);
    }
  }, []);

  const speech = useSpeech({ onFinal: (t) => describe(t) });

  // Fresh plate on every open, seeded by whatever opened it.
  useEffect(() => {
    if (!open) return;
    setSlot(initialSlot);
    setItems(seed ? [seed] : []);
    setUnresolved([]); setResults([]); setError(''); setDone(null); setText('');
    if (initialText) describe(initialText);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    let live = true;
    api(`/me/nutrition/usuals?slot=${slot}`).then((r) => live && setUsuals(r.usuals || [])).catch(() => live && setUsuals([]));
    return () => { live = false; };
  }, [open, slot]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api('/me/nutrition/recent-meals').then((r) => live && setRecent(r.meals || [])).catch(() => {});
    return () => { live = false; };
  }, [open]);

  // Type-ahead: one food name searches; a described meal waits for Enter.
  useEffect(() => {
    const q = text.trim();
    if (!open || q.length < 2 || looksLikeMeal(q)) { setResults([]); return undefined; }
    let live = true;
    const h = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api(`/me/foods/search?q=${encodeURIComponent(q)}`);
        if (live) setResults((r.foods || []).filter((f) => f.trustworthy !== false).slice(0, 6));
      } catch { if (live) setResults([]); }
      finally { if (live) setSearching(false); }
    }, 220);
    return () => { live = false; clearTimeout(h); };
  }, [text, open]);

  const totals = useMemo(() => plateTotals(items), [items]);
  const repeatable = recent.filter((m) => m.slot === slot).slice(0, 2);

  const update = (id, next) => setItems((cur) => cur.map((x) => (x.id === id ? next : x)));
  const remove = (id) => setItems((cur) => cur.filter((x) => x.id !== id));

  const swap = async (item, alt) => {
    setSwapping(item.id);
    try {
      const r = await api('/me/nutrition/item', { method: 'POST', body: JSON.stringify({ source_id: alt.source_id, ...(alt.staple_key ? { staple_key: alt.staple_key } : {}) }) });
      const next = fromPlateItem(r.item);
      // Keep the amount: 200 ml of milk swapped to buffalo milk is still
      // 200 ml, and 2 eggs swapped to fried eggs are still 2 eggs.
      const oldUnit = unitOf(item);
      const sameUnit = next.units.find((u) => u.label === oldUnit?.label);
      let kept = next;
      if (sameUnit) kept = { ...next, unitKey: sameUnit.key, qty: item.qty };
      else if (oldUnit?.key === 'typed' && oldUnit.grams) kept = { ...next, units: [oldUnit, ...next.units], unitKey: 'typed', qty: item.qty };
      else if (oldUnit?.grams) kept = { ...next, unitKey: 'g', qty: Math.round(oldUnit.grams * item.qty) };
      // Offer the swapped-out food back, so a wrong tap is one tap to undo.
      kept.alternatives = [{ source_id: item.sourceId, staple_key: item.stapleKey, name: item.name }, ...next.alternatives.filter((a) => a.source_id !== item.sourceId)].filter((a) => a.source_id).slice(0, 3);
      setItems((cur) => cur.map((x) => (x.id === item.id ? { ...kept, id: item.id } : x)));
    } catch (e) {
      setError(e.message || 'Could not switch food');
    } finally {
      setSwapping(null);
    }
  };

  const submitText = (e) => {
    e?.preventDefault();
    if (results.length && !looksLikeMeal(text)) {
      addSearch(results[0]);
      return;
    }
    describe(text);
  };

  const addSearch = (f) => {
    setItems((cur) => [...cur, fromSearchFood(f)]);
    setText(''); setResults([]);
    setAnnounce(`Added ${f.name}`);
    inputRef.current?.focus();
  };

  const finish = (label, kcal, payload) => {
    setDone({ label, kcal });
    setTimeout(() => { onLogged?.(payload); onClose?.(); }, reduced ? 250 : 950);
  };

  const logPlate = async () => {
    if (!items.length || logging) return;
    setLogging(true); setError('');
    try {
      const r = await api('/me/nutrition/log-batch', { method: 'POST', body: JSON.stringify({ slot, items: toLogItems(items) }) });
      finish(`Logged to ${slotLabel(slot)}`, totals.calories, { ids: r.ids, slot, count: items.length, calories: totals.calories });
    } catch (e) {
      setError(e.message || 'Could not log that meal');
    } finally {
      setLogging(false);
    }
  };

  const repeatMeal = async (m) => {
    setLogging(true); setError('');
    try {
      const r = await api('/me/nutrition/repeat', { method: 'POST', body: JSON.stringify({ date: m.date, slot: m.slot, to_slot: slot }) });
      finish(`${slotLabel(slot)} repeated`, m.total.calories, { ids: r.ids, slot, count: r.ids.length, calories: m.total.calories });
    } catch (e) {
      setError(e.message || 'Could not repeat that meal');
    } finally {
      setLogging(false);
    }
  };

  const shownText = speech.listening ? speech.interim : text;

  const footer = (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-grotesk text-[18px] font-black tabular-nums leading-none" style={{ color: 'var(--ink)' }}>
          <AnimatedNumber value={totals.calories} /> <span className="text-[11px] font-semibold" style={{ color: 'var(--mute)' }}>kcal</span>
        </div>
        <div className="font-grotesk text-[11px] mt-1 tabular-nums truncate" style={{ color: 'var(--mute)' }}>
          P {totals.protein} · C {totals.carbs} · F {totals.fat}
        </div>
      </div>
      <motion.button
        type="button"
        onClick={logPlate}
        disabled={!items.length || logging}
        whileTap={reduced ? undefined : { scale: 0.96 }}
        className="shrink-0 h-12 px-5 rounded-2xl font-grotesk text-[14px] font-bold flex items-center gap-2"
        style={items.length
          ? { background: 'var(--accent)', color: 'var(--accent-contrast)', boxShadow: '0 8px 24px rgb(var(--accent-rgb) / .28)' }
          : { background: 'var(--accent-soft)', color: 'var(--faint)' }}
      >
        {logging ? 'Logging…' : items.length ? `Log ${items.length} to ${slotLabel(slot)}` : 'Add food to log'}
      </motion.button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} title="What did you eat?" sub="Say it or type it — adjust, then log the whole meal" footer={footer} wide>
      <div className="relative">
        <AnimatePresence>{done && <LoggedBurst label={done.label} kcal={done.kcal} reduced={reduced} />}</AnimatePresence>
        <div className="sr-only" role="status" aria-live="polite">{announce}</div>

        {/* Which meal */}
        <div className="grid grid-cols-4 gap-1 p-1 rounded-2xl" style={{ background: 'var(--accent-soft)' }} role="radiogroup" aria-label="Meal">
          {SLOTS.map((s) => {
            const on = s.key === slot;
            return (
              <button key={s.key} type="button" role="radio" aria-checked={on} onClick={() => setSlot(s.key)}
                      className="relative h-9 rounded-xl font-grotesk text-[12.5px] font-bold"
                      style={{ color: on ? 'var(--bg)' : 'var(--mute)' }}>
                {on && (
                  <motion.span layoutId={reduced ? undefined : 'plate-slot'} className="absolute inset-0 rounded-xl"
                               style={{ background: 'var(--ink)' }} transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
                )}
                <span className="relative">{s.label}</span>
              </button>
            );
          })}
        </div>

        {/* Describe / search */}
        <form onSubmit={submitText} className="mt-3 flex items-center gap-2 rounded-2xl pl-3.5 pr-1.5 py-1.5"
              style={{ background: 'var(--panel)', border: `1.5px solid ${speech.listening ? 'var(--accent)' : 'var(--line)'}` }}>
          <input
            ref={inputRef}
            value={shownText}
            onChange={(e) => setText(e.target.value)}
            placeholder={speech.listening ? 'Listening…' : 'e.g. 2 roti, dal and a cup of chai'}
            aria-label="Describe your meal, or search for a food"
            className="flex-1 min-w-0 bg-transparent outline-none font-grotesk text-[15px] h-10"
            style={{ color: 'var(--ink)' }}
            enterKeyHint="done"
            autoComplete="off"
          />
          {speech.supported && (
            <motion.button type="button" onClick={speech.listening ? speech.stop : speech.start}
                           aria-label={speech.listening ? 'Stop listening' : 'Speak your meal'}
                           aria-pressed={speech.listening}
                           className="relative w-10 h-10 shrink-0 rounded-xl grid place-items-center"
                           style={speech.listening ? { background: 'var(--accent)', color: 'var(--accent-contrast)' } : { color: 'var(--mute)' }}
                           animate={speech.listening && !reduced ? { scale: [1, 1.08, 1] } : { scale: 1 }}
                           transition={speech.listening ? { repeat: Infinity, duration: 1.1 } : { duration: 0.2 }}>
              <Icon name="mic" size={19} />
            </motion.button>
          )}
          <button type="submit" disabled={!text.trim() || describing}
                  aria-label="Add to plate"
                  className="w-10 h-10 shrink-0 rounded-xl grid place-items-center transition-colors"
                  style={text.trim() ? { background: 'var(--ink)', color: 'var(--bg)' } : { color: 'var(--faint)' }}>
            {describing ? <span className="w-4 h-4 rounded-full border-2 animate-spin" style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }} /> : <Glyph d={ARROW} />}
          </button>
        </form>
        {speech.error && <p className="mt-2 font-grotesk text-[12px]" style={{ color: 'var(--warn)' }}>{speech.error}</p>}
        {error && <p className="mt-2 font-grotesk text-[12px]" style={{ color: 'var(--bad)' }} role="alert">{error}</p>}

        {/* Single-food search results */}
        <AnimatePresence initial={false}>
          {results.length > 0 && (
            <motion.ul key="results" className="mt-2 rounded-2xl overflow-hidden"
                       style={{ border: '1px solid var(--line)', background: 'var(--panel)' }}
                       initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              {results.map((f, i) => {
                const def = (f.portions || []).find((p) => p.default && p.grams > 0);
                const kcal = def ? Math.round((f.calories * def.grams) / 100) : Math.round(f.calories);
                return (
                  <li key={f.source_id || f.id || i} style={{ borderTop: i ? '1px solid var(--line)' : 'none' }}>
                    <button type="button" onClick={() => addSearch(f)} className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left">
                      <span className="min-w-0 flex-1">
                        <span className="block font-grotesk text-[13.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{f.name}</span>
                        <span className="block font-grotesk text-[11px] truncate" style={{ color: 'var(--mute)' }}>
                          {def ? `1 ${def.label} · ${kcal} kcal` : `100 g · ${kcal} kcal`}{f.brand ? ` · ${f.brand}` : ''}
                        </span>
                      </span>
                      <span className="w-8 h-8 shrink-0 rounded-lg grid place-items-center" style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}><Glyph d={PLUS} size={15} /></span>
                    </button>
                  </li>
                );
              })}
            </motion.ul>
          )}
        </AnimatePresence>
        {searching && !results.length && text.trim().length >= 2 && !looksLikeMeal(text) && (
          <p className="mt-2 font-grotesk text-[12px]" style={{ color: 'var(--faint)' }}>Searching…</p>
        )}

        {/* What could not be read is shown, never dropped */}
        {unresolved.length > 0 && (
          <div className="mt-3 rounded-2xl px-3.5 py-2.5" style={{ background: 'rgb(var(--warn-rgb) / .08)', border: '1px solid rgb(var(--warn-rgb) / .25)' }}>
            <div className="font-grotesk text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>Not added — tap to search instead</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {unresolved.map((u, i) => (
                <button key={i} type="button" onClick={() => { setText(u.fragment || ''); setUnresolved((cur) => cur.filter((_, j) => j !== i)); inputRef.current?.focus(); }}
                        className="px-2.5 h-7 rounded-lg font-grotesk text-[12px] font-semibold" style={{ background: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)' }}>
                  “{u.fragment}”
                </button>
              ))}
            </div>
          </div>
        )}

        {/* The plate */}
        {items.length > 0 && (
          <ul className="mt-4 space-y-2.5" aria-label="Your plate">
            <AnimatePresence initial={false}>
              {items.map((it) => (
                <PlateRow key={it.id} item={it} reduced={reduced}
                          swapping={swapping === it.id}
                          onChange={(next) => update(it.id, next)}
                          onRemove={() => remove(it.id)}
                          onSwap={(alt) => swap(it, alt)} />
              ))}
            </AnimatePresence>
          </ul>
        )}

        {/* Empty plate: the fastest paths in */}
        {!items.length && (
          <div className="mt-4 space-y-4">
            {repeatable.length > 0 && (
              <section>
                <h3 className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-bold mb-2" style={{ color: 'var(--mute)' }}>Same as before</h3>
                <div className="space-y-2">
                  {repeatable.map((m) => (
                    <button key={`${m.date}-${m.slot}`} type="button" disabled={logging} onClick={() => repeatMeal(m)}
                            className="w-full flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left"
                            style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
                      <span className="w-9 h-9 shrink-0 rounded-xl grid place-items-center" style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}><Glyph d={REPEAT} size={16} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-grotesk text-[13px] font-bold" style={{ color: 'var(--ink)' }}>
                          {dayName(m.date)}'s {slotLabel(m.slot).toLowerCase()}
                        </span>
                        <span className="block font-grotesk text-[11.5px] truncate" style={{ color: 'var(--mute)' }}>
                          {m.items.map((x) => x.name).join(' · ')}
                        </span>
                      </span>
                      <span className="shrink-0 font-grotesk text-[12px] font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{m.total.calories} kcal</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {usuals.length > 0 && (
              <section>
                <h3 className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-bold mb-2" style={{ color: 'var(--mute)' }}>Your usual {slotLabel(slot).toLowerCase()}</h3>
                <div className="flex flex-wrap gap-2">
                  {usuals.slice(0, 8).map((u) => (
                    <button key={u.name} type="button" onClick={() => setItems((cur) => [...cur, fromUsual(u)])}
                            className="h-9 px-3 rounded-xl font-grotesk text-[12.5px] font-semibold flex items-center gap-1.5"
                            style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}>
                      <Glyph d={PLUS} size={13} />
                      {u.name}
                      <span className="font-normal" style={{ color: 'var(--faint)' }}>{u.quantity ? `${fmtQty(u.quantity)} ${u.unit || ''}`.trim() : ''}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h3 className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-bold mb-2" style={{ color: 'var(--mute)' }}>Try saying</h3>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" onClick={() => describe(ex)}
                          className="h-8 px-3 rounded-lg font-grotesk text-[12px]" style={{ color: 'var(--mute)', border: '1px dashed var(--line)' }}>
                    {ex}
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* Everything else the classic logger does */}
        {onClassic && (
          <div className="mt-5 flex items-center justify-center gap-1 flex-wrap">
            {[
              ['barcode', 'Scan barcode', 'camera'],
              ['custom', 'Custom macros', 'numbers'],
              ['search', 'Photo & more', 'sparkle'],
            ].map(([mode, label, icon]) => (
              <button key={mode} type="button" onClick={() => onClassic(mode)}
                      className="h-9 px-3 rounded-xl font-grotesk text-[12px] font-semibold flex items-center gap-1.5"
                      style={{ color: 'var(--mute)' }}>
                <Icon name={icon} size={15} /> {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function fmtQty(q) {
  const n = Number(q);
  return Number.isInteger(n) ? n : Math.round(n * 10) / 10;
}

function dayName(date) {
  const d = new Date(`${date}T12:00:00`);
  const today = new Date();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  const key = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (key(d) === key(y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long' });
}

export { amountLabel };
