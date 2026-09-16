/**
 * DEMO MODE BANNER — the one piece of demo-specific chrome inside the app.
 *
 * Deliberately quiet. The spec asks for a "subtle persistent demo
 * indicator", "non-intrusive but visible", "not visually distracting" —
 * and the reason is commercial, not aesthetic: the prospect is here to
 * look at the product, and a loud badge across every screen is the thing
 * they will remember instead of it. So this is one slim strip, in the
 * app's own tokens, carrying three things and nothing else:
 *
 *   · how long is left
 *   · which of the three identities they are currently seeing the product as
 *   · a way out
 *
 * It renders NOTHING at all for an ordinary signed-in user. The signal
 * comes from /auth/me's `demo` block, which the server derives from the
 * validated session — not from a flag this component could be tricked
 * into setting.
 *
 * The countdown here is a rendering, not a timer that matters. Reaching
 * zero on screen triggers one confirming request to the server; it is the
 * SERVER'S answer that ends the demo, and it would end at the same instant
 * with this component deleted.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import {
  fetchDemoSession, switchPersona, finishDemo, remainingMs, formatRemaining,
  syncClock, trackDemo, DEMO_EXPIRED_PATH,
} from '../demoSession.js';

const PERSONAS = [
  { key: 'OWNER', label: 'Gym Owner', home: '/app/trainer' },
  { key: 'TRAINER', label: 'Trainer', home: '/app/trainer' },
  { key: 'MEMBER', label: 'Member', home: '/app/client' },
];

// Which product surface each route IS, for the founder's "features
// visited" readout (spec 24).
//
// Mapped HERE, in the one component that already knows a demo is running,
// rather than by adding a tracking call to twenty page components. Those
// pages are the real product; a demo is a temporary state of one session,
// and sprinkling demo-aware code through screens that have nothing to do
// with demos is how a codebase ends up with a feature it cannot remove.
// This component is mounted in both layouts and unmounts with them, so it
// sees every navigation either role makes and nothing outside the app.
//
// Ordered most-specific first, because the first match wins -- otherwise
// /app/trainer/clients/:id would report as the members list.
const ROUTE_EVENTS = [
  [/^\/app\/trainer\/clients\/[^/]+/, 'member_profile_viewed'],
  [/^\/app\/trainer\/clients/, 'members_viewed'],
  [/^\/app\/trainer\/trainers/, 'trainer_viewed'],
  [/^\/app\/trainer\/workouts/, 'workout_viewed'],
  [/^\/app\/trainer\/nutrition/, 'nutrition_viewed'],
  [/^\/app\/trainer\/attendance/, 'attendance_viewed'],
  [/^\/app\/trainer\/?$/, 'dashboard_viewed'],
  [/^\/app\/client\/community/, 'community_viewed'],
  [/^\/app\/client\/workout/, 'workout_viewed'],
  [/^\/app\/client\/nutrition/, 'nutrition_viewed'],
  [/^\/app\/client\/progress/, 'progress_viewed'],
  [/^\/app\/client\/?$/, 'dashboard_viewed'],
];

const eventForPath = (path) => ROUTE_EVENTS.find(([re]) => re.test(path))?.[1] || null;

// How often the countdown re-renders, and how often it re-asks the server.
//
// One second for the display, because a countdown that moves in larger
// steps looks broken. Sixty seconds for the network, because the server is
// the authority on two things a local clock cannot know — revocation, and
// the true deadline — and neither needs sub-minute resolution. Polling
// harder would put a request per second per prospect against the API for a
// number that is already known locally (spec 39: "avoid unnecessary
// polling"). The last 90 seconds tighten to 10s so the final moments and
// the handoff to the expiry screen land promptly.
const TICK_MS = 1000;
const RESYNC_MS = 60_000;
const ENDGAME_MS = 90_000;
const ENDGAME_RESYNC_MS = 10_000;

export default function DemoBanner() {
  const { demo, refreshSession } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [session, setSession] = useState(null);
  const [left, setLeft] = useState(null);
  const [switching, setSwitching] = useState(null);
  const [open, setOpen] = useState(false);
  const endedRef = useRef(false);

  // Seed from /auth/me's demo block so the banner has a number to show on
  // first paint rather than a dash that resolves a moment later.
  useEffect(() => {
    if (!demo) { setSession(null); return; }
    syncClock(demo.serverTime);
    setSession(demo);
    setLeft(remainingMs(demo.expiresAt));
  }, [demo]);

  // Navigate to the expiry screen exactly once, however many timers,
  // resyncs and in-flight requests notice the end at the same moment.
  // The remembered link token is deliberately NOT cleared here -- the
  // expiry screen is about to read it so it can say why the demo ended
  // and use the prospect's own name; it clears it once it has.
  const endDemo = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    nav(DEMO_EXPIRED_PATH, { replace: true });
  }, [nav]);

  // Feature telemetry, one event per screen the prospect actually opens.
  // Deduplicated per path: React Router re-renders this component for
  // reasons other than navigation, and a founder reading "Members" viewed
  // forty times learns less than one reading that it was opened at all.
  const seenPaths = useRef(new Set());
  useEffect(() => {
    if (!session) return;
    const type = eventForPath(loc.pathname);
    if (!type || seenPaths.current.has(loc.pathname)) return;
    seenPaths.current.add(loc.pathname);
    trackDemo(type, { path: loc.pathname });
  }, [loc.pathname, session]);

  // The display tick.
  useEffect(() => {
    if (!session?.expiresAt) return undefined;
    const t = setInterval(() => {
      const ms = remainingMs(session.expiresAt);
      setLeft(ms);
      // Hitting zero locally does not END anything — it asks. The resync
      // below (or the very next API call the prospect makes) gets the
      // server's verdict, and api.js routes them to the expiry screen.
      if (ms === 0) fetchDemoSession().catch(endDemo);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [session?.expiresAt, endDemo]);

  // The authoritative resync.
  useEffect(() => {
    if (!session?.expiresAt) return undefined;
    let cancelled = false;
    let timer;
    const schedule = () => {
      const ms = remainingMs(session.expiresAt);
      timer = setTimeout(run, ms != null && ms <= ENDGAME_MS ? ENDGAME_RESYNC_MS : RESYNC_MS);
    };
    const run = async () => {
      try {
        const fresh = await fetchDemoSession();
        if (cancelled) return;
        // A revocation arrives here as a non-'active' state even though the
        // local clock still has time on it.
        if (fresh.state !== 'active') return endDemo();
        setSession((s) => ({ ...s, expiresAt: fresh.expiresAt }));
        setLeft(remainingMs(fresh.expiresAt));
        schedule();
      } catch {
        // api.js has already handled a demo_session_ended 401 by
        // navigating; anything else is a transient network blip and must
        // not end a demo that the server still considers live.
        if (!cancelled) schedule();
      }
    };
    schedule();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [session?.expiresAt, endDemo]);

  if (!session) return null;

  const current = PERSONAS.find((p) => p.key === (session.persona || 'OWNER')) || PERSONAS[0];
  const urgent = left != null && left <= 5 * 60_000;

  const choose = async (p) => {
    if (p.key === current.key) { setOpen(false); return; }
    setSwitching(p.key);
    try {
      const res = await switchPersona(p.key);
      // Re-read /auth/me so the whole app (role guards, nav, greeting)
      // follows the new identity rather than this component alone
      // pretending the switch happened.
      await refreshSession();
      setSession((s) => ({ ...s, persona: p.key }));
      setOpen(false);
      nav(res?.user?.role === 'CLIENT' ? '/app/client' : '/app/trainer', { replace: true });
    } catch {
      // A failed switch means the session is gone; api.js has already
      // routed on a 401, and anything else leaves them where they were.
    } finally {
      setSwitching(null);
    }
  };

  const end = async () => {
    await finishDemo();
    endDemo();
  };

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 text-[11.5px] flex-wrap"
      style={{
        background: 'var(--panel)',
        borderBottom: '1px solid var(--line)',
        color: 'var(--mute)',
      }}
      role="status"
      aria-live="off"
    >
      <span
        className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-[.16em] text-[9.5px]"
        style={{ color: 'var(--accent)' }}
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: 'var(--accent)' }}
          aria-hidden="true"
        />
        Demo mode
      </span>

      {/* aria-live is on the time alone, and polite: a screen reader
          announcing a new value every second would make the app unusable,
          so the visible number ticks while the announced one is left to
          the user to poll — except in the last five minutes, where it is
          worth interrupting for. */}
      <span
        className="tabular-nums font-semibold"
        style={{ color: urgent ? 'var(--warn)' : 'var(--ink)' }}
        aria-live={urgent ? 'polite' : 'off'}
      >
        {formatRemaining(left)} remaining
      </span>

      <span className="hidden sm:inline" style={{ color: 'var(--faint)' }}>·</span>

      {/* Owner → Trainer → Member, the part of the demo that shows this is
          three products in one. */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn-ghost btn-sm"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          Viewing as {current.label}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div
            role="menu"
            className="absolute left-0 mt-1 z-50 rounded-xl overflow-hidden min-w-[180px]"
            style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--e-3)' }}
          >
            {PERSONAS.map((p) => (
              <button
                key={p.key}
                role="menuitem"
                type="button"
                onClick={() => choose(p)}
                disabled={!!switching}
                className="w-full text-left px-3.5 py-2.5 text-[12px]"
                style={{
                  color: p.key === current.key ? 'var(--accent)' : 'var(--ink)',
                  background: 'transparent',
                }}
              >
                {p.label}
                {switching === p.key && <span style={{ color: 'var(--faint)' }}> …</span>}
                {p.key === current.key && <span style={{ color: 'var(--faint)' }}> · current</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        {/* Everything a prospect changes lives in the demo tenant and is
            wiped by the next reset -- said once, here, so no destructive
            action inside the product needs its own warning. */}
        <span className="hidden md:inline" style={{ color: 'var(--faint)' }}>
          Changes affect only this demo environment
        </span>
        <button type="button" onClick={end} className="btn-ghost btn-sm">End demo</button>
      </div>
    </div>
  );
}
