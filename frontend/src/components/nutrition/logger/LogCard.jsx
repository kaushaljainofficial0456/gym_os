/**
 * LOG — the whole logging surface on the page, in one card.
 *
 *   type or say it   "2 roti, dal and a cup of chai" + Enter
 *   check it         the foods appear right here, one line each
 *   log it           one button
 *
 * No sheet opens for the common case. "Adjust" opens the full plate (units,
 * search, barcode) only when it is wanted. Usual foods are one tap: they
 * log immediately, as the person last had them, with Undo in the toast.
 *
 * ✨ asks the AI for the whole description when the database is the wrong
 * tool (a restaurant dish, a home recipe); anything the parser could not
 * read offers the same, right where it says so.
 */
import { useState } from 'react';
import { api } from '../../../api.js';
import Icon from '../../Icon.jsx';
import { motion, AnimatePresence, useReducedMotion } from '../../../design/motion/index.jsx';
import { fromPlateItem, fromUsual, fromSearchFood, plateTotals, toLogItems, looksLikeMeal } from './plate.js';
import FoodResults, { useFoodSearch } from './FoodResults.jsx';
import { aiEstimateItem } from './ai.js';
import { useSpeech } from './useSpeech.js';
import PlateRow from './PlateRow.jsx';
import TodayList from './TodayLog.jsx';

