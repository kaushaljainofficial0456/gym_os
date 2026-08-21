/**
 * MuscleBody3D — the lazy boundary for the anatomical muscle picker.
 *
 * Follows the same split as design/three/AmbientBackdrop.jsx: THIS file
 * must never statically import three.js / @react-three/fiber / drei, or
 * every page that imports the muscle picker pulls the whole 3D bundle into
 * its chunk. The real Canvas + GLTF + raycasting implementation lives in
 * ./MuscleBody3DImpl.jsx and is loaded with React.lazy, only once this file
 * has decided 3D is actually usable on this device.
 *
 * The muscle list itself (skos-muscle-map.json) is fetched here, unlazily
 * -- it's a ~2KB JSON, not 3D code -- so the flat button-grid fallback
 * (shown when WebGL is unavailable, and always shown alongside the canvas
 * as an accessible/keyboard-usable alternative) can render immediately.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { hasWebGL } from '../../design/three/webgl.js';

const Impl = lazy(() => import('./MuscleBody3DImpl.jsx'));

const MAP_URL = '/assets/anatomy/skos-muscle-map.json';

export function useMuscleMap() {
  const [map, setMap] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(MAP_URL).then((r) => r.json()).then((d) => { if (live) setMap(d); }).catch(() => { if (live) setMap({}); });
    return () => { live = false; };
  }, []);
  return map;
}

/**
 * @param {string|null} selectedGroup     currently-active exerciseMuscleGroup filter (e.g. "CHEST"), or null
 * @param {(group: string, muscleId: string, displayName: string) => void} onSelect
 * @param {string} className
 * @param {number|string} height
 */
export default function MuscleBody3D({ selectedGroup, onSelect, className = '', height = 440 }) {
  const map = useMuscleMap();
  const [use3D] = useState(() => hasWebGL());

  const groups = map
    ? Object.entries(map).reduce((acc, [id, m]) => {
        if (!acc.some((g) => g.group === m.exerciseMuscleGroup)) acc.push({ group: m.exerciseMuscleGroup, displayName: m.displayName, id });
        return acc;
      }, [])
    : [];

  return (
    <div className={className}>
      <div className="rounded-2xl border border-line bg-white/[.02] overflow-hidden" style={{ height }}>
        {use3D ? (
          <Suspense fallback={<div className="w-full h-full grid place-items-center text-mute text-xs font-grotesk">Loading 3D model…</div>}>
            <Impl map={map} selectedGroup={selectedGroup} onSelect={onSelect} />
          </Suspense>
        ) : (
          <div className="w-full h-full grid place-items-center text-mute text-xs font-grotesk px-6 text-center">
            3D isn't available on this device — pick a muscle group below instead.
          </div>
        )}
      </div>

      {/* Always-present flat list: the accessible / keyboard / no-WebGL
          path, and often just the faster way to pick a muscle. Not a
          fallback bolted on afterwards -- a first-class second way in. */}
      <div className="flex flex-wrap gap-1.5 mt-3">
        {groups.map((g) => (
          <button
            key={g.group}
            type="button"
            onClick={() => onSelect?.(g.group, g.id, g.displayName)}
            className={`chip border transition-colors ${selectedGroup === g.group ? 'bg-gradient-to-r from-ember to-gold text-bg border-transparent' : 'border-line text-mute hover:text-ink hover:border-white/20'}`}
          >
            {g.displayName}
          </button>
        ))}
        {!map && <span className="text-[11px] text-faint font-grotesk">Loading muscle list…</span>}
      </div>
    </div>
  );
}
