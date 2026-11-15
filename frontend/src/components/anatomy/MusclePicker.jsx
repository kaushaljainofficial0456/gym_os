/**
 * Pick exercises by muscle, on the body.
 *
 * The 3D body (MuscleBody3DImpl, loaded only when this opens) with a row
 * of muscle chips under it -- the chips are the quick way, and the way
 * when 3D is unavailable or turned off by reduced-motion. Tapping either
 * selects that muscle's exercises.
 *
 * Muscle groups map onto the library's primary_muscle values: the body has
 * one "Chest" but the library also files UPPER CHEST and LOWER CHEST, and
 * every delt head also counts general SHOULDERS work.
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { hasWebGL } from '../../design/three/webgl.js';
import { useMuscleMap } from './MuscleBody3D.jsx';
import './muscle-picker.css';

const Impl = lazy(() => import('./MuscleBody3DImpl.jsx'));

export const GROUP_MUSCLES = {
  CHEST: ['CHEST', 'UPPER CHEST', 'LOWER CHEST'],
  'FRONT DELTS': ['FRONT DELTS', 'SHOULDERS'],
  'SIDE DELTS': ['SIDE DELTS', 'SHOULDERS'],
  'REAR DELTS': ['REAR DELTS', 'SHOULDERS'],
  'LOWER BACK': ['LOWER BACK', 'POSTERIOR CHAIN'],
  HAMSTRINGS: ['HAMSTRINGS', 'POSTERIOR CHAIN'],
  ABS: ['ABS', 'CORE'],
};
export const musclesFor = (group) => GROUP_MUSCLES[group] || (group ? [group] : []);

/** The chips: one per exercise muscle group, in body order. */
const ORDER = ['CHEST', 'FRONT DELTS', 'SIDE DELTS', 'REAR DELTS', 'TRAPS', 'UPPER BACK', 'LATS', 'BICEPS', 'TRICEPS', 'FOREARMS',
  'ABS', 'CORE', 'LOWER BACK', 'GLUTES', 'QUADS', 'HAMSTRINGS', 'CALVES'];

export default function MusclePicker({ selected, onSelect, height = 340 }) {
  const map = useMuscleMap();
  const [use3D] = useState(() => hasWebGL() && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const names = {};
  for (const m of Object.values(map || {})) {
    if (m.exerciseMuscleGroup && !names[m.exerciseMuscleGroup]) names[m.exerciseMuscleGroup] = m.displayName.replace(/\s*\(.*\)$/, '');
  }
  names.CORE = 'Core';
  const groups = ORDER.filter((g) => names[g]);
  const pick = (g) => onSelect(g === selected ? null : g);

  // A muscle tapped on the body brings its chip into view.
  const chipsRef = useRef(null);
  useEffect(() => {
    if (!selected) return;
    const el = chipsRef.current?.querySelector(`[data-group="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [selected]);

  return (
    <div className="grid gap-2.5">
      {use3D && (
        <div className="mp-stage" style={{ height }}>
          <Suspense fallback={<div className="mp-stage__wait" aria-hidden="true"><span /></div>}>
            {map && <Impl map={map} selectedGroup={selected} labelFor={names} onSelect={(g) => onSelect(g)} />}
          </Suspense>
        </div>
      )}
      <div ref={chipsRef} className="mp-chips no-scrollbar" role="group" aria-label="Muscles">
        {groups.map((g) => (
          <button key={g} type="button" className="mp-chip" data-group={g} aria-pressed={selected === g} onClick={() => pick(g)}>
            {names[g]}
          </button>
        ))}
      </div>
    </div>
  );
}
