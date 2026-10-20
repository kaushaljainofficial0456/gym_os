/**
 * FUEL RINGS — the day's calories and macros as four concentric rings.
 *
 * Outer ring: calories against today's target. Inside it: protein, carbs,
 * fat. On a device that can afford it the rings are real 3D (tilted, lit,
 * slowly breathing); everywhere else -- reduced motion, no WebGL, the
 * three.js chunk still downloading -- they are the same rings in SVG, so
 * the screen is finished either way.
 *
 * THIS FILE MUST NOT IMPORT three.js. The scene is behind React.lazy, for
 * the reason design/three/AmbientBackdrop.jsx documents: importing it here
 * statically would put the whole renderer into the Nutrition page chunk.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { hasWebGL } from '../../design/three/webgl.js';
import { AnimatedNumber } from '../../design/motion/index.jsx';
import { fitRingNumber } from './ringLabel.js';

const Scene = lazy(() => import('./FuelRingsScene.jsx'));

export const RING_KEYS = ['calories', 'protein', 'carbs', 'fat'];

/** A CSS colour variable as a value WebGL can use ("180 194 206" -> rgb()). */
export function readCssColor(name) {
  if (typeof document === 'undefined') return '#999999';
  const root = getComputedStyle(document.documentElement);
  const rgb = root.getPropertyValue(`${name}-rgb`).trim();
  if (rgb) return `rgb(${rgb.split(/[\s,]+/).slice(0, 3).join(',')})`;
  return root.getPropertyValue(name).trim() || '#999999';
}

/** Re-read colours when the theme flips (the <html> class changes). */
export function useRingColors(over) {
  const read = () => ({
    // Calories in the ink colour: protein already wears the accent, and two
    // rings in one colour read as one measurement.
    calories: readCssColor(over ? '--bad' : '--ink'),
    protein: readCssColor('--accent'),
    carbs: readCssColor('--warn'),
    fat: readCssColor('--good'),
    track: document.documentElement.classList.contains('light') ? 'rgb(0,0,0)' : 'rgb(255,255,255)',
  });
  const [colors, setColors] = useState(read);
  useEffect(() => { setColors(read()); }, [over]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const obs = new MutationObserver(() => setColors(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => obs.disconnect();
  }, [over]); // eslint-disable-line react-hooks/exhaustive-deps
  return colors;
}

const frac = (v, max) => (max > 0 ? Math.max(0, Math.min(v / max, 1)) : 0);

/** Radius of the clear hole inside the innermost ring, as a share of the
 *  dial's size -- the smaller of the flat rings and the tilted 3D ones. */
export const HOLE = 0.235;

/** The flat version: the fallback, and the whole thing without WebGL. */
export function SvgRings({ size, progress, over }) {
  // The macro rings sit close under the calorie ring so the hole in the
  // middle is wide enough for the label (HOLE below): the number used to
  // run into the fat ring.
  const rings = [
    { key: 'calories', r: 0.455, w: 0.07, color: over ? 'var(--bad)' : 'var(--ink)' },
    { key: 'protein', r: 0.385, w: 0.04, color: 'var(--accent)', soft: true },
    { key: 'carbs', r: 0.335, w: 0.04, color: 'var(--warn)' },
    { key: 'fat', r: 0.285, w: 0.04, color: 'var(--good)' },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 1 1" className="-rotate-90" aria-hidden="true">
      {rings.map((g) => {
        const C = 2 * Math.PI * g.r;
        return (
          <g key={g.key}>
            <circle cx=".5" cy=".5" r={g.r} fill="none" stroke="currentColor" strokeOpacity=".08" strokeWidth={g.w} />
            <circle cx=".5" cy=".5" r={g.r} fill="none" stroke={g.color} strokeOpacity={g.soft ? 0.7 : 1}
                    strokeWidth={g.w} strokeLinecap="round"
                    strokeDasharray={C} strokeDashoffset={C * (1 - progress[g.key])}
                    style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.22,.8,.3,1)' }} />
          </g>
        );
      })}
    </svg>
  );
}

export default function FuelRings({ eaten, target, size = 220 }) {
  const reduced = useReducedMotion();
  const [webgl] = useState(() => hasWebGL());
  const over = target?.calories > 0 && eaten.calories > target.calories;
  const progress = {
    calories: frac(eaten.calories, target?.calories),
    protein: frac(eaten.protein, target?.protein),
    carbs: frac(eaten.carbs, target?.carbs),
    fat: frac(eaten.fat, target?.fat),
  };
  const left = Math.round((target?.calories || 0) - eaten.calories);
  const flat = <SvgRings size={size} progress={progress} over={over} />;
  const hasTarget = target?.calories > 0;
  const headline = hasTarget ? Math.abs(left) : Math.round(eaten.calories);
  // Sized for the number actually shown, with the two small lines under it.
  const numberPx = fitRingNumber(headline.toLocaleString(), {
    holeRadius: size * HOLE, belowPx: hasTarget ? 30 : 15, max: Math.round(size * 0.125),
  });

  return (
    <div className="relative shrink-0" style={{ width: size, height: size, color: 'var(--ink)' }}>
      {reduced || !webgl ? flat : (
        <Suspense fallback={flat}>
          <Scene size={size} progress={progress} over={over} fallback={flat} />
        </Suspense>
      )}
      <div className="absolute inset-0 grid place-items-center pointer-events-none">
        <div className="text-center">
          <div className="font-grotesk font-black tabular-nums leading-none" style={{ fontSize: numberPx, color: over ? 'var(--bad)' : 'var(--ink)', letterSpacing: '-0.03em' }}>
            <AnimatedNumber value={headline} />
          </div>
          <div className="font-grotesk text-[9.5px] uppercase tracking-[.14em] font-bold mt-1" style={{ color: 'var(--mute)' }}>
            {!hasTarget ? 'kcal eaten' : over ? 'kcal over' : 'kcal left'}
          </div>
          {hasTarget && (
            <div className="font-grotesk text-[10px] mt-0.5 tabular-nums" style={{ color: 'var(--faint)' }}>
              {Math.round(eaten.calories).toLocaleString()} / {Math.round(target.calories).toLocaleString()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
