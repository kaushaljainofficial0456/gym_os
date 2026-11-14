/**
 * The session itself, built to be used at arm's length between sets.
 *
 *  - ONE clock, start to finish (ml/docs/SESSION_INTENSITY_DESIGN_NOTE.md
 *    §5b: no per-set or rest timers -- a settled product decision, because
 *    the session duration is the calorie model's input).
 *  - Big targets: a set is ticked with a 44 px button, its reps and weight
 *    stay editable because what was lifted is what gets logged.
 *  - The coach's numbers and the last session's are in view, so the
 *    question "what do I put on the bar?" is answered where it is asked.
 *  - The order is the member's: drag the three-line handle (or use the
 *    arrow keys on it) at any point in the session. Two neighbours can be
 *    linked into a superset, and a drop set is one tap after any set.
 *    Neither adds a rest timer -- the one-clock rule above still holds.
 *
 * Presentation only -- every change goes back through Workout.jsx.
 */
import { Fragment } from 'react';
import { Check, ChevronDown, Link2, Menu, Minus, Pause, Play, Plus, TrendingDown, TrendingUp, X } from 'lucide-react';
import { exerciseLabel } from '../../utils.js';
import WeightInput from '../WeightInput.jsx';
import { loadedTarget, repsText } from './TodayView.jsx';
import { useDragSort } from './useDragSort.js';
import { groupPosition, isLinked, setLabels } from './supersets.js';

