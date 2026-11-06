import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Runs `run(value)` once when the URL carries `?<param>=...`, then drops
 * the param (replace, not push) so Back and refresh do not re-open it.
 * This is how a dashboard shortcut lands INSIDE an action -- the form
 * already open -- instead of on a page you then have to search.
 *
 * `ready` holds it until the page has the data the action needs; the call
 * may sit above a page's loading early-return, which is why `run` is read
 * through a ref rather than captured once.
 */
export function useQueryAction(param, run, ready = true) {
  const [params, setParams] = useSearchParams();
  const value = params.get(param);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!value || !ready) return;
    runRef.current(value);
    const next = new URLSearchParams(params);
    next.delete(param);
    setParams(next, { replace: true });
  }, [value, ready]); // eslint-disable-line react-hooks/exhaustive-deps
}