const Glyph = ({ d, size = 16, sw = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const ARROW = 'M5 12h14M13 5l7 7-7 7';
const SPARK = 'M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8Z';
const PLUS = 'M12 5v14M5 12h14';

export default function LogCard({ slot, usuals, meals, onLogged, onAdjust, onOpenFull, onToggle, onEdit, onDelete, onError }) {
  const reduced = useReducedMotion();
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);
  const [unresolved, setUnresolved] = useState([]);
  const [busy, setBusy] = useState(null);        // 'describe' | 'ai' | 'log' | `ai:${i}` | `usual:${name}`
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const search = useFoodSearch(text);

  const fail = (msg) => { setError(msg); onError?.(msg); };
  const type = (v) => { setText(v); setShowAll(false); };

  // → / Enter: a described meal is read as a meal; a food name shows every
  // match (its top two are already showing while typing).
  const submit = () => {
    const q = text.trim();
    if (!q) return;
    if (!looksLikeMeal(q) && (search.results.length || search.searching) && !showAll) { setShowAll(true); return; }
    describe(q);
  };

  const pick = (f) => {
    setItems((cur) => [...cur, fromSearchFood(f)]);
    type('');
  };

  const describe = async (raw) => {
    const q = String(raw || '').trim();
    if (!q || busy) return;
    setBusy('describe'); setError('');
    try {
      const r = await api('/me/nutrition/describe', { method: 'POST', body: JSON.stringify({ text: q }) });
      const added = (r.items || []).map(fromPlateItem);
      setItems((cur) => [...cur, ...added]);
      setUnresolved(r.unresolved || []);
      type('');
      if (!added.length && !(r.unresolved || []).length) setError('Nothing recognised — try naming the food.');
    } catch (e) {
      fail(e.message || 'Could not read that');
    } finally { setBusy(null); }
  };

  const speech = useSpeech({ onFinal: (t) => describe(t) });

  const askAI = async (query, key = 'ai') => {
    if (busy) return;
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

  const clear = () => { setItems([]); setUnresolved([]); setError(''); };

  const log = async (list, key = 'log') => {
    if (!list.length || busy) return;
    setBusy(key); setError('');
    try {
      const totals = plateTotals(list);
      const r = await api('/me/nutrition/log-batch', { method: 'POST', body: JSON.stringify({ slot, items: toLogItems(list) }) });
      onLogged?.({ ids: r.ids, slot, count: list.length, calories: totals.calories });
      return true;
    } catch (e) {
      fail(e.message || 'Could not log that');
      return false;
    } finally { setBusy(null); }
  };

  const totals = plateTotals(items);
  const previewing = items.length > 0 || unresolved.length > 0;
  const shown = speech.listening ? speech.interim : text;

  return (
    <section aria-label="Log food" className="rounded-3xl p-3.5"
             style={{ background: 'var(--panel)', border: '1px solid var(--line)' }} data-tour="nutrition-tools">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="pill-field flex items-center gap-1 rounded-2xl pl-3.5 pr-1 py-1"
            style={{ background: 'var(--bg)', border: `1.5px solid ${speech.listening ? 'var(--accent)' : 'var(--line)'}` }}>
        <input
          value={shown}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && text) { e.stopPropagation(); type(''); } }}
          placeholder={speech.listening ? 'Listening…' : 'What did you eat?'}
          aria-label="What did you eat?"
          className="flex-1 min-w-0 bg-transparent outline-none font-grotesk text-[15px] h-10"
          style={{ color: 'var(--ink)' }}
          enterKeyHint="done"
          autoComplete="off"
        />
        {text.trim() ? (
          <>
            <button type="button" onClick={() => askAI(text).then((ok) => ok && type(''))} disabled={!!busy}
                    aria-label="Estimate with AI" title="Estimate with AI"
                    className="w-10 h-10 shrink-0 rounded-xl grid place-items-center" style={{ color: 'var(--mute)' }}>
              {busy === 'ai' ? <Spinner /> : <Glyph d={SPARK} size={18} />}
            </button>
            <button type="submit" disabled={!!busy} aria-label={looksLikeMeal(text) ? 'Add' : 'Show all matches'}
                    className="w-10 h-10 shrink-0 rounded-xl grid place-items-center"
                    style={{ background: 'var(--ink)', color: 'var(--bg)' }}>
              {busy === 'describe' ? <Spinner /> : <Glyph d={ARROW} />}
            </button>
          </>
        ) : (
          <>
            {speech.supported && (
              <motion.button type="button" onClick={speech.listening ? speech.stop : speech.start}
                             aria-label={speech.listening ? 'Stop listening' : 'Say what you ate'} aria-pressed={speech.listening}
                             className="w-10 h-10 shrink-0 rounded-xl grid place-items-center"
                             style={speech.listening ? { background: 'var(--accent)', color: 'var(--accent-contrast)' } : { color: 'var(--mute)' }}
                             animate={speech.listening && !reduced ? { scale: [1, 1.08, 1] } : { scale: 1 }}
                             transition={speech.listening ? { repeat: Infinity, duration: 1.1 } : { duration: 0.2 }}>
                <Icon name="mic" size={19} />
              </motion.button>
            )}
            {onOpenFull && !speech.listening && (
              <button type="button" onClick={onOpenFull} aria-label="Log food: search, barcode or macros" title="Search, barcode or macros"
                      className="w-10 h-10 shrink-0 rounded-xl grid place-items-center" style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
                <Glyph d={PLUS} size={17} />
              </button>
            )}
          </>
                )}
      </form>
      {(error || speech.error) && (
        <p className="mt-2 px-1 font-grotesk text-[12px]" style={{ color: 'var(--warn)' }} role="alert">{error || speech.error}</p>
      )}

      <FoodResults results={search.results} query={search.query} searching={search.searching}
                   showAll={showAll} onShowAll={() => setShowAll(true)} onPick={pick}
                   onAI={(q) => askAI(q).then((ok) => ok && type(''))} aiBusy={busy === 'ai'} />

      <AnimatePresence initial={false} mode="wait">
        {previewing ? (
          <motion.div key="preview" className="mt-2"
                      initial={reduced ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <ul className="px-1" aria-label="Ready to log">
              <AnimatePresence initial={false}>
                {items.map((it, i) => (
                  <PlateRow key={it.id} item={it} first={i === 0} reduced={reduced}
                            aiBusy={busy === `ai:${it.id}`}
                            onAskAI={it.origin === 'ai' ? null : async () => {
                              const ok = await askAI(it.matchedFrom || it.name, `ai:${it.id}`);
                              if (ok) setItems((cur) => cur.filter((x) => x.id !== it.id));
                            }}
                            onChange={(next) => setItems((cur) => cur.map((x) => (x.id === it.id ? next : x)))}
                            onRemove={() => setItems((cur) => cur.filter((x) => x.id !== it.id))} />
                ))}
              </AnimatePresence>
            </ul>

            {unresolved.map((u, i) => (
              <div key={`${u.fragment}-${i}`} className="flex items-center gap-2 px-1 py-2.5" style={{ borderTop: items.length || i ? '1px solid var(--line)' : 'none' }}>
                <span className="min-w-0 flex-1 font-grotesk text-[13.5px] truncate" style={{ color: 'var(--mute)' }}>
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

            <div className="mt-2 flex items-center gap-2">
              <button type="button" onClick={clear} className="h-11 px-3 rounded-xl font-grotesk text-[13px] font-semibold" style={{ color: 'var(--mute)' }}>
                Cancel
              </button>
              <button type="button" onClick={() => { onAdjust?.(items); clear(); }}
                      className="h-11 px-3 rounded-xl font-grotesk text-[13px] font-semibold" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }}>
                Adjust
              </button>
              <motion.button type="button" disabled={!items.length || !!busy}
                             whileTap={reduced ? undefined : { scale: 0.97 }}
                             onClick={async () => { if (await log(items)) clear(); }}
                             className="ml-auto h-11 px-4 rounded-xl font-grotesk text-[14px] font-bold tabular-nums"
                             style={items.length
                               ? { background: 'var(--accent)', color: 'var(--accent-contrast)' }
                               : { background: 'var(--accent-soft)', color: 'var(--faint)' }}>
                {busy === 'log' ? 'Logging…' : items.length ? `Log · ${totals.calories} kcal` : 'Log'}
              </motion.button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="day" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {usuals.length > 0 && (
              <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1" role="group" aria-label="Your usual foods — tap to log">
                {usuals.slice(0, 8).map((u) => (
                  <button key={u.name} type="button" disabled={!!busy}
                          onClick={() => log([fromUsual(u)], `usual:${u.name}`)}
                          aria-label={`Log ${u.name}${u.quantity ? `, ${u.quantity} ${u.unit || ''}` : ''}`}
                          className="shrink-0 h-9 pl-2.5 pr-3 rounded-xl font-grotesk text-[12.5px] font-semibold flex items-center gap-1.5 whitespace-nowrap"
                          style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
                    {busy === `usual:${u.name}` ? <Spinner /> : <Glyph d={PLUS} size={12} sw={2.6} />}
                    {u.name}
                  </button>
                ))}
              </div>
            )}
            <TodayList meals={meals} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function Spinner() {
  return <span className="w-4 h-4 rounded-full border-2 animate-spin" style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }} aria-hidden="true" />;
}
