/**
 * One food on the plate, as ONE line: what it is, how much, the calories,
 * and − / + for the change people actually make ("3 roti, not 2").
 *
 * Everything else -- the unit, the oil, "or was it buffalo milk", the
 * macros, remove -- is one tap away on the row, not printed under every
 * food. A plate of four items used to be four cards of controls; it now
 * reads like a receipt, and opens like one.
 *
 * A food that needs a look gets a small dot, not a sentence: an amount
 * nobody said, or a weak match. The reason is in the opened row.
 */
import { useState } from 'react';
import { motion, AnimatePresence } from '../../../design/motion/index.jsx';
import { priceItem, stepQty, switchUnit, unitOf, setOil, unitGramsHint } from './plate.js';

const Glyph = ({ d, size = 16, sw = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const MINUS = 'M5 12h14';
const PLUS = 'M12 5v14M5 12h14';
const OIL_CHOICES = [['less', 'Less oil'], [null, 'Normal'], ['more', 'More oil']];

const fmtQty = (q) => (Number.isInteger(q) ? q : Math.round(q * 100) / 100);

export default function PlateRow({ item, onChange: change, onRemove, onSwap, onAskAI, swapping, aiBusy, reduced, first }) {
  const [open, setOpen] = useState(false);
  const p = priceItem(item);
  const unit = unitOf(item);
  const weak = item.confidence === 'low' || item.confidence === 'unreliable';
  const flag = item.assumed || weak;
  // Any change to the amount is the person setting it.
  const onChange = (next) => change({ ...next, assumed: false });
  const amount = unit?.key === 'g' ? `${fmtQty(item.qty)} g` : `${unit?.label || 'serving'}${p.grams != null ? ` · ${Math.round(p.grams)} g` : ''}`;

  return (
    <motion.li
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: -30, transition: { duration: 0.16 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      style={first ? undefined : { borderTop: '1px solid var(--line)' }}
    >
      <div className="flex items-center gap-2 py-2.5">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
                aria-label={`${item.name}, ${fmtQty(item.qty)} ${unit?.label || ''}. ${open ? 'Hide' : 'Show'} details`}
                className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="font-grotesk text-[14px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{item.name}</span>
            {item.origin === 'ai' && (
              <span className="shrink-0 font-grotesk text-[9px] font-bold tracking-[.08em] px-1.5 py-0.5 rounded-md"
                    style={{ background: 'var(--accent-soft)', color: 'var(--mute)' }}>AI</span>
            )}
            {flag && <span className="shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: 'var(--warn)' }} aria-label="Worth a check" />}
          </span>
          <span className="block font-grotesk text-[11.5px] truncate tabular-nums" style={{ color: 'var(--mute)' }}>{amount}</span>
        </button>

        <div className="flex items-center shrink-0 rounded-xl" style={{ background: 'var(--accent-soft)' }}>
          <button type="button" className="w-8 h-8 grid place-items-center" style={{ color: 'var(--ink)' }}
                  onClick={() => onChange({ ...item, qty: stepQty(item, -1) })} aria-label={`Less ${item.name}`}>
            <Glyph d={MINUS} size={14} />
          </button>
          <span className="min-w-[1.75rem] text-center font-grotesk text-[13.5px] font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
            {fmtQty(item.qty)}
          </span>
          <button type="button" className="w-8 h-8 grid place-items-center" style={{ color: 'var(--ink)' }}
                  onClick={() => onChange({ ...item, qty: stepQty(item, +1) })} aria-label={`More ${item.name}`}>
            <Glyph d={PLUS} size={14} />
          </button>
        </div>

        <span className="w-11 shrink-0 text-right font-grotesk text-[14px] font-black tabular-nums" style={{ color: 'var(--ink)' }}>
          {p.calories}
        </span>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="pb-3 space-y-2.5">
              {flag && (
                <p className="font-grotesk text-[11.5px]" style={{ color: 'var(--warn)' }}>
                  {item.assumed ? 'Amount guessed — set how much you had.' : item.origin === 'ai' ? 'Rough AI estimate — check the amount and calories.' : 'Closest match — check it is what you ate.'}
                </p>
              )}

              {item.units.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5" role="group" aria-label={`Unit for ${item.name}`}>
                  {item.units.map((u) => {
                    const on = u.key === item.unitKey;
                    const hint = unitGramsHint(u);
                    return (
                      <button key={u.key} type="button" aria-pressed={on}
                              onClick={() => !on && onChange(switchUnit(item, u.key))}
                              className="shrink-0 px-2.5 h-8 rounded-lg font-grotesk text-[12px] font-semibold whitespace-nowrap"
                              style={on
                                ? { background: 'var(--ink)', color: 'var(--bg)' }
                                : { color: 'var(--mute)', border: '1px solid var(--line)' }}>
                        {u.label}{hint && <span className="font-normal" style={{ opacity: 0.65 }}> · {hint}</span>}
                      </button>
                    );
                  })}
                </div>
              )}

              {item.oil && (
                <div className="flex gap-1.5" role="radiogroup" aria-label={`Oil in ${item.name}`}>
                  {OIL_CHOICES.filter(([key]) => key === null || item.oil.some((o) => o.key === key)).map(([key, label]) => {
                    const on = (item.oilKey || null) === key;
                    return (
                      <button key={label} type="button" role="radio" aria-checked={on}
                              onClick={() => !on && change(setOil(item, key))}
                              className="px-2.5 h-7 rounded-lg font-grotesk text-[11.5px] font-semibold"
                              style={on
                                ? { background: 'var(--accent-soft)', color: 'var(--ink)', border: '1px solid var(--ink)' }
                                : { color: 'var(--mute)', border: '1px solid var(--line)' }}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}

              {(item.alternatives?.length > 0 || (weak && onAskAI)) && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {item.alternatives?.map((a) => (
                    <button key={a.source_id} type="button" disabled={swapping} onClick={() => onSwap?.(a)}
                            className="px-2.5 h-7 rounded-lg font-grotesk text-[11.5px] font-semibold"
                            style={{ border: '1px dashed var(--line)', color: 'var(--ink)', opacity: swapping ? 0.5 : 1 }}>
                      {a.name}
                    </button>
                  ))}
                  {weak && onAskAI && (
                    <button type="button" disabled={aiBusy} onClick={onAskAI}
                            className="px-2.5 h-7 rounded-lg font-grotesk text-[11.5px] font-semibold flex items-center gap-1"
                            style={{ background: 'var(--accent-soft)', color: 'var(--ink)', opacity: aiBusy ? 0.6 : 1 }}>
                      <Glyph d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8Z" size={12} />
                      {aiBusy ? 'Estimating…' : 'Estimate with AI'}
                    </button>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between">
                <span className="font-grotesk text-[11.5px] tabular-nums" style={{ color: 'var(--faint)' }}>
                  P {p.protein} · C {p.carbs} · F {p.fat}
                </span>
                <button type="button" onClick={onRemove} className="h-7 px-2 rounded-lg font-grotesk text-[11.5px] font-semibold" style={{ color: 'var(--bad)' }}>
                  Remove
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}
