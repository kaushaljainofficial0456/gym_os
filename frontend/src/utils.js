import { useCallback, useEffect, useRef, useState } from 'react';

export const fmtK = (n) => Number(n || 0).toLocaleString('en-US');
export const fmt1 = (n) => (Math.round(Number(n || 0) * 10) / 10).toFixed(1);
export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
};
export const daysAgoLabel = (iso) => {
  if (!iso) return '—';
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
};
export const cls = (...xs) => xs.filter(Boolean).join(' ');

export const STATUS_META = {
  ON_TRACK: { label: 'ON TRACK', cls: 'text-good border-good/40 bg-good/10' },
  NEEDS_ATTENTION: { label: 'NEEDS ATTENTION', cls: 'text-warn border-warn/40 bg-warn/10' },
  AT_RISK: { label: 'AT RISK', cls: 'text-bad border-bad/40 bg-bad/10' },
  INACTIVE: { label: 'INACTIVE', cls: 'text-mute border-line bg-white/5' }
};
export const GOAL_LABEL = {
  FAT_LOSS: 'Fat Loss', MUSCLE_GAIN: 'Muscle Gain', RECOMP: 'Recomposition',
  STRENGTH: 'Strength', GENERAL: 'General Fitness'
};

export function useCountUp(target, dur = 900, dec = 0) {
  const [val, setVal] = useState(0);
  const raf = useRef();
  useEffect(() => {
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(Number((target * e).toFixed(dec)));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, dur, dec]);
  return val;
}

export function useFetch(fn, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  // A silent reload (see reload() below) skips the loading-flag toggle for
  // ONE upcoming fetch -- read once per effect run, then reset, so it never
  // silently "leaks" into a later non-silent reload.
  const silentNext = useRef(false);
  useEffect(() => {
    let alive = true;
    const silent = silentNext.current;
    silentNext.current = false;
    if (!silent) setLoading(true);
    fn()
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e); })
      .finally(() => { if (alive && !silent) setLoading(false); });
    return () => { alive = false; };
  }, [...deps, tick]);
  // Stable identity (was a fresh arrow fn every render) so consumers that
  // pass the whole { data, loading, error, reload } object down — e.g. via
  // Outlet context — don't get a new object on every unrelated re-render.
  //
  // reload({ silent: true }): refetches WITHOUT toggling `loading` --
  // `data` stays exactly as it was (still rendered) until the fresh
  // response arrives, then swaps in place. Fixes a real bug (follow-up
  // hardening pass, Sections 5/15): every consumer that called a bare
  // reload() after a small action (logging one food, toggling a meal,
  // editing a quantity) BRIEFLY set `loading: true` on this shared
  // Outlet-context value -- and any page gating its whole render on
  // `home.loading` (Nutrition.jsx's own `if (home.loading) return
  // <Spinner/>`) would unmount ITS ENTIRE TREE, including any open
  // modal/sheet, then remount fresh once the refetch finished. That's
  // the actual mechanism behind "the page reloads" after tapping +,
  // not a real navigation/window reload -- confirmed by reading this
  // hook's own state machine, not assumed. Every EXISTING bare reload()
  // call keeps its exact old behavior (opt-in only, zero risk to
  // whichever callers genuinely want a full blocking refresh, e.g. a
  // real page-level retry after an error).
  const reload = useCallback((opts) => {
    if (opts?.silent) silentNext.current = true;
    setTick((t) => t + 1);
  }, []);
  return { data, loading, error, reload };
}

// Tiny deterministic SVGs for empty/loading states are in UI.jsx.
export const WEEKDAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