export const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${m}:${r}` : `${m}:${r}`;
};

export function Ring({ value = 0, size = 64, stroke = 6, label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="wk-ring" role={label ? 'img' : undefined}
      aria-label={label} aria-hidden={label ? undefined : 'true'}>
      <circle cx={size / 2} cy={size / 2} r={r} className="wk-ring__track" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} className="wk-ring__fill" strokeWidth={stroke}
        strokeDasharray={c} strokeDashoffset={c * (1 - v)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

export function PlayerHeader({ name, elapsed, paused, doneSets, totalSets, onPause, onResume }) {
  const pct = totalSets ? doneSets / totalSets : 0;
  return (
    <section className={`wk-player${paused ? ' is-paused' : ''}`} aria-label="Session">
      <div className="wk-player__main">
        <div className="wk-player__label">{paused ? 'Paused' : name || 'Session'}</div>
        <div className="wk-clock" role="timer" aria-live="off">{clock(elapsed)}</div>
      </div>
      <div className="wk-player__ring">
        <Ring value={pct} size={62} stroke={6} label={`${doneSets} of ${totalSets} sets done`} />
        <span className="wk-player__count"><b>{doneSets}</b>/{totalSets}</span>
      </div>
      <button type="button" className="wk-iconbtn wk-iconbtn--lg" onClick={paused ? onResume : onPause}
        aria-label={paused ? 'Resume session' : 'Pause session'}>
        {paused
          ? <Play size={18} strokeWidth={2.2} fill="currentColor" aria-hidden="true" />
          : <Pause size={18} strokeWidth={2.2} fill="currentColor" aria-hidden="true" />}
      </button>
    </section>
  );
}

function SetRow({ label, name, set, onPatch, onToggle, u }) {
  const tick = () => {
    if (!set.done) {
      try { navigator.vibrate?.(12); } catch { /* not supported */ }
    }
    onToggle();
  };
  return (
    <div className={`wk-setrow${set.done ? ' is-done' : ''}${set.drop ? ' is-drop' : ''}`}>
      <span className={`wk-setrow__n${set.drop ? ' is-drop' : ''}`} title={set.drop ? 'Drop set: same move, lighter, no rest' : undefined}>{label}</span>
      <input type="number" inputMode="numeric" min={0} className="input wk-setrow__in"
        value={set.reps} aria-label={`${name} reps`}
        onChange={(e) => onPatch('reps', e.target.value)} />
      <WeightInput className="input wk-setrow__in" valueKg={set.weight}
        ariaLabel={`${name} weight in ${u.isImperial ? 'pounds' : 'kilograms'}`}
        onChangeKg={(kg) => onPatch('weight', kg)} />
      <button type="button" className="wk-check" onClick={tick} aria-pressed={set.done}
        aria-label={`Mark ${name.toLowerCase()} ${set.done ? 'not done' : 'done'}`}>
        <Check size={20} strokeWidth={3} aria-hidden="true" />
      </button>
    </div>
  );
}

/** What each row is called out loud: "Set 2", "Drop set 1". */
function rowNames(sets) {
  let n = 0;
  let d = 0;
  return sets.map((s) => (s.drop ? `Drop set ${(d += 1)}` : `Set ${(n += 1)}`));
}

/** The three-line handle that reorders a card (see useDragSort). */
export function Grip({ name, grip }) {
  return (
    <button type="button" className="wk-grip" {...grip} aria-label={`Move ${name}. Drag, or use the arrow keys.`} title="Drag to reorder">
      <Menu size={19} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

/**
 * One exercise in the session.
 *
 *  - The ring on the left shows how many sets are done; the minus inside
 *    it removes the exercise from today (asked first -- see Workout.jsx).
 *    A finished exercise shows a tick there instead: a tick that deletes
 *    would be a trap.
 *  - The three lines on the right drag it to a new place in the order.
 *  - Inside: one row per set, "Add set", and "Drop set" -- a lighter set
 *    straight after the one just done.
 */
export function ExerciseCard({
  ex, sets = [], open, onToggleOpen, onPatch, onToggleSet, onAddSet, onAddDrop, onRemoveLast, onRemove, onUseTarget,
  suggestion, u, grip, cardRef, style, dragging, groupPos,
}) {
  const done = sets.filter((s) => s.done).length;
  const complete = sets.length > 0 && done === sets.length;
  const name = exerciseLabel(ex.name);
  const labels = setLabels(sets);
  const names = rowNames(sets);
  const drops = sets.filter((s) => s.drop).length;
  const cls = ['wk-exc', open && 'is-open', complete && 'is-done', dragging && 'is-dragging', groupPos && 'is-ss', groupPos && `is-ss-${groupPos}`]
    .filter(Boolean).join(' ');
  return (
    <section ref={cardRef} style={style} className={cls} aria-label={name}>
      <div className="wk-exc__head">
        {complete ? (
          <span className="wk-exc__ring" aria-hidden="true">
            <Ring value={1} size={40} stroke={4} />
            <Check size={16} strokeWidth={3} className="wk-exc__tick" />
          </span>
        ) : (
          <button type="button" className="wk-exc__ring wk-exc__remove" onClick={onRemove}
            aria-label={`Remove ${name} from this session`} title="Remove from this session">
            <Ring value={sets.length ? done / sets.length : 0} size={40} stroke={4} />
            <Minus size={17} strokeWidth={2.6} className="wk-exc__minus" aria-hidden="true" />
          </button>
        )}
        <button type="button" className="wk-exc__toggle" onClick={onToggleOpen} aria-expanded={open}>
          <span className="wk-exc__titles">
            <span className="wk-exc__name">{name}</span>
            <span className="wk-exc__meta">
              {complete ? 'Done' : `${done}/${sets.length} sets`}{ex.reps ? ` · ${repsText(ex.reps)}` : ''}
              {ex.primary_muscle ? ` · ${String(ex.primary_muscle).replace(/_/g, ' ').toLowerCase()}` : ''}
              {drops > 0 && <span className="wk-exc__tag">{drops === 1 ? '1 drop' : `${drops} drops`}</span>}
            </span>
          </span>
          <ChevronDown size={17} strokeWidth={2} className="wk-exc__chev" aria-hidden="true" />
        </button>
        {grip && <Grip name={name} grip={grip} />}
      </div>

      {open && (
        <div className="wk-sets">
          {suggestion && Number(suggestion.current?.weight) > 0 && (
            <div className="wk-hint">
              <TrendingUp size={15} strokeWidth={2} aria-hidden="true" />
              <span className="flex-1">
                Last time <b>{u.fmtWeight(suggestion.current.weight)} × {suggestion.current.reps}</b>
                {loadedTarget(suggestion)
                  ? <> · today try <b>{u.fmtWeight(suggestion.suggested.weight)} × {suggestion.suggested.reps}</b></>
                  : <> · {suggestion.suggested.reps > suggestion.current.reps ? `aim for ${suggestion.suggested.reps} reps` : 'hold the load'}</>}
              </span>
              {loadedTarget(suggestion) && onUseTarget && sets.some((st) => !st.done && Number(st.weight) !== Number(suggestion.suggested.weight)) && (
                <button type="button" className="wk-hint__use" onClick={() => onUseTarget(suggestion.suggested)}>Use</button>
              )}
            </div>
          )}
          <div className="wk-setrow wk-setrow--head" aria-hidden="true">
            <span>Set</span><span>Reps</span><span>{u.isImperial ? 'lb' : 'kg'}</span><span />
          </div>
          {sets.map((st, i) => (
            <SetRow key={i} label={labels[i]} name={names[i]} set={st} u={u}
              onPatch={(field, value) => onPatch(i, field, value)}
              onToggle={() => onToggleSet(i)} />
          ))}
          <div className="wk-sets__actions">
            <button type="button" className="wk-ghost" onClick={onAddSet} disabled={sets.length >= 20}>
              <Plus size={15} strokeWidth={2.2} aria-hidden="true" />Add set
            </button>
            <button type="button" className="wk-ghost" onClick={onAddDrop} disabled={!sets.length || sets.length >= 20}
              title="Same exercise, lighter weight, no rest">
              <TrendingDown size={15} strokeWidth={2.2} aria-hidden="true" />Drop set
            </button>
            <button type="button" className="wk-ghost wk-ghost--icon" onClick={onRemoveLast} disabled={sets.length <= 1}
              aria-label="Remove the last set" title="Remove the last set">
              <Minus size={15} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Between two cards: tap to do them as a superset, tap again to undo. */
export function SupersetLink({ linked, onToggle, a, b, hidden }) {
  return (
    <div className={`wk-link${linked ? ' is-on' : ''}`} style={hidden ? { visibility: 'hidden' } : undefined}>
      <button type="button" className="wk-link__btn" aria-pressed={linked} onClick={onToggle}
        aria-label={linked ? `${a} and ${b} are a superset. Tap to separate them.` : `Make ${a} and ${b} a superset`}
        title={linked ? 'Tap to separate' : 'Do these back to back, then rest'}>
        <Link2 size={13} strokeWidth={2.2} aria-hidden="true" />
        Superset
        {linked && <X size={12} strokeWidth={2.6} aria-hidden="true" />}
      </button>
    </div>
  );
}

/**
 * A list of exercises that can be dragged into a new order, with the
 * superset link between each pair. Used by the session and the builder,
 * so both read and work the same way.
 *
 * renderItem(item, { cardRef, style, grip, dragging, groupPos }) draws one.
 */
export function SortableExercises({ items, groups = {}, onMove, onToggleLink, renderItem, edges, className = '' }) {
  const ids = items.map((e) => e.key ?? e.id);
  const nameOf = (id) => exerciseLabel(items[ids.indexOf(id)]?.name || 'Exercise');
  const sort = useDragSort({ ids, onMove, nameOf, edges });
  return (
    <div className={`wk-exlist${sort.drag ? ' is-sorting' : ''} ${className}`}>
      {items.map((it, i) => {
        const id = ids[i];
        return (
          <Fragment key={id}>
            {renderItem(it, {
              cardRef: sort.itemRef(id),
              style: sort.styleFor(id),
              grip: sort.handleProps(id),
              dragging: sort.drag?.id === id,
              groupPos: groupPosition(ids, groups, i),
            })}
            {i < items.length - 1 && onToggleLink && (
              <SupersetLink linked={isLinked(ids, groups, i)} hidden={!!sort.drag} onToggle={() => onToggleLink(i)}
                a={exerciseLabel(it.name)} b={exerciseLabel(items[i + 1].name)} />
            )}
          </Fragment>
        );
      })}
      <div className="sr-only" aria-live="polite">{sort.announcement}</div>
    </div>
  );
}
