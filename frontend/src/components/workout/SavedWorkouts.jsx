/**
 * SAVED WORKOUTS -- the member's own reusable workouts, one card each.
 *
 * This replaced "My workouts", which put a seven-cell week grid, an
 * assignment picker and an inline editor in one sheet. Now each card
 * says what it is and carries everything about it:
 *
 *   - Do today: it becomes today's session.
 *   - Repeats: seven day chips, toggled in place. A day holds one
 *     workout, so picking a day another one has moves it (the chip says
 *     so before you tap). The coach's days are greyed out.
 *   - Edit (opens the builder), Copy, Delete.
 */
import { Bookmark, Copy, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { exerciseLabel } from '../../utils.js';
import { Sheet, Spinner } from '../UI.jsx';
import { DayPicker, dayList } from './WorkoutBuilder.jsx';

function WorkoutCard({ w, days, taken, coachDays, onDoToday, onEdit, onCopy, onDelete, onToggleDay, busy }) {
  const exs = w.exercises || [];
  // The days it really runs on: the coach's program wins on its own days.
  const runs = new Set([...days].filter((d) => !coachDays.has(d)));
  const sets = exs.reduce((a, e) => a + (Number(e.sets) || 0), 0);
  const supersets = new Set(exs.map((e) => e.superset_group).filter(Boolean)).size;
  return (
    <article className="wk-saved" aria-label={w.name}>
      <div className="wk-saved__top">
        <div className="min-w-0 flex-1">
          <h3 className="wk-saved__name">{w.name}</h3>
          <div className="wk-saved__meta">
            {exs.length} {exs.length === 1 ? 'exercise' : 'exercises'} · {sets} sets{supersets ? ` · ${supersets} superset${supersets > 1 ? 's' : ''}` : ''}
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" onClick={onDoToday} disabled={busy}>
          <Play size={13} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />Do today
        </button>
      </div>
      {exs.length > 0 && (
        <p className="wk-saved__list">
          {exs.slice(0, 4).map((e) => exerciseLabel(e.name)).filter(Boolean).join(' · ')}{exs.length > 4 && ` +${exs.length - 4} more`}
        </p>
      )}
      <div className="wk-saved__days">
        <span className="wk-saved__label">{runs.size ? `Every ${dayList(runs)}` : 'Repeat it on'}</span>
        <DayPicker compact value={days} onToggle={onToggleDay} taken={taken} locked={coachDays} label={`Days ${w.name} repeats on`} />
      </div>
      <div className="wk-saved__actions">
        <button type="button" className="wk-textbtn" onClick={onEdit}><Pencil size={14} strokeWidth={2} aria-hidden="true" />Edit</button>
        <button type="button" className="wk-textbtn" onClick={onCopy} aria-label={`Copy ${w.name}`}><Copy size={14} strokeWidth={2} aria-hidden="true" />Copy</button>
        <button type="button" className="wk-textbtn wk-textbtn--bad" onClick={onDelete} aria-label={`Delete ${w.name}`}><Trash2 size={14} strokeWidth={2} aria-hidden="true" />Delete</button>
      </div>
    </article>
  );
}

export default function SavedWorkouts({
  open, onClose, planner, coachDays, onNew, onEdit, onDoToday, onCopy, onDelete, onSetDays, busyId,
}) {
  const workouts = planner?.workouts || [];
  const schedule = planner?.schedule || [];
  const daysOf = (id) => new Set(schedule.filter((s) => s.workout_id === id).map((s) => s.day_of_week));
  const takenFor = (id) => {
    const out = {};
    for (const s of schedule) {
      if (s.workout_id === id) continue;
      const other = workouts.find((x) => x.id === s.workout_id);
      if (other) out[s.day_of_week] = other.name;
    }
    return out;
  };

  return (
    <Sheet open={open} onClose={onClose} title="Saved workouts" sub="Build once, do it any day or every week" wide>
      <div className="grid gap-3">
        <button type="button" className="btn-primary btn-block" onClick={onNew}>
          <Plus size={16} strokeWidth={2.2} aria-hidden="true" />Build a new workout
        </button>
        {!planner && <div className="py-8 grid place-items-center"><Spinner label="Loading your workouts" /></div>}
        {planner && !workouts.length && (
          <div className="wk-empty">
            <span className="wk-empty__icon"><Bookmark size={22} strokeWidth={1.8} aria-hidden="true" /></span>
            <div className="wk-empty__title">No saved workouts yet</div>
            <p className="wk-empty__body">Build a workout once, then do it any day, or have it ready every Monday and Thursday.</p>
          </div>
        )}
        {workouts.map((w) => {
          const days = daysOf(w.id);
          return (
            <WorkoutCard key={w.id} w={w} days={days} taken={takenFor(w.id)} coachDays={coachDays} busy={busyId === w.id}
              onDoToday={() => onDoToday(w)}
              onEdit={() => onEdit(w, [...days])}
              onCopy={() => onCopy(w)}
              onDelete={() => onDelete(w)}
              onToggleDay={(d) => {
                const next = new Set(days);
                if (next.has(d)) next.delete(d); else next.add(d);
                onSetDays(w, [...next], d, !days.has(d));
              }} />
          );
        })}
      </div>
    </Sheet>
  );
}
