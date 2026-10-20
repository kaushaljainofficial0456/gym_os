/**
 * The front door to logging, on the page itself: one line to type or say
 * what was eaten, plus this meal's usual foods as one-tap chips.
 *
 * It does not log anything by itself. Enter, the mic, or a chip opens the
 * plate logger already holding that food, so every log still passes the
 * one review step (amounts, the right milk) before it is written.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../api.js';
import Icon from '../../Icon.jsx';
import { motion, useReducedMotion } from '../../../design/motion/index.jsx';
import { slotLabel, fromUsual } from './plate.js';
import { useSpeech } from './useSpeech.js';

export default function QuickComposer({ slot, onOpen, refreshKey }) {
  const reduced = useReducedMotion();
  const [usuals, setUsuals] = useState([]);
  const speech = useSpeech({ onFinal: (t) => onOpen({ text: t }) });

  useEffect(() => {
    let live = true;
    api(`/me/nutrition/usuals?slot=${slot}`).then((r) => live && setUsuals(r.usuals || [])).catch(() => {});
    return () => { live = false; };
  }, [slot, refreshKey]);


  return (
    <section aria-label="Log food" className="rounded-3xl p-3.5 sm:p-4"
             style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: '0 10px 30px rgb(var(--accent-rgb) / .08)' }}
             data-tour="nutrition-tools">
      <div className="flex items-center gap-2">
        <span className="w-10 h-10 shrink-0 rounded-xl grid place-items-center" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
          <Icon name="plate" size={20} />
        </span>
        {/* A button that looks like a field, not a field: the plate logger's
            own input is the real one. A focusable input here would take
            focus back when the sheet closes and open it again. */}
        <button type="button" onClick={() => onOpen({})}
                className="flex-1 min-w-0 h-11 text-left font-grotesk text-[15px] truncate"
                style={{ color: speech.listening ? 'var(--ink)' : 'var(--faint)' }}>
          {speech.listening ? (speech.interim || 'Listening…') : `What did you have for ${slotLabel(slot).toLowerCase()}?`}
        </button>
        {speech.supported && (
          <motion.button type="button" onClick={speech.listening ? speech.stop : speech.start}
                         aria-label={speech.listening ? 'Stop listening' : 'Speak what you ate'}
                         aria-pressed={speech.listening}
                         className="w-11 h-11 shrink-0 rounded-xl grid place-items-center"
                         style={speech.listening ? { background: 'var(--accent)', color: 'var(--accent-contrast)' } : { background: 'var(--accent-soft)', color: 'var(--ink)' }}
                         animate={speech.listening && !reduced ? { scale: [1, 1.08, 1] } : { scale: 1 }}
                         transition={speech.listening ? { repeat: Infinity, duration: 1.1 } : { duration: 0.2 }}>
            <Icon name="mic" size={20} />
          </motion.button>
        )}
      </div>
      {speech.error && <p className="mt-2 font-grotesk text-[12px]" style={{ color: 'var(--warn)' }}>{speech.error}</p>}
      {usuals.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-0.5">
          {usuals.slice(0, 6).map((u) => (
            <button key={u.name} type="button" onClick={() => onOpen({ seed: fromUsual(u) })}
                    className="shrink-0 h-9 px-3 rounded-xl font-grotesk text-[12.5px] font-semibold flex items-center gap-1.5 whitespace-nowrap"
                    style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              {u.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
