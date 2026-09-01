/**
 * WeightSelector — weight picker with lb ↔ kg unit switch.
 *
 * Internal storage is always kg. The unit toggle converts and preserves
 * the user's approximate weight. Uses ScrollWheel for the picker UI.
 */
import { useState } from 'react';
import ScrollWheel from './ScrollWheel';

const KG_MIN = 30;
const KG_MAX = 250;
const LB_MIN = 66;   // ~30 kg
const LB_MAX = 551;  // ~250 kg

/* ── Conversion helpers ── */
function kgToLb(kg) { return Math.round(kg * 2.20462); }
function lbToKg(lb) { return Math.round(lb / 2.20462); }

export default function WeightSelector({ value, onChange, t }) {
  const kgVal = Number(value) || 70;
  const lbVal = kgToLb(kgVal);

  const [unit, setUnit] = useState('kg');

  const switchUnit = (newUnit) => {
    if (newUnit === unit) return;
    // Preserve the approximate weight through conversion
    if (newUnit === 'kg') {
      onChange(lbToKg(lbVal));
    } else {
      onChange(kgToLb(kgVal));
    }
    setUnit(newUnit);
  };

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
