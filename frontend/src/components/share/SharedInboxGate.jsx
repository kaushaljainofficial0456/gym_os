/**
 * Watches for things shared with this member in the app and shows them,
 * one at a time, in SharedInboxSheet -- which is only downloaded when
 * there is something to show.
 *
 *  - On start (once the layout says nothing else owns the screen) and when
 *    the app comes back to the foreground, at most every two minutes.
 *  - Straight away when the bell's link lands here as ?share=<id>.
 *  - Not over a workout in progress: a popup between sets is the last
 *    thing anyone wants. The bell keeps it.
 *  - "Not now" hides one for this visit; it stays in the bell.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';

const Sheet = lazy(() => import('./SharedInboxSheet.jsx'));
const LATER_KEY = 'sk-share-later';
const CHECK_EVERY_MS = 2 * 60_000;

const laterSet = () => { try { return new Set(JSON.parse(sessionStorage.getItem(LATER_KEY) || '[]')); } catch { return new Set(); } };
const addLater = (id) => { try { sessionStorage.setItem(LATER_KEY, JSON.stringify([...laterSet(), id])); } catch { /* private mode */ } };
const inSession = () => { try { return !!localStorage.getItem('activeWorkoutSession'); } catch { return false; } };

export default function SharedInboxGate({ ready, onShowing }) {
  const loc = useLocation();
  const nav = useNavigate();
  const [queue, setQueue] = useState([]);       // pending shares still to show
  const [current, setCurrent] = useState(null); // the one on screen
  const [canPlan, setCanPlan] = useState(true);
  const lastCheck = useRef(0);

  const check = useCallback(async (force) => {
    if (!force && Date.now() - lastCheck.current < CHECK_EVERY_MS) return;
    lastCheck.current = Date.now();
    try {
      const r = await api('/app-shares/inbox');
      setCanPlan(r.can_plan !== false);
      const later = laterSet();
      setQueue((r.shares || []).filter((s) => !later.has(s.id)));
    } catch { /* quiet: the bell still has them */ }
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    check(true);
    const onVisible = () => { if (document.visibilityState === 'visible') check(false); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [ready, check]);

  // The bell's link: /app/client?share=<id>. Open it whatever else is up,
  // then take the parameter off so a refresh does not reopen it.
  //
  // Not cancelled when the parameter comes off: that change re-runs this
  // effect, and a cleanup that dropped the answer threw away the very
  // share the member had just tapped. Only unmounting drops it.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const deepId = new URLSearchParams(loc.search).get('share');
  useEffect(() => {
    if (!deepId) return;
    api(`/app-shares/${encodeURIComponent(deepId)}`)
      .then((r) => { if (alive.current && r.share) { setCanPlan(r.can_plan !== false); setCurrent(r.share); } })
      .catch(() => {});
    const params = new URLSearchParams(loc.search);
    params.delete('share');
    nav({ pathname: loc.pathname, search: params.toString() ? `?${params}` : '' }, { replace: true });
  }, [deepId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The layout holds its own first-visit tip while a share is on screen.
  useEffect(() => { onShowing?.(!!current); }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show the next one when nothing is on screen and the moment is right.
  // "Nothing on screen" includes every other dialog and menu -- the first-
  // visit tip, the notification prompt, the bell -- which can open a beat
  // after the page does,
  // so this waits a moment and looks, and looks again until it is clear.
  const onWorkout = loc.pathname.startsWith('/app/client/workout');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (current || !ready || !queue.length) return undefined;
    if (onWorkout && inSession()) return undefined;
    const h = setTimeout(() => {
      // An open menu counts too: the bell's list is one, and a popup over
      // it would land on the very row the member was about to tap.
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) setTick((t) => t + 1);
      else setCurrent(queue[0]);
    }, 1500);
    return () => clearTimeout(h);
  }, [current, ready, queue, onWorkout, tick]);

  if (!current) return null;
  const remaining = queue.filter((s) => s.id !== current.id).length;
  const drop = (id) => setQueue((q) => q.filter((s) => s.id !== id));

  return (
    <Suspense fallback={null}>
      <Sheet
        share={current}
        canPlan={canPlan}
        remaining={remaining}
        onAnswered={(id, closeIt) => { drop(id); if (closeIt) setCurrent(null); }}
        onNext={() => { drop(current.id); setCurrent(null); }}
        onLater={() => { addLater(current.id); drop(current.id); setCurrent(null); }}
      />
    </Suspense>
  );
}
