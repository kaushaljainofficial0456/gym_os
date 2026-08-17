/**
 * AmbientBackdrop — the LAZY BOUNDARY for all 3D in this app.
 *
 * THIS FILE MUST NEVER STATICALLY IMPORT three.js, @react-three/fiber, or
 * anything that does (including ./Stage.jsx).
 *
 * WHY, CONCRETELY: the first version of this design system exported
 * `Stage` from the barrel and imported the scene lazily, on the
 * assumption that lazy-loading the SCENE was enough. It is not — Stage
 * itself imports `Canvas` from @react-three/fiber, so any module reaching
 * Stage statically pulls the whole renderer in. The measured cost of that
 * mistake was the entry chunk going from **224 kB to 509 kB gzipped**,
 * with three.js hoisted out of its own lazy chunk and into the bundle
 * every user downloads on first paint. The fix is this file: a thin,
 * three-free wrapper that decides whether to load 3D at all, and only
 * then imports the implementation.
 *
 * Everything a caller needs before that decision — the theme palette, the
 * CSS gradient fallback, the WebGL check, the reduced-motion check — is
 * computed here, using no 3D code.
 *
 * Usage:
 *     <div className="relative overflow-hidden">
 *       <AmbientBackdrop />
 *       …content…
 *     </div>
 */
import { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';
import { brand } from '../tokens.js';
import { hasWebGL } from './webgl.js';
import { useIsActive } from './useDeviceTier.js';
import { cn } from '../cn.js';

// The ONLY reference to the 3D implementation, and it is dynamic.
const Impl = lazy(() => import('./AmbientBackdropImpl.jsx'));

/** Reads the app's current theme. The 3D layer needs a real colour value
 *  because a WebGL material cannot resolve `var(--accent)`. Watches the
 *  <html> class list so a theme toggle re-tints the scene live. */
export function useThemePalette() {
  const read = () =>
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('light')
      ? brand.light
      : brand.dark;

  const [palette, setPalette] = useState(read);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => setPalette(read()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => obs.disconnect();
  }, []);

  return palette;
}

/**
 * CSS-gradient stand-in shown whenever 3D is unavailable, disabled, or
 * still downloading. Deliberately close in tone to the scene so the
 * screen looks finished either way — an empty rectangle reads as a broken
 * image, which is worse than never having offered 3D.
 */
export function GradientFallback({ palette, className }) {
  return (
    <div
      className={cn('absolute inset-0', className)}
      style={{
        background: `radial-gradient(120% 80% at 50% 0%, ${palette.accent}14, transparent 70%)`,
      }}
    />
  );
}

export default function AmbientBackdrop({
  className,
  intensity = 0.5,
  maxTier = 'medium',
  ...rest
}) {
  const palette = useThemePalette();
  const reduced = useReducedMotion();
  const hostRef = useRef(null);

  // Gate the DOWNLOAD on visibility too, not just the render. Scrolling
  // past a 3D section should not have cost the user 500 kB.
  const active = useIsActive(hostRef, { rootMargin: '200px' });

  const use3D = active && !reduced && hasWebGL();

  return (
    <div
      ref={hostRef}
      className={cn('absolute inset-0 pointer-events-none', className)}
      aria-hidden="true"
    >
      {use3D ? (
        <Suspense fallback={<GradientFallback palette={palette} />}>
          <Impl palette={palette} intensity={intensity} maxTier={maxTier} {...rest} />
        </Suspense>
      ) : (
        <GradientFallback palette={palette} />
      )}
    </div>
  );
}
