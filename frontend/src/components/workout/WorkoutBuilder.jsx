/**
 * BUILD A WORKOUT -- and say when it is for.
 *
 * Two short steps in one sheet, so neither screen asks two things at once:
 *
 *   1. What: pick exercises (search, or tap + to add), set sets/reps/weight,
 *      drag them into order, link neighbours into a superset.
 *   2. When: Today, Every week on the days you pick, or Just save it.
 *
 * "Today" makes it today's session (POST /me/workouts), optionally keeping
 * a copy in Saved workouts. "Every week" and "Just save" create a saved
 * workout (POST /me/planner/workouts); repeat days that include today make
 * it today's session too, on the server, so nothing waits a week.
 *
 * The same sheet edits a saved workout (mode 'edit'): step 2 is then only
 * the repeat days.
 */
import { useEffect, useMemo, useState } from 'react';
import { Bookmark, CalendarClock, ChevronLeft, Info, Minus, Play, Plus, Repeat } from 'lucide-react';
import { api } from '../../api.js';
import { exerciseLabel } from '../../utils.js';
import { Sheet } from '../UI.jsx';
import ExerciseAnim from '../exerciseSVG.jsx';
import ExerciseSearchList from './ExerciseSearchList.jsx';
import { SortableExercises, Grip } from './SessionView.jsx';
import { moveItem } from './useDragSort.js';
import { groupsAfterMove, normalizeGroups, toggleLink } from './supersets.js';

export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** Today in the saved-workout schedule's numbering, 0=Monday..6=Sunday. */
export const plannerToday = () => (new Date().getDay() + 6) % 7;

