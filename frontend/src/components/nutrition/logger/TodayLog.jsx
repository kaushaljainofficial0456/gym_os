/**
 * TODAY — everything eaten today, in one list.
 *
 * This replaced four cards (Breakfast, Lunch, Snacks, Dinner), each with
 * its own "+" and its own "Nothing logged yet". Four boxes to choose
 * between before you can say "I had a samosa" is a sorting question in
 * front of a logging one, and most people do not think of 4pm chai as a
 * category. So there is one list and one Add: the meal is still recorded
 * (from the clock, see slotForTime) -- it is what "your usuals" and "same
 * as yesterday's breakfast" are built from -- it is just never a choice
 * the person has to make.
 *
 * Plan meals (from a coach's plan) keep their tick to mark them eaten;
 * foods the person logged show their amount and can be edited or removed
 * in place. Removing is immediate with an Undo toast.
 */
import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from '../../../design/motion/index.jsx';
import { CheckIcon } from '../../UI.jsx';
import { dayList } from './plate.js';

const fmt = (q) => (Number.isInteger(Number(q)) ? Number(q) : Math.round(Number(q) * 10) / 10);
const amount = (m) => (m.quantity != null && m.unit ? `${fmt(m.quantity)} ${m.unit}` : m.quantity != null ? `${fmt(m.quantity)} serving` : null);
const isPlanMeal = (m) => (!m.source || m.source === 'plan') && !String(m.id || '').startsWith('mlg_');

/** Rows shown before "Show all": a full day still reads at a glance. */
const FOLD = 6;

function Row({ m, first, onToggle, onEdit, onDelete, reduced }) {
  const plan = isPlanMeal(m);
  const dim = plan && !m.eaten;
  return (
    <motion.li
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: 0.2 } }}
      className="flex items-center gap-2.5 py-2"
      style={first ? undefined : { borderTop: '1px solid var(--line)' }}
    >
      {plan ? (
        <button type="button" onClick={() => onToggle(m)} aria-pressed={!!m.eaten} aria-label={`${m.eaten ? 'Unmark' : 'Mark'} ${m.name} as eaten`}
                className="w-6 h-6 shrink-0 rounded-lg grid place-items-center text-[11px] transition-colors"
                style={m.eaten
                  ? { background: 'var(--accent)', color: 'var(--accent-contrast)' }
                  : { border: '1.5px solid var(--line)', color: 'transparent' }}>
          <CheckIcon />
        </button>
      ) : (
        <span className="w-1.5 h-1.5 shrink-0 rounded-full mx-[9px]" style={{ background: 'var(--accent)' }} aria-hidden="true" />
      )}
      <button type="button" disabled={plan} onClick={() => !plan && onEdit(m)}
              className="min-w-0 flex-1 text-left" aria-label={plan ? undefined : `Edit amount of ${m.name}`}>
        <span className="block font-grotesk text-[13.5px] font-semibold truncate" style={{ color: dim ? 'var(--faint)' : 'var(--ink)' }}>{m.name}</span>
        {(amount(m) || plan) && (
          <span className="block font-grotesk text-[11px] truncate" style={{ color: 'var(--mute)' }}>
            {plan ? 'Plan' : amount(m)}
          </span>
        )}
      </button>
      <span className="shrink-0 font-grotesk text-[13px] font-bold tabular-nums" style={{ color: dim ? 'var(--faint)' : 'var(--ink)' }}>
        {Math.round(m.calories)}
      </span>
      {!plan && (
        <button type="button" onClick={() => onDelete(m)} aria-label={`Remove ${m.name}`}
                className="w-8 h-8 -mr-1.5 shrink-0 grid place-items-center rounded-lg" style={{ color: 'var(--faint)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </motion.li>
  );
}

/**
 * The list itself, with no heading, count or hint around it: it sits under
 * the input in the log card (LogCard.jsx), where the day's total is already
 * the big number in the rings. Empty means nothing is rendered at all.
 */
export default function TodayList({ meals, onToggle, onEdit, onDelete }) {
  const reduced = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const day = dayList(meals);
  if (!day.items.length) return null;
  const shown = expanded ? day.items : day.items.slice(0, FOLD);
  const hidden = day.items.length - shown.length;

  return (
    <div className="mt-2 px-1" data-tour="nutrition-meals">
      <ul aria-label="Eaten today">
        <AnimatePresence initial={false}>
          {shown.map((m, i) => (
            <Row key={m.id} m={m} first={i === 0} reduced={reduced} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </AnimatePresence>
      </ul>
      {(hidden > 0 || expanded) && day.items.length > FOLD && (
        <button type="button" onClick={() => setExpanded((v) => !v)}
                className="w-full py-2 font-grotesk text-[12px] font-semibold" style={{ color: 'var(--mute)', borderTop: '1px solid var(--line)' }}>
          {expanded ? 'Show less' : `Show all ${day.items.length}`}
        </button>
      )}
    </div>
  );
}
