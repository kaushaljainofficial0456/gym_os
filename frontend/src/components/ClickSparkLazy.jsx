/**
 * ClickSparkLazy — lazy boundary + theming for ClickSpark, mounted once at
 * the app root in App.jsx so it covers trainer, client and owner alike
 * with one instance instead of one per page.
 */
import { lazy, Suspense, useEffect, useState } from 'react';

const Impl = lazy(() => import('./ClickSpark.jsx'));

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
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#E07A63';
}

export default function ClickSparkLazy({ children }) {
  const reduced = useReducedMotion();
  const [color, setColor] = useState(readAccentColor);

  useEffect(() => {
    const obs = new MutationObserver(() => setColor(readAccentColor()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  if (reduced) return children;

  return (
    <Suspense fallback={children}>
      <Impl sparkColor={color} sparkSize={9} sparkRadius={16} sparkCount={6} duration={380} extraScale={1}>
        {children}
      </Impl>
    </Suspense>
  );
}
