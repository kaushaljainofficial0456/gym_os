/**
 * Get the 3D body ready before anyone asks for it: the three.js chunk, the
 * model (downloaded and Draco-decoded into drei's cache) and the muscle
 * map. Called when the app is idle, so opening the Workout page or the
 * muscle picker shows the body at once instead of after 2-3 seconds.
 *
 * Skipped on Save-Data / 2G, and where there is no WebGL to draw it with.
 * Imports nothing heavy itself -- only the dynamic import pulls three in.
 */
import { hasWebGL } from '../../design/three/webgl.js';
import { loadMuscleMap } from './MuscleBody3D.jsx';

let started = false;

export function prefetchBody({ delay = 0 } = {}) {
  if (started || typeof window === 'undefined') return;
  const conn = navigator.connection;
  if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType || '')) return;
  if (!hasWebGL()) return;
  started = true;
  const go = () => {
    loadMuscleMap();
    import('./bodyModel.js').then((m) => m.preloadBody()).catch(() => { started = false; });
    // The picker's own chunk too, so React.lazy has it in hand.
    import('./MuscleBody3DImpl.jsx').catch(() => {});
  };
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  setTimeout(() => idle(go, { timeout: 3000 }), delay);
}
