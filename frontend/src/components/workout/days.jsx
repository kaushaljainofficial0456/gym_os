/**
 * Weekdays for saved workouts, in the schedule's own numbering:
 * 0=Monday..6=Sunday (client_workout_schedule). Its own small module so
 * the "shared with you" popup can offer "repeat on days" without pulling
 * the whole workout builder into the layout every page loads.
 */
import './days.css';

export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Today in the schedule's numbering. */
export const plannerToday = () => (new Date().getDay() + 6) % 7;

/** "Mon, Wed and Fri" */
export function dayList(days) {
  const names = [...days].sort((a, b) => a - b).map((d) => DAY_SHORT[d]);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Weekday chips. `taken` maps a day to the name of the saved workout on it
 * now (picking it moves the day here); `locked` are the coach's days.
 */
export function DayPicker({ value, onToggle, taken = {}, locked = new Set(), label = 'Repeat on', compact }) {
  const today = plannerToday();
  return (
    <div className={`wk-days${compact ? ' wk-days--compact' : ''}`} role="group" aria-label={label}>
      {DAY_SHORT.map((d, i) => {
        const on = value.has(i);
        const isLocked = locked.has(i);
        const other = !on && taken[i];
        /* A coach's day cannot be picked: the program wins on it. One that
           is ALREADY on (set before the coach planned that day) stays
           tappable, struck through, so it can be cleared. */
        const blocked = isLocked && on;
        return (
          <button key={d} type="button" className={`wk-dayc${i === today ? ' is-today' : ''}${blocked ? ' is-blocked' : ''}`} aria-pressed={on} disabled={isLocked && !on}
            onClick={() => onToggle(i)}
            title={blocked ? 'Your coach’s plan has this day, so this workout does not run on it. Tap to clear.'
              : isLocked ? 'Your coach has this day' : other ? `${DAY_LONG[i]} has ${other} now — picking it moves the day here` : DAY_LONG[i]}
            aria-label={`${DAY_LONG[i]}${i === today ? ' (today)' : ''}${isLocked ? ', your coach has this day' : other ? `, has ${other} now` : ''}`}>
            {compact ? d[0] : d}
            {other && !compact && <i className="wk-dayc__taken" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
