/**
 * prefers-reduced-motion, in eight lines and no dependency.
 *
 * framer-motion exports a hook that does exactly this, and Login imports
 * it — but Login is EAGERLY bundled (App.jsx keeps it out of the lazy
 * routes on purpose, because it is the first thing an unauthenticated
 * visitor needs). Pulling framer-motion in for one boolean puts the whole
 * animation library in the chunk every first-time visitor downloads
 * before anything paints.
 *
 * Every lazily-loaded page should keep using framer's version; it is
 * already in those chunks and better tested. This exists for the handful
 * of modules on the critical path.
 */
import { useEffect, useState } from 'react';

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    let mq;
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return undefined; }
    const onChange = () => setReduced(mq.matches);
    // Someone can change this setting while the page is open, and the
    // page should stop moving then rather than at the next navigation.
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export default usePrefersReducedMotion;
