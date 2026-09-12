/**
 * EXERCISE CARD — compact by default, expands to edit.
 *
 * WHAT THIS REPLACES. Every exercise used to render four labelled input
 * boxes, always open. Six exercises meant twenty-four inputs on screen at
 * once, all with equal visual weight, and a trainer scanning their own
 * session had to read form fields to find out what they had programmed.
 *
 * So the resting state is a SENTENCE -- "4 × 8 · 60 kg · 2:00 rest" --
 * which is how a coach writes it on paper and how it is read back. The
 * inputs appear only when that line is actually being changed.
 *
 * The prescription is also not assumed to be weight-and-reps. A
 * bodyweight movement has no load and does not show an empty kg box
 * waiting to be filled; a zero there would be a claim ("lift 0 kg")
 * rather than an absence.
 */
import { useState } from 'react';
import { prettyName } from './ExercisePicker.jsx';
// Shared with the public shared-workout page -- see utils.js for why.
import { formatLoad } from '../../utils.js';

/** 120 -> "2:00". Seconds stay canonical in state and on the wire; this
 *  is display only, because "rest_sec 120" is a column name, not a thing
 *  a coach says. */
export function formatRest(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return null;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}:${String(rem).padStart(2, '0')}` : `${m}:00`;
}

const REST_PRESETS = [30, 60, 90, 120, 180];

/** The one-line prescription. Only the parts that exist. */
export function prescriptionLine(ex) {
  const bits = [];
  if (ex.sets && ex.reps) bits.push(`${ex.sets} × ${ex.reps}`);
  else if (ex.sets) bits.push(`${ex.sets} sets`);
  const load = formatLoad(ex.weight);
  if (load) bits.push(load);
  const rest = formatRest(ex.rest_sec);
  if (rest) bits.push(`${rest} rest`);
  return bits.join(' · ');
}

export default function ExerciseCard({
  ex, index, total, onChange, onRemove, onDuplicate, onMove, previous,
}) {
  const [open, setOpen] = useState(false);
  const set = (k, v) => onChange({ ...ex, [k]: v });

  return (
    <div
      className="rounded-2xl"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
    >
      {/* Resting state: position, name, prescription. Three things. */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span
          className="shrink-0 tabular-nums text-[11px] font-bold rounded-lg grid place-items-center"
          style={{ width: 26, height: 26, background: 'var(--bg)', color: 'var(--mute)' }}
          aria-hidden="true"
        >
          {String(index + 1).padStart(2, '0')}
        </span>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <div className="text-[13px] font-bold truncate" style={{ color: 'var(--ink)' }}>
            {prettyName(ex.name) || 'Choose an exercise'}
          </div>
          <div className="text-[11px] mt-0.5 tabular-nums truncate" style={{ color: 'var(--mute)' }}>
            {prescriptionLine(ex) || 'Tap to set sets and reps'}
          </div>
        </button>

        {/* Reorder is available to keyboard and touch, not only to a drag
            gesture -- dragging is unusable one-handed and invisible to a
            screen reader. */}
        <div className="flex items-center gap-0.5 shrink-0">
          <IconBtn label={`Move ${prettyName(ex.name)} up`} disabled={index === 0} onClick={() => onMove(-1)}>↑</IconBtn>
          <IconBtn label={`Move ${prettyName(ex.name)} down`} disabled={index === total - 1} onClick={() => onMove(1)}>↓</IconBtn>
        </div>
      </div>

      {/* Previous performance, when the client has actually done it. Pure
          context -- it never auto-fills the prescription, because the
          trainer decides the progression, not the app. */}
      {previous && (
        <div
          className="mx-3 mb-2.5 rounded-lg px-2.5 py-1.5 text-[10.5px] tabular-nums"
          style={{ background: 'var(--bg)', color: 'var(--mute)' }}
        >
          Last session: <span style={{ color: 'var(--ink)' }}>{previous}</span>
        </div>
      )}

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2.5" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Sets" value={ex.sets} onChange={(v) => set('sets', v)} min={1} max={20} />
            {/* Reps is text, not a number: "8", "8-10" and "AMRAP" are all
                real prescriptions a coach writes. */}
            <Field label="Reps" value={ex.reps} onChange={(v) => set('reps', v)} text placeholder="8" />
            <Field label="Load (kg)" value={ex.weight} onChange={(v) => set('weight', v)} text placeholder="BW" />
          </div>

          <div>
            <div className="t-micro mb-1.5">Rest</div>
            <div className="flex gap-1.5 flex-wrap">
              {REST_PRESETS.map((sec) => {
                const on = Number(ex.rest_sec) === sec;
                return (
                  <button
                    key={sec} type="button"
                    onClick={() => set('rest_sec', sec)}
                    aria-pressed={on}
                    className="rounded-lg px-2.5 text-[11.5px] font-semibold tabular-nums"
                    style={{
                      minHeight: 36,
                      background: on ? 'var(--accent-soft)' : 'transparent',
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                      color: on ? 'var(--accent)' : 'var(--mute)',
                    }}
                  >{formatRest(sec)}</button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="t-micro mb-1.5">Coaching note</div>
            <input
              value={ex.notes || ''}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="e.g. controlled eccentric, stop 2 reps short"
              aria-label={`Note for ${prettyName(ex.name)}`}
              className="input w-full text-[12px]"
              style={{ minHeight: 40 }}
            />
          </div>

          <div className="flex gap-1.5 pt-0.5">
            <button
              type="button" onClick={onDuplicate}
              className="rounded-lg px-3 text-[11.5px] font-semibold"
              style={{ minHeight: 38, border: '1px solid var(--line)', color: 'var(--mute)' }}
            >Duplicate</button>
            <button
              type="button" onClick={onRemove}
              className="rounded-lg px-3 text-[11.5px] font-semibold ml-auto"
              style={{ minHeight: 38, border: '1px solid var(--line)', color: 'var(--bad)' }}
            >Remove</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, min, max, text = false, placeholder }) {
  return (
    <label className="block">
      <span className="t-micro block mb-1">{label}</span>
      <input
        type={text ? 'text' : 'number'}
        inputMode={text ? undefined : 'numeric'}
        min={min} max={max}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(text ? e.target.value : Math.max(min ?? 0, Math.min(max ?? 999, Number(e.target.value) || 0)))}
        aria-label={label}
        className="input w-full text-[13px] tabular-nums"
        style={{ minHeight: 42 }}
      />
    </label>
  );
}

function IconBtn({ children, label, onClick, disabled }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} aria-label={label}
      className="rounded-lg grid place-items-center text-[13px]"
      style={{
        width: 34, height: 34,
        color: disabled ? 'var(--faint)' : 'var(--mute)',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >{children}</button>
  );
}
