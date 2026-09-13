/**
 * WeightSelector — weight picker with lb ↔ kg unit switch.
 *
 * Internal storage is always kg; the toggle changes only what is DRAWN.
 *
 * It did not used to. Switching to "lb" called onChange with the pound
 * number, so `form.weight` -- submitted verbatim as `current_weight`, a
 * kilogram field -- became 154 for a 70 kg person, and the wheel then
 * re-converted that 154 and displayed 340. One tap corrupted both the
 * stored value and the number on screen. A unit toggle must never write
 * to the value it is displaying.
 */
import ScrollWheel from './ScrollWheel';
import { kgToLb as exactKgToLb, lbToKg as exactLbToKg } from '../units.js';

const KG_MIN = 30;
const KG_MAX = 250;
const LB_MIN = 66;   // ~30 kg
const LB_MAX = 551;  // ~250 kg

/* Whole numbers, because the wheel only offers whole numbers -- but from
   the exact factors in units.js rather than a second rounded constant. */
function kgToLb(kg) { return Math.round(exactKgToLb(kg)); }
function lbToKg(lb) { return Math.round(exactLbToKg(lb)); }

export default function WeightSelector({ value, onChange, t, unit, onUnitChange }) {
  const kgVal = Number(value) || 70;
  const lbVal = kgToLb(kgVal);

  const switchUnit = (newUnit) => { if (newUnit !== unit) onUnitChange(newUnit); };

  return (
    <div>
      <label
        className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2 block"
        style={{ color: t.mute }}
      >
        Weight
      </label>

      {/* Unit switch */}
      <div className="flex gap-1 mb-3">
        {[
          ['kg', 'kg'],
          ['lb', 'lb'],
        ].map(([u, label]) => (
          <button
            key={u}
            onClick={() => switchUnit(u)}
            className="flex-1 py-1.5 rounded-lg font-grotesk text-[11px] font-semibold transition-all"
            style={{
              background: unit === u ? t.accent : 'transparent',
              color: unit === u ? 'var(--accent-contrast)' : t.mute,
              border: `1px solid ${unit === u ? t.accent : t.border}`,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Wheel */}
      <div className="flex flex-col items-center">
        <ScrollWheel
          value={unit === 'kg' ? kgVal : lbVal}
          onChange={(v) => onChange(unit === 'kg' ? v : lbToKg(v))}
          min={unit === 'kg' ? KG_MIN : LB_MIN}
          max={unit === 'kg' ? KG_MAX : LB_MAX}
          formatItem={(v) => `${v}`}
          style={{ background: 'transparent' }}
        />
        <div
          className="font-grotesk text-[9px] uppercase tracking-[.14em] mt-1"
          style={{ color: t.faint }}
        >
          {unit}
        </div>
      </div>
    </div>
  );
}
