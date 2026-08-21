/**
 * Device capability tiering for the 3D layer.
 *
 * WHY MEASURE INSTEAD OF SNIFF
 * User-agent sniffing cannot tell a flagship Android from a budget one,
 * and they differ by an order of magnitude in GPU throughput. The honest
 * signals available in a browser are coarse but real:
 *
 *   deviceMemory        — RAM in GB (Chromium only; undefined elsewhere)
 *   hardwareConcurrency — logical CPU cores
 *   WEBGL_debug_renderer_info — the actual GPU string, where not blocked
 *
 * None is authoritative on its own, so this combines them into a
 * conservative FIRST GUESS and then corrects using measured frame time
 * (see useAdaptiveQuality). Guessing high and stuttering is a worse first
 * impression than guessing low and sharpening a second later.
 *
 * THE DEFAULT IS 'medium', NOT 'high': on a browser exposing none of
 * these hints we do not know we can afford high, and assuming we can is
 * how a scene ends up at 15fps on the device of the user least able to
 * tolerate it.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { perf, FRAME_BUDGET_MS } from '../tokens.js';

const TIERS = ['low', 'medium', 'high'];

/** One-shot static capability guess. Cheap; safe to call during render. */
export function guessDeviceTier() {
  if (typeof window === 'undefined') return 'medium';   // SSR / no DOM

  const mem = navigator.deviceMemory;                   // undefined outside Chromium
  const cores = navigator.hardwareConcurrency || 0;

  // A coarse-pointer primary input means phone/tablet in practice. Not
  // proof of a weak GPU, but it correlates with thermal limits and, more
  // importantly, with a high DPR that multiplies the pixel cost.
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;

  // Explicit low signals win immediately.
  if ((mem !== undefined && mem <= 2) || (cores > 0 && cores <= 2)) return 'low';

  // Strong desktop-ish signals.
  if (!coarse && ((mem !== undefined && mem >= 8) || cores >= 8)) return 'high';

  // Capable phone: plenty of cores AND memory.
  if (coarse && cores >= 8 && (mem === undefined || mem >= 6)) return 'high';

  return 'medium';
}

/**
 * Adaptive quality: starts from the static guess, then DOWNGRADES if
 * frames are consistently over budget.
 *
 * Deliberately one-way (downgrade only). An upgrade path would let the
 * renderer oscillate between tiers at the boundary -- quality visibly
 * pumping up and down is more distracting than simply running a notch
 * lower, and re-creating a WebGL pipeline mid-session is not free.
 *
 * Requires `sustained` consecutive slow frames before acting, so one GC
 * pause or route change does not permanently degrade the scene.
 */
export function useAdaptiveQuality({ enabled = true, sustained = 45 } = {}) {
  const [tier, setTier] = useState(guessDeviceTier);
  const slowFrames = useRef(0);
  const lastTs = useRef(0);

  const onFrame = useCallback(
    (now) => {
      if (!enabled) return;
      const prev = lastTs.current;
      lastTs.current = now;
      if (!prev) return;

      const delta = now - prev;
      // Ignore absurd deltas: a backgrounded tab or a paused rAF produces
      // multi-second gaps that say nothing about rendering cost.
      if (delta > 200) { slowFrames.current = 0; return; }

      if (delta > FRAME_BUDGET_MS) {
        slowFrames.current += 1;
        if (slowFrames.current >= sustained) {
          slowFrames.current = 0;
          setTier((t) => {
            const i = TIERS.indexOf(t);
            return i > 0 ? TIERS[i - 1] : t;
          });
        }
      } else if (slowFrames.current > 0) {
        slowFrames.current -= 1;   // decay, so only SUSTAINED slowness counts
      }
    },
    [enabled, sustained]
  );

  return { tier, settings: perf[tier], onFrame };
}

/**
 * True while the element is on screen AND the tab is visible.
 *
 * Rendering a WebGL scene nobody is looking at burns battery for nothing
 * -- on a phone that is a directly felt cost, not a theoretical one. The
 * existing TunnelBackdrop already paused on visibility change; this
 * generalises it and adds the intersection half, since a scene scrolled
 * off screen is just as invisible as a backgrounded tab.
 */
export function useIsActive(ref, { rootMargin = '120px' } = {}) {
  const [onScreen, setOnScreen] = useState(false);
  const [tabVisible, setTabVisible] = useState(
    typeof document === 'undefined' ? true : !document.hidden
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => setOnScreen(entries.some((e) => e.isIntersecting)),
      { rootMargin }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref, rootMargin]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  return onScreen && tabVisible;
}
