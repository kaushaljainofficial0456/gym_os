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
 *
 * Presentation only -- every change goes back through Workout.jsx.
 */
import { useState } from 'react';
import { Check, Ellipsis, Minus, Pause, Play, Plus, TrendingUp } from 'lucide-react';
import { exerciseLabel } from '../../utils.js';
import WeightInput from '../WeightInput.jsx';
import { loadedTarget, repsText } from './TodayView.jsx';

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

function SetRow({ index, set, onPatch, onToggle, u }) {
  const tick = () => {
    if (!set.done) {
      try { navigator.vibrate?.(12); } catch { /* not supported */ }
    }
    onToggle();
  };
  return (
    <div className={`wk-setrow${set.done ? ' is-done' : ''}`}>
      <span className="wk-setrow__n">{index + 1}</span>
      <input type="number" inputMode="numeric" min={0} className="input wk-setrow__in"
        value={set.reps} aria-label={`Set ${index + 1} reps`}
        onChange={(e) => onPatch('reps', e.target.value)} />
      <WeightInput className="input wk-setrow__in" valueKg={set.weight}
        ariaLabel={`Set ${index + 1} weight in ${u.isImperial ? 'pounds' : 'kilograms'}`}
        onChangeKg={(kg) => onPatch('weight', kg)} />
      <button type="button" className="wk-check" onClick={tick} aria-pressed={set.done}
        aria-label={`Mark set ${index + 1} ${set.done ? 'not done' : 'done'}`}>
        <Check size={20} strokeWidth={3} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ExerciseCard({ ex, sets = [], open, onToggleOpen, onPatch, onToggleSet, onAddSet, onRemoveLast, onRemove, onUseTarget, suggestion, u }) {
  const [menu, setMenu] = useState(false);
  const done = sets.filter((s) => s.done).length;
  const complete = sets.length > 0 && done === sets.length;
  const name = exerciseLabel(ex.name);
  return (
    <section className={`wk-exc${open ? ' is-open' : ''}${complete ? ' is-done' : ''}`} aria-label={name}>
      <div className="wk-exc__head">
        <button type="button" className="wk-exc__toggle" onClick={onToggleOpen} aria-expanded={open}>
          <span className="wk-exc__ring">
            <Ring value={sets.length ? done / sets.length : 0} size={38} stroke={4} />
            {complete && <Check size={15} strokeWidth={3} className="wk-exc__tick" aria-hidden="true" />}
          </span>
          <span className="wk-exc__titles">
            <span className="wk-exc__name">{name}</span>
            <span className="wk-exc__meta">
              {complete ? 'Done' : `${done}/${sets.length} sets`}{ex.reps ? ` · ${repsText(ex.reps)}` : ''}
              {ex.primary_muscle ? ` · ${String(ex.primary_muscle).replace(/_/g, ' ').toLowerCase()}` : ''}
            </span>
          </span>
        </button>
        <div className="wk-menu">
          <button type="button" className="wk-iconbtn wk-iconbtn--sm" aria-label={`More for ${name}`}
            aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          {menu && (
            <div className="wk-menu__pop" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onRemove(); }}>Remove from session</button>
            </div>
          )}
        </div>
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
            <SetRow key={i} index={i} set={st} u={u}
              onPatch={(field, value) => onPatch(i, field, value)}
              onToggle={() => onToggleSet(i)} />
          ))}
          <div className="wk-sets__actions">
            <button type="button" className="wk-ghost" onClick={onAddSet}>
              <Plus size={15} strokeWidth={2.2} aria-hidden="true" />Add set
            </button>
            <button type="button" className="wk-ghost" onClick={onRemoveLast} disabled={sets.length <= 1}>
              <Minus size={15} strokeWidth={2.2} aria-hidden="true" />Remove last
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