/** "Mon, Wed and Fri" */
export function dayList(days) {
  const names = [...days].sort((a, b) => a - b).map((d) => DAY_SHORT[d]);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const MUSCLE = (m) => {
  const s = String(m || '').replace(/_/g, ' ').toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};

/** A name for a workout nobody named: its two main muscles. */
export function suggestName(exs) {
  const seen = [];
  for (const e of exs) {
    const m = MUSCLE(e.muscle);
    if (m && !seen.includes(m)) seen.push(m);
  }
  return seen.length ? seen.slice(0, 2).join(' & ') : 'My workout';
}

function BuilderRow({ ex, onChange, onRemove, cardRef, style, grip, dragging, groupPos }) {
  const name = exerciseLabel(ex.name);
  const field = (k, label, type = 'text', mode) => (
    <label className="wk-bex__f">
      <span>{label}</span>
      <input className="input" type={type} inputMode={mode} value={ex[k] ?? ''} aria-label={`${name} ${label.toLowerCase()}`}
        onChange={(e) => onChange({ [k]: e.target.value })} />
    </label>
  );
  return (
    <div ref={cardRef} style={style} className={`wk-bex${dragging ? ' is-dragging' : ''}${groupPos ? ' is-ss' : ''}`}>
      <button type="button" className="wk-bex__remove" onClick={onRemove} aria-label={`Remove ${name}`} title="Remove">
        <Minus size={16} strokeWidth={2.6} aria-hidden="true" />
      </button>
      <div className="wk-bex__body">
        <div className="wk-bex__name">{name}</div>
        <div className="wk-bex__fields">
          {field('sets', 'Sets', 'number', 'numeric')}
          {field('reps', 'Reps')}
          {field('weight', 'Weight')}
        </div>
      </div>
      <Grip name={name} grip={grip} />
    </div>
  );
}

function WhenCard({ id, on, icon: I, title, sub, onPick, children }) {
  return (
    <div className={`wk-when${on ? ' is-on' : ''}`}>
      <button type="button" role="radio" aria-checked={on} id={id} className="wk-when__pick" onClick={onPick}>
        <span className="wk-when__icon"><I size={18} strokeWidth={1.9} aria-hidden="true" /></span>
        <span className="flex-1 min-w-0">
          <span className="wk-when__title">{title}</span>
          <span className="wk-when__sub">{sub}</span>
        </span>
        <span className="wk-when__dot" aria-hidden="true" />
      </button>
      {on && children && <div className="wk-when__more">{children}</div>}
    </div>
  );
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

export default function WorkoutBuilder({
  open, onClose, mode = 'new', initial = null, defaultWhen = 'today', libList, loadLib,
  schedule = [], workouts = [], coachDays = new Set(), onSaved, toast,
}) {
  const [step, setStep] = useState('what');
  const [name, setName] = useState('');
  const [exs, setExs] = useState([]);            // { key, exercise_id, name, muscle, sets, reps, weight, rest_sec }
  const [groups, setGroups] = useState({});      // key -> superset key
  const [detail, setDetail] = useState(null);    // library exercise being looked at
  const [picking, setPicking] = useState(true);  // step 1: the search, or the list being built
  const [when, setWhen] = useState(defaultWhen);
  const [days, setDays] = useState(new Set());
  const [keepCopy, setKeepCopy] = useState(false);
  const [saving, setSaving] = useState(false);

  // Fresh state every time it opens, from `initial` when editing.
  useEffect(() => {
    if (!open) return;
    setStep('what');
    setDetail(null);
    setPicking(!initial?.exercises?.length);
    setSaving(false);
    setKeepCopy(false);
    setWhen(mode === 'edit' ? 'weekly' : defaultWhen);
    if (initial) {
      const list = (initial.exercises || []).map((e, i) => ({
        key: `${e.exercise_id || 'x'}_${i}`, exercise_id: e.exercise_id, name: e.name, muscle: e.primary_muscle || e.muscle,
        sets: e.sets ?? 3, reps: e.reps ?? '10', weight: e.weight ?? 'BW', rest_sec: e.rest_sec ?? 90, superset_group: e.superset_group,
      }));
      setName(initial.name || '');
      setExs(list);
      setGroups(normalizeGroups(list.map((e) => e.key), Object.fromEntries(list.filter((e) => e.superset_group).map((e) => [e.key, String(e.superset_group)]))));
      setDays(new Set(initial.days || []));
    } else {
      setName(''); setExs([]); setGroups({}); setDays(new Set());
    }
    if (!libList) loadLib?.();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const keys = exs.map((e) => e.key);
  const addedIds = useMemo(() => new Set(exs.map((e) => e.exercise_id)), [exs]);
  const totalSets = exs.reduce((a, e) => a + (parseInt(e.sets, 10) || 0), 0);
  const supersets = new Set(Object.values(groups)).size;
  const finalName = name.trim() || suggestName(exs);

  // Which saved workout holds each day now, other than this one.
  const taken = useMemo(() => {
    const out = {};
    for (const s of schedule) {
      if (initial?.id && s.workout_id === initial.id) continue;
      const w = workouts.find((x) => x.id === s.workout_id);
      if (w) out[s.day_of_week] = w.name;
    }
    return out;
  }, [schedule, workouts, initial]);

  const add = (x) => {
    setExs((list) => (list.some((e) => e.exercise_id === x.id) ? list : [...list, {
      key: `${x.id}_${Date.now().toString(36)}`, exercise_id: x.id, name: x.name, muscle: x.primary_muscle, sets: 3, reps: '10', weight: 'BW', rest_sec: 90,
    }]));
  };
  const remove = (key) => {
    const next = exs.filter((e) => e.key !== key);
    setExs(next);
    setGroups((g) => { const n = { ...g }; delete n[key]; return normalizeGroups(next.map((e) => e.key), n); });
  };
  const move = (from, to) => {
    const next = moveItem(exs, from, to);
    setExs(next);
    setGroups((g) => groupsAfterMove(next.map((e) => e.key), g, to));
  };
  const link = (i) => setGroups((g) => toggleLink(keys, g, i));
  const toggleDay = (d) => setDays((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; });

  const payloadExercises = () => exs.map((e) => ({
    exercise_id: e.exercise_id, name: e.name, sets: e.sets, reps: String(e.reps ?? ''), weight: String(e.weight ?? ''),
    rest_sec: e.rest_sec, superset_group: groups[e.key] || null,
  }));

  const save = async () => {
    if (saving || !exs.length) return;
    setSaving(true);
    try {
      let res;
      let kind = when;
      if (mode === 'edit') {
        kind = 'edit';
        res = await api(`/me/planner/workouts/${initial.id}`, { method: 'PUT', body: JSON.stringify({ name: finalName, exercises: payloadExercises(), days: [...days] }) });
      } else if (when === 'today' && !keepCopy) {
        res = await api('/me/workouts', { method: 'POST', body: JSON.stringify({ name: finalName, exercises: payloadExercises() }) });
      } else {
        const body = { name: finalName, exercises: payloadExercises() };
        if (when === 'today') body.today = true;
        if (when === 'weekly') body.days = [...days];
        res = await api('/me/planner/workouts', { method: 'POST', body: JSON.stringify(body) });
      }
      onSaved?.({ kind, name: finalName, days: [...days], res, keepCopy });
    } catch (e) {
      toast?.(e.message || 'Could not save the workout');
      setSaving(false);
    }
  };

  const whenLabel = mode === 'edit'
    ? (saving ? 'Saving…' : 'Save changes')
    : saving ? 'Saving…'
      : when === 'today' ? (keepCopy ? 'Save for today and keep it' : 'Save for today')
        : when === 'weekly' ? (days.size ? `Save · every ${dayList(days)}` : 'Pick at least one day')
          : 'Save workout';

  const footer = step === 'what' ? (
    picking ? (
      <button type="button" className="btn-primary btn-block" disabled={!exs.length} onClick={() => { setDetail(null); setPicking(false); }}>
        {exs.length ? `Done adding · ${exs.length} ${exs.length === 1 ? 'exercise' : 'exercises'}` : 'Tap + to add exercises'}
      </button>
    ) : (
      <button type="button" className="btn-primary btn-block" disabled={!exs.length} onClick={() => setStep('when')}>
        Next: when is it for?
      </button>
    )
  ) : (
    <div className="flex gap-2">
      <button type="button" className="btn" onClick={() => setStep('what')} aria-label="Back to exercises">
        <ChevronLeft size={16} strokeWidth={2.2} aria-hidden="true" />Back
      </button>
      <button type="button" className="btn-primary flex-1" onClick={save}
        disabled={saving || (mode !== 'edit' && when === 'weekly' && !days.size)}>
        {whenLabel}
      </button>
    </div>
  );

  const title = mode === 'edit' ? 'Edit workout' : 'Build a workout';
  const sub = step === 'what'
    ? (picking ? 'Step 1 of 2 · Add exercises' : 'Step 1 of 2 · Order, sets and supersets')
    : (mode === 'edit' ? 'Step 2 of 2 · Name and days' : 'Step 2 of 2 · Name it, and when');

  const picker = detail ? (
    <div className="grid gap-3 anim-slideUp">
      <button type="button" onClick={() => setDetail(null)} className="btn btn-sm justify-self-start">
        <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />Back to search
      </button>
      <ExerciseAnim anim={detail.animation_key || 'fallback'} muscle={detail.primary_muscle} label="" />
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-lg leading-tight" style={{ color: 'var(--ink)' }}>{exerciseLabel(detail.name)}</div>
          <div className="wk-chips mt-1.5">
            {[detail.primary_muscle, detail.secondary_muscles, detail.equipment].filter(Boolean).map((t) => (
              <span key={t} className="wk-chip">{String(t).replace(/_/g, ' ').toLowerCase()}</span>
            ))}
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={addedIds.has(detail.id)}
          onClick={() => { add(detail); setDetail(null); }}>
          {addedIds.has(detail.id) ? 'Added' : 'Add'}
        </button>
      </div>
      {detail.cues && <div className="wk-hint"><Info size={15} strokeWidth={2} aria-hidden="true" /><span><b>Form cue</b> · {detail.cues}</span></div>}
    </div>
  ) : (
    <ExerciseSearchList fallback={libList} addedIds={addedIds} onPick={setDetail} onQuickAdd={add} />
  );

  return (
    <Sheet open={open} onClose={onClose} title={title} sub={sub} footer={footer}>
      {step === 'what' ? (
        picking ? (
          <div className="grid gap-3">
            {exs.length > 0 && (
              <button type="button" className="wk-added" onClick={() => { setDetail(null); setPicking(false); }}>
                <span className="wk-added__n">{exs.length}</span>
                <span className="flex-1 min-w-0 truncate text-left">{exs.map((e) => exerciseLabel(e.name)).join(' · ')}</span>
                <span className="wk-added__go">Review</span>
              </button>
            )}
            {picker}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="wk-label">Your workout · {exs.length}</span>
              <span className="text-[12px]" style={{ color: 'var(--faint)' }}>{totalSets} sets{supersets ? ` · ${supersets} superset${supersets > 1 ? 's' : ''}` : ''}</span>
            </div>
            <SortableExercises
              items={exs}
              groups={groups}
              onMove={move}
              onToggleLink={link}
              edges={{ top: 0, bottom: 0 }}
              renderItem={(ex, sortProps) => (
                <BuilderRow ex={ex} {...sortProps} onRemove={() => remove(ex.key)}
                  onChange={(patch) => setExs((list) => list.map((y) => (y.key === ex.key ? { ...y, ...patch } : y)))} />
              )}
            />
            <button type="button" className="wk-ghost wk-add" onClick={() => setPicking(true)}>
              <Plus size={16} strokeWidth={2.2} aria-hidden="true" />Add exercises
            </button>
            <p className="wk-tip">
              <Info size={14} strokeWidth={2} aria-hidden="true" />
              <span>Drag <b>≡</b> to change the order. Tap <b>Superset</b> between two exercises to do them back to back.</span>
            </p>
          </div>
        )
      ) : (
        <div className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="wk-label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80}
              placeholder={suggestName(exs)} aria-label="Workout name" />
            <span className="text-[12px]" style={{ color: 'var(--faint)' }}>
              {exs.length} {exs.length === 1 ? 'exercise' : 'exercises'} · {totalSets} sets{supersets ? ` · ${supersets} superset${supersets > 1 ? 's' : ''}` : ''}
            </span>
          </label>

          {mode === 'edit' ? (
            <div className="grid gap-2">
              <span className="wk-label">Repeat every week on</span>
              <DayPicker value={days} onToggle={toggleDay} taken={taken} locked={coachDays} />
              <p className="text-[12.5px]" style={{ color: 'var(--mute)' }}>
                {days.size ? `It is your workout every ${dayList(days)}.` : 'No days picked. It stays in Saved workouts for whenever you want it.'}
              </p>
            </div>
          ) : (
            <div className="grid gap-2" role="radiogroup" aria-label="When is this workout for?">
              <span className="wk-label">When is it for?</span>
              <WhenCard id="when-today" on={when === 'today'} icon={Play} title="Today" sub="It becomes today's workout" onPick={() => setWhen('today')}>
                <label className="wk-check-line">
                  <input type="checkbox" checked={keepCopy} onChange={(e) => setKeepCopy(e.target.checked)} />
                  <span>Also keep it in Saved workouts</span>
                </label>
              </WhenCard>
              <WhenCard id="when-weekly" on={when === 'weekly'} icon={Repeat} title="Every week" sub="On the days you pick" onPick={() => setWhen('weekly')}>
                <DayPicker value={days} onToggle={toggleDay} taken={taken} locked={coachDays} />
                <p className="text-[12px] mt-2" style={{ color: 'var(--mute)' }}>
                  {!days.size ? 'Pick one or more days. It is ready and waiting on each one.'
                    : days.has(plannerToday()) ? `Every ${dayList(days)}, starting today.`
                      : `Every ${dayList(days)}, starting this week.`}
                  {coachDays.size > 0 && ' Greyed-out days follow your coach’s plan.'}
                </p>
              </WhenCard>
              <WhenCard id="when-later" on={when === 'later'} icon={Bookmark} title="Just save it" sub="Keep it in Saved workouts for any day" onPick={() => setWhen('later')} />
            </div>
          )}
          <p className="wk-tip">
            <CalendarClock size={14} strokeWidth={2} aria-hidden="true" />
            <span>Change the days any time in Saved workouts.</span>
          </p>
        </div>
      )}
    </Sheet>
  );
}
