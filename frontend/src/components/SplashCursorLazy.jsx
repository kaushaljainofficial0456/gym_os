/**
 * SplashCursorLazy — the lazy boundary for the login-page cursor effect.
 *
 * Same discipline as design/three/AmbientBackdrop.jsx: this file decides
 * WHETHER to load the WebGL effect before ever importing it, so a device
 * that can't or shouldn't run it (no WebGL, reduced-motion, mobile touch
 * where a cursor trail means nothing) never pays for the ~15KB chunk.
 * Login is the very first thing every user sees -- it must never be the
 * page that feels slow because of a decorative flourish.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { hasWebGL } from '../design/three/webgl.js';

const Impl = lazy(() => import('./SplashCursor.jsx'));

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function readAccentColor() {
  if (typeof document === 'undefined') return '#E07A63';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v || '#E07A63';
}

/** @param {boolean} enabled  desktop-only by default -- pass explicitly to override */
export default function SplashCursorLazy({ enabled = true }) {
  const reduced = useReducedMotion();
  const [color, setColor] = useState(readAccentColor);
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    setIsTouch(window.matchMedia('(pointer: coarse)').matches);
    const obs = new MutationObserver(() => setColor(readAccentColor()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const use3D = enabled && !reduced && !isTouch && hasWebGL();
  if (!use3D) return null;

  return (
    <Suspense fallback={null}>
      <Impl RAINBOW_MODE={false} COLOR={color} SPLAT_FORCE={5200} DENSITY_DISSIPATION={3.2} />
    </Suspense>
  );
}
