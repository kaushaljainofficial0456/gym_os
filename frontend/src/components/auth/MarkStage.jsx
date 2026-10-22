/**
 * MarkStage — the lazy boundary for the 3D brand mark.
 *
 * Imports no three.js: the sign-in screens are in the bundle every visitor
 * downloads first (see AuthStage's old note and scripts/check-bundle.mjs),
 * so this only DECIDES whether to fetch the renderer. Until it arrives --
 * or when it never will -- the flat BrandMark in the same slot is the mark.
 *
 * Skipped for: reduced motion, no WebGL, devices that guess 'low', and
 * automated browsers (the e2e and visual tests need a still, deterministic
 * screen, and a GPU-less runner would be drawing chrome in software).
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { hasWebGL } from '../../design/three/webgl.js';
import { guessDeviceTier } from '../../design/three/useDeviceTier.js';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.js';

const Impl = lazy(() => import('./MarkStageImpl.jsx'));

export default function MarkStage(props) {
  const reduced = usePrefersReducedMotion();
  const [capable] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (window.navigator.webdriver) return false;
    return hasWebGL() && guessDeviceTier() !== 'low';
  });
  // Not before the page is idle: compiling the materials' shaders is real
  // main-thread work on a phone, and the first second belongs to the
  // screen's own entrance. The flat mark is drawing in meanwhile.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (reduced || !capable) return undefined;
    const ric = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
    const cancel = window.cancelIdleCallback || clearTimeout;
    const id = ric(() => setIdle(true), { timeout: 1200 });
    return () => cancel(id);
  }, [reduced, capable]);
  if (reduced || !capable || !idle) return null;
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  );
}
