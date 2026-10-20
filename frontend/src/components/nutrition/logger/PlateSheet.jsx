/**
 * THE FULL PLATE — the logger with every tool, for when the quick path on
 * the page (LogCard.jsx) is not enough: searching one food by name,
 * changing units, swapping "milk" for "buffalo milk", repeating a past meal,
 * barcode and custom macros.
 *
 * The same rules as the page: one line per food (PlateRow.jsx), details on
 * tap, and an AI estimate wherever the database falls short -- the ✨ in
 * the input, a row under search results, and on anything not found.
 *
 * The meal a plate is filed under comes from the clock; nobody picks one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api.js';
import { Sheet } from '../../UI.jsx';
import Icon from '../../Icon.jsx';
import { motion, AnimatePresence, useReducedMotion, AnimatedNumber } from '../../../design/motion/index.jsx';
import {
  slotLabel, fromPlateItem, fromSearchFood, fromUsual, plateTotals, unitOf, toLogItems, looksLikeMeal, amountLabel,
} from './plate.js';
import { aiEstimateItem } from './ai.js';
import { useSpeech } from './useSpeech.js';
import PlateRow from './PlateRow.jsx';
import FoodResults, { useFoodSearch } from './FoodResults.jsx';

const Glyph = ({ d, size = 16, sw = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const PLUS = 'M12 5v14M5 12h14';
const ARROW = 'M5 12h14M13 5l7 7-7 7';
const SPARK = 'M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8Z';
const REPEAT = 'M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3';

function Spinner() {
  return <span className="w-4 h-4 rounded-full border-2 animate-spin" style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }} aria-hidden="true" />;
}

function LoggedBurst({ kcal, reduced }) {
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
        <div className="font-grotesk text-[15px] font-black tabular-nums" style={{ color: 'var(--ink)' }}>+{kcal} kcal</div>
      </div>
    </motion.div>
  );
}

export default function PlateSheet({ open, onClose, initialSlot = 'snack', initialText = '', seed = null, seedItems = null, onLogged, onClassic }) {
  const reduced = useReducedMotion();
  const [slot, setSlot] = useState(initialSlot);
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);
  const [unresolved, setUnresolved] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const search = useFoodSearch(text, { enabled: open });
  const type = (v) => { setText(v); setShowAll(false); };
  const [usuals, setUsuals] = useState([]);
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);       // 'describe' | 'ai' | `ai:${id}` | 'log' | 'swap'
  const [done, setDone] = useState(null);
  const inputRef = useRef(null);

  const describe = useCallback(async (raw) => {
    const q = String(raw || '').trim();
    if (!q) return;
    setBusy('describe'); setError('');
    try {
      const r = await api('/me/nutrition/describe', { method: 'POST', body: JSON.stringify({ text: q }) });
      const added = (r.items || []).map(fromPlateItem);
      setItems((cur) => [...cur, ...added]);
      setUnresolved(r.unresolved || []);
      setText(''); setShowAll(false);
      if (!added.length && !(r.unresolved || []).length) setError('Nothing recognised — try naming the food.');
    } catch (e) {
      setError(e.message || 'Could not read that meal');
    } finally { setBusy(null); }
  }, []);

  const speech = useSpeech({ onFinal: (t) => describe(t) });

  useEffect(() => {
    if (!open) return;
    setSlot(initialSlot);
    setItems(seedItems?.length ? seedItems : seed ? [seed] : []);
    setUnresolved([]); setShowAll(false); setError(''); setDone(null); setText('');
    if (initialText) describe(initialText);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    api(`/me/nutrition/usuals?slot=${slot}`).then((r) => live && setUsuals(r.usuals || [])).catch(() => live && setUsuals([]));
    api('/me/nutrition/recent-meals').then((r) => live && setRecent(r.meals || [])).catch(() => {});
    return () => { live = false; };
  }, [open, slot]);

  const totals = useMemo(() => plateTotals(items), [items]);
  const repeatable = recent.filter((m) => m.slot === slot).slice(0, 2);

  const update = (id, next) => setItems((cur) => cur.map((x) => (x.id === id ? next : x)));
  const remove = (id) => setItems((cur) => cur.filter((x) => x.id !== id));

  const askAI = async (query, key = 'ai') => {
    if (busy) return false;
    setBusy(key); setError('');
    try {
      const it = await aiEstimateItem(query);
      setItems((cur) => [...cur, it]);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally { setBusy(null); }
  };

  const swap = async (item, alt) => {
    setBusy('swap');
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
      // The swapped-out food is offered back, so a wrong tap is one tap to undo.
      kept.alternatives = [{ source_id: item.sourceId, staple_key: item.stapleKey, name: item.name }, ...next.alternatives.filter((a) => a.source_id !== item.sourceId)].filter((a) => a.source_id).slice(0, 3);
      setItems((cur) => cur.map((x) => (x.id === item.id ? { ...kept, id: item.id, assumed: item.assumed } : x)));
    } catch (e) {
      setError(e.message || 'Could not switch food');
    } finally { setBusy(null); }
  };

  const addSearch = (f) => {
    setItems((cur) => [...cur, fromSearchFood(f)]);
    type('');
    inputRef.current?.focus();
  };

  // → / Enter: a food name shows every match (the top two show while
  // typing); a described meal is read as a meal.
  const submitText = (e) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q) return;
    if (!looksLikeMeal(q) && (search.results.length || search.searching) && !showAll) { setShowAll(true); return; }
    describe(q);
  };

  const finish = (kcal, payload) => {
    setDone({ kcal });
    setTimeout(() => { onLogged?.(payload); onClose?.(); }, reduced ? 250 : 900);
  };

  const logPlate = async () => {
    if (!items.length || busy) return;
    setBusy('log'); setError('');
    try {
      const r = await api('/me/nutrition/log-batch', { method: 'POST', body: JSON.stringify({ slot, items: toLogItems(items) }) });
      finish(totals.calories, { ids: r.ids, slot, count: items.length, calories: totals.calories });
    } catch (e) {
      setError(e.message || 'Could not log that meal');
    } finally { setBusy(null); }
  };

  const repeatMeal = async (m) => {
    setBusy('log'); setError('');
    try {
      const r = await api('/me/nutrition/repeat', { method: 'POST', body: JSON.stringify({ date: m.date, slot: m.slot, to_slot: slot }) });
      finish(m.total.calories, { ids: r.ids, slot, count: r.ids.length, calories: m.total.calories });
    } catch (e) {
      setError(e.message || 'Could not repeat that meal');
    } finally { setBusy(null); }
  };

  const typed = text.trim();
  const shownText = speech.listening ? speech.interim : text;

  const footer = (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-grotesk text-[18px] font-black tabular-nums leading-none" style={{ color: 'var(--ink)' }}>
          <AnimatedNumber value={totals.calories} /> <span className="text-[11px] font-semibold" style={{ color: 'var(--mute)' }}>kcal</span>
        </div>
        <div className="font-grotesk text-[11px] mt-1 tabular-nums truncate" style={{ color: 'var(--faint)' }}>
          P {totals.protein} · C {totals.carbs} · F {totals.fat}
        </div>
      </div>
      <motion.button
        type="button" onClick={logPlate} disabled={!items.length || !!busy}
        whileTap={reduced ? undefined : { scale: 0.96 }}
        className="shrink-0 h-12 px-6 rounded-2xl font-grotesk text-[14px] font-bold"
        style={items.length
          ? { background: 'var(--accent)', color: 'var(--accent-contrast)', boxShadow: '0 8px 24px rgb(var(--accent-rgb) / .28)' }
          : { background: 'var(--accent-soft)', color: 'var(--faint)' }}
      >
        {busy === 'log' ? 'Logging…' : 'Log'}
      </motion.button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} title="Add food" footer={footer} wide>
      <div className="relative">
        <AnimatePresence>{done && <LoggedBurst kcal={done.kcal} reduced={reduced} />}</AnimatePresence>

        <form onSubmit={submitText} className="pill-field flex items-center gap-1 rounded-2xl pl-3.5 pr-1 py-1"
              style={{ background: 'var(--panel)', border: `1.5px solid ${speech.listening ? 'var(--accent)' : 'var(--line)'}` }}>
          <input
            ref={inputRef}
            value={shownText}
            onChange={(e) => type(e.target.value)}
            placeholder={speech.listening ? 'Listening…' : 'Search or describe a meal'}
            aria-label="Search for a food, or describe your meal"
            className="flex-1 min-w-0 bg-transparent outline-none font-grotesk text-[15px] h-10"
            style={{ color: 'var(--ink)' }}
            enterKeyHint="done"
            autoComplete="off"
          />
          {typed ? (
            <>
              <button type="button" onClick={() => askAI(text).then((ok) => ok && type(''))} disabled={!!busy}
                      aria-label="Estimate with AI" title="Estimate with AI"
                      className="w-10 h-10 shrink-0 rounded-xl grid place-items-center" style={{ color: 'var(--mute)' }}>
                {busy === 'ai' ? <Spinner /> : <Glyph d={SPARK} size={18} />}
              </button>
              <button type="submit" disabled={!!busy} aria-label={looksLikeMeal(text) ? 'Add' : 'Show all matches'}
                      className="w-10 h-10 shrink-0 rounded-xl grid place-items-center" style={{ background: 'var(--ink)', color: 'var(--bg)' }}>
                {busy === 'describe' ? <Spinner /> : <Glyph d={ARROW} />}
              </button>
            </>
          ) : speech.supported ? (
            <motion.button type="button" onClick={speech.listening ? speech.stop : speech.start}
                           aria-label={speech.listening ? 'Stop listening' : 'Say what you ate'} aria-pressed={speech.listening}
                           className="w-10 h-10 shrink-0 rounded-xl grid place-items-center"
                           style={speech.listening ? { background: 'var(--accent)', color: 'var(--accent-contrast)' } : { color: 'var(--mute)' }}
                           animate={speech.listening && !reduced ? { scale: [1, 1.08, 1] } : { scale: 1 }}
                           transition={speech.listening ? { repeat: Infinity, duration: 1.1 } : { duration: 0.2 }}>
              <Icon name="mic" size={19} />
            </motion.button>
          ) : null}
        </form>
        {(error || speech.error) && <p className="mt-2 px-1 font-grotesk text-[12px]" style={{ color: 'var(--warn)' }} role="alert">{error || speech.error}</p>}

        <FoodResults results={search.results} query={search.query} searching={search.searching}
                     showAll={showAll} onShowAll={() => setShowAll(true)} onPick={addSearch}
                     onAI={(q) => askAI(q).then((ok) => ok && type(''))} aiBusy={busy === 'ai'} />

        {/* Not found -- shown, never dropped, with the AI one tap away */}
        {unresolved.map((u, i) => (
          <div key={`${u.fragment}-${i}`} className="mt-2 flex items-center gap-2 rounded-2xl px-3.5 py-2" style={{ border: '1px solid var(--line)' }}>
            <span className="min-w-0 flex-1 font-grotesk text-[13px] truncate" style={{ color: 'var(--mute)' }}>
              “{u.fragment}” <span style={{ color: 'var(--faint)' }}>not found</span>
            </span>
            <button type="button" disabled={!!busy}
                    onClick={async () => { if (await askAI(u.fragment, `ai:u${i}`)) setUnresolved((cur) => cur.filter((_, j) => j !== i)); }}
                    className="shrink-0 h-8 px-2.5 rounded-lg font-grotesk text-[12px] font-semibold flex items-center gap-1"
                    style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
              {busy === `ai:u${i}` ? <Spinner /> : <Glyph d={SPARK} size={13} />} AI estimate
            </button>
          </div>
        ))}

        {/* The plate */}
        {items.length > 0 && (
          <ul className="mt-3 px-1" aria-label="Your plate">
            <AnimatePresence initial={false}>
              {items.map((it, i) => (
                <PlateRow key={it.id} item={it} first={i === 0} reduced={reduced}
                          swapping={busy === 'swap'}
                          aiBusy={busy === `ai:${it.id}`}
                          onAskAI={it.origin === 'ai' ? null : async () => {
                            if (await askAI(it.matchedFrom || it.name, `ai:${it.id}`)) remove(it.id);
                          }}
                          onChange={(next) => update(it.id, next)}
                          onRemove={() => remove(it.id)}
                          onSwap={(alt) => swap(it, alt)} />
              ))}
            </AnimatePresence>
          </ul>
        )}

        {/* Empty plate: the fastest ways in, without explanation */}
        {!items.length && !typed && (
          <div className="mt-3 space-y-3">
            {repeatable.map((m) => (
              <button key={`${m.date}-${m.slot}`} type="button" disabled={!!busy} onClick={() => repeatMeal(m)}
                      className="w-full flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left"
                      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
                <span className="w-9 h-9 shrink-0 rounded-xl grid place-items-center" style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}><Glyph d={REPEAT} size={16} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block font-grotesk text-[13px] font-bold" style={{ color: 'var(--ink)' }}>
                    {dayName(m.date)}’s {slotLabel(m.slot).toLowerCase()}
                  </span>
                  <span className="block font-grotesk text-[11.5px] truncate" style={{ color: 'var(--mute)' }}>
                    {m.items.map((x) => x.name).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 font-grotesk text-[12px] font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{m.total.calories}</span>
              </button>
            ))}
            {usuals.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {usuals.slice(0, 8).map((u) => (
                  <button key={u.name} type="button" onClick={() => setItems((cur) => [...cur, fromUsual(u)])}
                          className="h-9 pl-2.5 pr-3 rounded-xl font-grotesk text-[12.5px] font-semibold flex items-center gap-1.5"
                          style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
                    <Glyph d={PLUS} size={12} sw={2.6} />
                    {u.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* The rest of the classic logger, as icons */}
        {onClassic && (
          <div className="mt-5 flex items-center justify-center gap-2">
            {[
              ['barcode', 'Scan a barcode', 'camera'],
              ['custom', 'Enter macros yourself', 'numbers'],
            ].map(([mode, label, icon]) => (
              <button key={mode} type="button" onClick={() => onClassic(mode)} aria-label={label} title={label}
                      className="h-10 px-3 rounded-xl flex items-center gap-1.5 font-grotesk text-[12px] font-semibold"
                      style={{ color: 'var(--mute)', border: '1px solid var(--line)' }}>
                <Icon name={icon} size={16} /> {mode === 'barcode' ? 'Barcode' : 'Macros'}
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
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
