/**
 * HeightSelector — height picker with ft/in ↔ cm unit switch.
 *
 * Internal storage is always cm. The unit toggle converts and preserves
 * the user's approximate height. Uses ScrollWheel for the picker UI.
 */
import { useState } from 'react';
import ScrollWheel from './ScrollWheel';

const CM_MIN = 120;
const CM_MAX = 230;
const FT_MIN = 3;  // 3 ft
const FT_MAX = 7;  // 7 ft
const IN_MIN = 0;
const IN_MAX = 11;

/* ── Conversion helpers ── */
function cmToFtIn(cm) {
  const totalIn = cm / 2.54;
  return { ft: Math.floor(totalIn / 12), inches: Math.round(totalIn % 12) };
}

function ftInToCm(ft, inches) {
  return Math.round((ft * 12 + inches) * 2.54);
}

export default function HeightSelector({ value, onChange, t }) {
  const cmVal = Number(value) || 170;
  const { ft, inches } = cmToFtIn(cmVal);

  const [unit, setUnit] = useState('ft_in');

  const switchUnit = (newUnit) => {
    if (newUnit === unit) return;
    // Preserve the approximate height through conversion
    if (newUnit === 'cm') {
      onChange(cmVal);
    } else {
      const converted = cmToFtIn(cmVal);
      onChange(ftInToCm(converted.ft, converted.inches));
    }
    setUnit(newUnit);
  };

  return (
    <div>
      <label
        className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2 block"
        style={{ color: t.mute }}
      >
        Height
      </label>

      {/* Unit switch */}
      <div className="flex gap-1 mb-3">
        {[
          ['ft_in', 'ft / in'],
          ['cm', 'cm'],
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

      {/* Wheel(s) */}
      {unit === 'ft_in' ? (
        <div className="flex gap-2 items-center justify-center">
          {/* Feet */}
          <div className="flex-1 flex flex-col items-center">
            <ScrollWheel
              value={ft}
              onChange={(newFt) => onChange(ftInToCm(newFt, inches))}
              min={FT_MIN}
              max={FT_MAX}
              formatItem={(v) => `${v}`}
              style={{ background: 'transparent' }}
            />
            <div
              className="font-grotesk text-[9px] uppercase tracking-[.14em] mt-1"
              style={{ color: t.faint }}
            >
              ft
            </div>
          </div>

          <div
            className="font-grotesk text-lg font-bold pb-5"
            style={{ color: t.faint }}
          >
            '
          </div>

          {/* Inches */}
          <div className="flex-1 flex flex-col items-center">
            <ScrollWheel
              value={inches}
              onChange={(newIn) => onChange(ftInToCm(ft, newIn))}
              min={IN_MIN}
              max={IN_MAX}
              formatItem={(v) => `${v}`}
              style={{ background: 'transparent' }}
            />
            <div
              className="font-grotesk text-[9px] uppercase tracking-[.14em] mt-1"
              style={{ color: t.faint }}
            >
              in
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <ScrollWheel
            value={cmVal}
            onChange={onChange}
            min={CM_MIN}
            max={CM_MAX}
            formatItem={(v) => `${v}`}
            style={{ background: 'transparent' }}
          />
          <div
            className="font-grotesk text-[9px] uppercase tracking-[.14em] mt-1"
            style={{ color: t.faint }}
          >
            cm
          </div>
        </div>
      )}
    </div>
  );
}
