/**
 * TODAY, BY MEAL — Breakfast, Lunch, Snacks, Dinner, each with its own
 * subtotal and its own "+".
 *
 * Every food used to land in one flat "Today's Eaten Meals" list (and in
 * the "snack" slot, whatever it was), two rows visible before "See more".
 * A day is remembered by meal, so it is shown by meal: "+" on Lunch opens
 * the logger already set to lunch.
 *
 * Plan meals (from a coach's plan) sit in their own meal with a tick to
 * mark them eaten; foods the person logged show their amount and can be
 * edited or removed in place. Removing is immediate with an Undo toast --
 * a confirmation dialog for every slip of a thumb is the "hectic" part.
 */
import { motion, AnimatePresence, useReducedMotion } from '../../../design/motion/index.jsx';
import { CheckIcon } from '../../UI.jsx';
import { groupDay } from './plate.js';

const fmt = (q) => (Number.isInteger(Number(q)) ? Number(q) : Math.round(Number(q) * 10) / 10);
const amount = (m) => (m.quantity != null && m.unit ? `${fmt(m.quantity)} ${m.unit}` : m.quantity != null ? `${fmt(m.quantity)} serving` : null);
const isPlanMeal = (m) => !m.source || m.source === 'plan';

function Row({ m, first, onToggle, onEdit, onDelete, reduced }) {
  const plan = isPlanMeal(m) && !String(m.id || '').startsWith('mlg_');
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
            {plan ? 'From your plan' : amount(m)}
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

export default function MealSlots({ meals, currentSlot, onAdd, onToggle, onEdit, onDelete }) {
  const reduced = useReducedMotion();
  const day = groupDay(meals);
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-tour="nutrition-meals">
      {day.map((g) => {
        const has = g.items.length > 0;
        // Only the meal it is now gets the solid button: four of them shout.
        const now = g.key === currentSlot;
        return (
          <section key={g.key} aria-labelledby={`slot-${g.key}`} className="rounded-3xl px-4 pt-3.5 pb-2"
                   style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
            <header className="flex items-center gap-2">
              <h3 id={`slot-${g.key}`} className="font-grotesk text-[15px] font-black" style={{ color: 'var(--ink)' }}>{g.label}</h3>
              {g.total.calories > 0 && (
                <span className="font-grotesk text-[11.5px] tabular-nums" style={{ color: 'var(--mute)' }}>
                  {Math.round(g.total.calories)} kcal · P {Math.round(g.total.protein)}
                </span>
              )}
              <button type="button" onClick={() => onAdd(g.key)} aria-label={`Add food to ${g.label}`}
                      className="ml-auto w-9 h-9 -mr-1 rounded-xl grid place-items-center transition-transform active:scale-90"
                      style={{ background: now ? 'var(--accent)' : 'var(--accent-soft)', color: now ? 'var(--accent-contrast)' : 'var(--ink)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
            </header>
            {has ? (
              <ul className="mt-1">
                <AnimatePresence initial={false}>
                  {g.items.map((m, i) => (
                    <Row key={m.id} m={m} first={i === 0} reduced={reduced} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />
                  ))}
                </AnimatePresence>
              </ul>
            ) : (
              <button type="button" onClick={() => onAdd(g.key)} className="w-full text-left py-2.5 font-grotesk text-[12px]" style={{ color: 'var(--faint)' }}>
                Nothing logged yet
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
