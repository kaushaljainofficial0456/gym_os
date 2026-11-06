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
  const name = prettyName(ex.name) || 'Exercise';

  /* The prescription is the point of the card, so sets, reps and load are
     always on show and editable in place; they used to sit behind a tap,
     and building a 6-exercise day meant opening six cards. Rest and the
     coaching note are the extras, one toggle away. */
  return (
    <div className="rounded-2xl" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <div className="flex items-center gap-3 px-4 pt-3.5">
        <span className="shrink-0 tabular-nums text-[13px] font-bold rounded-full grid place-items-center"
          style={{ width: 28, height: 28, background: 'rgb(var(--tint-rgb) / .08)', color: 'var(--mute)' }} aria-hidden="true">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{prettyName(ex.name) || 'Choose an exercise'}</div>
          {previous && <div className="text-[13px] tabular-nums truncate" style={{ color: 'var(--mute)' }}>Last time: {previous}</div>}
        </div>
        <div className="flex items-center shrink-0">
          <IconBtn label={`Move ${name} up`} disabled={index === 0} onClick={() => onMove(-1)}><path d="m6 15 6-6 6 6" /></IconBtn>
          <IconBtn label={`Move ${name} down`} disabled={index === total - 1} onClick={() => onMove(1)}><path d="m6 9 6 6 6-6" /></IconBtn>
          <IconBtn label={`Remove ${name}`} onClick={onRemove} danger><path d="M6 6l12 12M18 6 6 18" /></IconBtn>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2.5 px-4 pt-3">
        <Stepper label="Sets" value={Number(ex.sets) || 0} min={1} max={20} onChange={(v) => set('sets', v)} />
        {/* Reps is text, not a number: "8", "8-10" and "AMRAP" are all
            real prescriptions a coach writes. */}
        <Field label="Reps" value={ex.reps} onChange={(v) => set('reps', v)} placeholder="8-10" />
        <Field label="Load (kg)" value={ex.weight} onChange={(v) => set('weight', v)} placeholder="BW" />
      </div>

      <div className="px-4 pt-2 pb-3">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="text-[14px] font-semibold inline-flex items-center gap-1.5" style={{ color: 'var(--accent)', minHeight: 36 }}>
          {open ? 'Hide rest & note' : `Rest ${formatRest(Number(ex.rest_sec) || 90)}${ex.notes ? ' · note' : ''} · edit`}
        </button>
        {open && (
          <div className="space-y-3 pt-1.5">
            <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Rest between sets">
              {REST_PRESETS.map((sec) => {
                const on = Number(ex.rest_sec) === sec;
                return (
                  <button key={sec} type="button" onClick={() => set('rest_sec', sec)} aria-pressed={on}
                    className="rounded-full px-3.5 text-[13px] font-semibold tabular-nums"
                    style={{ minHeight: 36, background: on ? 'var(--ink)' : 'rgb(var(--tint-rgb) / .07)', color: on ? 'var(--bg)' : 'var(--mute)' }}>
                    {formatRest(sec)}
                  </button>
                );
              })}
            </div>
            <input value={ex.notes || ''} onChange={(e) => set('notes', e.target.value)}
              placeholder="Coaching note, e.g. slow on the way down"
              aria-label={`Note for ${name}`} className="input w-full" />
            <button type="button" onClick={onDuplicate} className="text-[14px] font-semibold" style={{ color: 'var(--accent)', minHeight: 36 }}>
              Duplicate this exercise
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Stepper({ label, value, min, max, onChange }) {
  const clamp = (v) => Math.max(min, Math.min(max, v));
  return (
    <div>
      <span className="block text-[13px] mb-1" style={{ color: 'var(--mute)' }}>{label}</span>
      <div className="flex items-center rounded-xl overflow-hidden" style={{ background: 'rgb(var(--tint-rgb) / .065)', minHeight: 46 }}>
        <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} onClick={() => onChange(clamp(value - 1))} disabled={value <= min}
          className="w-10 h-[46px] grid place-items-center text-[20px] font-semibold disabled:opacity-30" style={{ color: 'var(--ink)' }}>−</button>
        <span className="flex-1 text-center text-[16px] font-semibold tabular-nums" style={{ color: 'var(--ink)' }} aria-live="polite">{value}</span>
        <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => onChange(clamp(value + 1))} disabled={value >= max}
          className="w-10 h-[46px] grid place-items-center text-[20px] font-semibold disabled:opacity-30" style={{ color: 'var(--ink)' }}>+</button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <label className="block min-w-0">
      <span className="block text-[13px] mb-1" style={{ color: 'var(--mute)' }}>{label}</span>
      <input type="text" value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        aria-label={label} className="input w-full tabular-nums text-center" />
    </label>
  );
}

function IconBtn({ children, label, onClick, disabled, danger }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className="rounded-lg grid place-items-center disabled:opacity-30"
      style={{ width: 36, height: 36, color: danger ? 'var(--bad)' : 'var(--mute)', cursor: disabled ? 'default' : 'pointer' }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
    </button>
  );
}
