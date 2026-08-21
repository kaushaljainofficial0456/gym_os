/**
 * <Stage> — the ONE way 3D enters this app.
 *
 * WHY EVERY SCENE MUST GO THROUGH HERE
 * three.js is 508 kB (129 kB gzipped) in this bundle, and a WebGL context
 * is one of the most expensive things a page can hold. Left to ad-hoc
 * usage, 3D becomes the reason the app feels slow -- which is the exact
 * opposite of why it was added. So this wrapper is not ceremony; it is
 * where four non-negotiable behaviours live:
 *
 *   1. LAZY  — the scene, and three.js with it, is code-split behind
 *              React.lazy. A user who never scrolls to a 3D surface never
 *              downloads the renderer. This is the single biggest win
 *              available and it only works if nothing imports a scene
 *              statically.
 *   2. GATED — renders nothing until the element is actually on screen
 *              and the tab is visible.
 *   3. TIERED— DPR, antialiasing, shadows and postprocessing are chosen
 *              from the measured device tier, then downgraded if frames
 *              run over budget.
 *   4. OPT-OUT — `prefers-reduced-motion` and missing WebGL both fall
 *              back to a static `fallback` node rather than failing.
 *
 * THE FALLBACK IS NOT OPTIONAL, and it should look intentional. Roughly
 * every scene here is decorative; if 3D cannot run, the screen must still
 * be a finished screen, not a hole where a canvas was.
 */
import { Suspense, useRef, useState, useEffect, createContext, useContext } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useReducedMotion } from 'framer-motion';
import { useAdaptiveQuality, useIsActive } from './useDeviceTier.js';
import { hasWebGL } from './webgl.js';
import { perf } from '../tokens.js';
import { cn } from '../cn.js';

/**
 * Lets a scene inside the Canvas read the tier Stage resolved, so it can
 * scale its OWN cost (particle counts, geometry detail) and not just the
 * renderer settings. Without this the adaptive tiering would only control
 * DPR/antialiasing while the scene kept drawing the same workload.
 */
const StageTierContext = createContext('medium');
export function useStageTier() {
  return useContext(StageTierContext);
}

/* hasWebGL lives in ./webgl.js, NOT here — callers must be able to ask
   "can this device render 3D?" without importing @react-three/fiber and
   dragging three.js into their chunk. */

/**
 * @param {React.ReactNode} children   the scene graph (meshes, lights…)
 * @param {React.ReactNode} fallback   shown when 3D is unavailable/disabled
 * @param {boolean} interactive        false => canvas ignores pointer events
 *                                     (correct for backdrops, or the canvas
 *                                     eats clicks meant for the UI above it)
 * @param {'low'|'medium'|'high'} maxTier  ceiling, for scenes that should
 *                                     never request the expensive path
 */
export default function Stage({
  children,
  fallback = null,
  className,
  interactive = false,
  maxTier = 'high',
  camera = { position: [0, 0, 5], fov: 45 },
  onCreated,
  ...rest
}) {
  const hostRef = useRef(null);
  const active = useIsActive(hostRef);
  const reduced = useReducedMotion();
  const { tier, settings, onFrame } = useAdaptiveQuality({ enabled: active });

  // Defer the very first mount by a tick so 3D never competes with the
  // page's own first paint. Cheap, and it measurably improves how fast
  // the screen *feels* even though total load is unchanged.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const capped = tierCeiling(tier, maxTier);
  const q = capped === tier ? settings : perf[capped];

  const disabled = reduced || !hasWebGL();

  return (
    <div
      ref={hostRef}
      className={cn('relative', !interactive && 'pointer-events-none', className)}
      aria-hidden="true"     // decorative: never announced to screen readers
    >
      {disabled || !ready || !active ? (
        fallback
      ) : (
        <Suspense fallback={fallback}>
          <Canvas
            dpr={q.dpr}
            gl={{
              antialias: q.antialias,
              // `powerPreference: 'default'` rather than 'high-performance':
              // on laptops the latter can force the discrete GPU for what is
              // a decorative backdrop, costing battery for no visible gain.
              powerPreference: 'default',
              alpha: true,
            }}
            shadows={q.shadows}
            camera={camera}
            frameloop={active ? 'always' : 'never'}
            onCreated={onCreated}
            {...rest}
          >
            <FrameProbe onFrame={onFrame} />
            {/* Provider lives INSIDE Canvas: R3F renders its children with
                a separate reconciler, so a provider outside would not be
                visible to scene components. */}
            <StageTierContext.Provider value={capped}>
              {children}
            </StageTierContext.Provider>
          </Canvas>
        </Suspense>
      )}
    </div>
  );
}

/** Reports frame timing up to the adaptive-quality hook. Rendered inside
 *  the Canvas because useFrame only exists within the R3F tree. */
function FrameProbe({ onFrame }) {
  useFrame(() => onFrame(performance.now()));
  return null;
}

function tierCeiling(tier, max) {
  const order = ['low', 'medium', 'high'];
  return order.indexOf(tier) > order.indexOf(max) ? max : tier;
}
