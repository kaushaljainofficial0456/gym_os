import { useCallback, useEffect, useState } from 'react';

// Mirrors frontend/src/utils.js's own useFetch exactly (kept as its own
// copy for the same reason api.js is -- see that file's header comment).
export function useFetch(fn, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}

export function money(n) {
  if (n == null) return 'N/A';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
