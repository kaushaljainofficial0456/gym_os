/**
 * GLASS TAB BAR — the client app's bottom navigation.
 *
 * A floating pill of frosted glass with a lens that marks where you are.
 *
 *  - TAP a tab and the lens slides there like liquid: its leading edge is
 *    a stiff spring and its trailing edge a soft one, so it stretches
 *    toward the new tab mid-flight, thins slightly while stretched, and
 *    settles back into a pill. No hand-drawn keyframes -- the shape is
 *    what two springs do to the gap between them.
 *  - PRESS AND DRAG along the bar and the lens lifts (grows, rims, the
 *    icon under it swells), chases the finger on the same two springs,
 *    and drops onto the nearest tab when you let go.
 *
 * WHY THE FLIGHT RUNS ON THE COMPOSITOR. A tap navigates, and mounting
 * the next page (Progress draws its charts) holds the main thread for up
 * to ~200 ms -- long enough to freeze any JS-driven animation mid-slide.
 * So a flight is simulated up front and handed to the browser as Web
 * Animations keyframes that touch nothing but `transform`, which keep
 * running while React renders. The lens is three pieces for the same
 * reason: two end caps and a middle that scales, so the pill can stretch
 * without its ends turning into ellipses and without animating `width`.
 * The pieces are opaque and overlap by a pixel; the translucency is
 * applied once to the group, so no seam can show where they meet.
 * A drag has no page render competing with it, so it runs the springs
 * live, frame by frame.
 *
 * Every tab is still a real NavLink: the route is the source of truth,
 * keyboard and screen-reader users get ordinary links with aria-current,
 * and back/forward moves the lens because the route moved. The click that
 * ends a drag is swallowed so it cannot also open the tab it started on.
 *
 * Reduced motion: the lens moves without travel and never lifts.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useReducedMotion } from 'framer-motion';
import Icon from './Icon.jsx';
import './glassTabBar.css';

// The edge moving TOWARD the new tab leads; the one leaving it trails.
// (stiffness, damping, mass -- both slightly under-damped.)
const LEAD = { k: 560, c: 36, m: 0.8 };
const TRAIL = { k: 200, c: 25, m: 1 };
// Under a finger the lens must keep up, so it chases on stiffer springs.
const DRAG_LEAD = { k: 1100, c: 60, m: 1 };
const DRAG_TRAIL = { k: 460, c: 40, m: 1 };
const LIFT = { k: 420, c: 28, m: 1 };
const LIFT_SCALE = 0.18; // how much bigger the lens gets when lifted
const SQUASH = 0.14;     // how much thinner at double length
const DRAG_SLOP = 8;     // px of travel before a press becomes a drag
const FPS = 60;
const SUBSTEPS = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// One semi-implicit Euler step of a damped spring pulling s.x to target.
function spring(s, target, cfg, dt) {
  const a = (-cfg.k * (s.x - target) - cfg.c * s.v) / cfg.m;
  s.v += a * dt;
  s.x += s.v * dt;
}
const still = (s, target, eps) => Math.abs(s.x - target) < eps && Math.abs(s.v) < eps * 20;
const at = (x) => ({ x, v: 0 });
const copy = (st) => ({ l: { ...st.l }, r: { ...st.r }, lift: { ...st.lift } });

export default function GlassTabBar({ items, ariaLabel = 'Main', tourId }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const trackRef = useRef(null);
  const lensRef = useRef(null);
  const midRef = useRef([]);          // the stretching middle: fill, rim
  const capRef = useRef([]);          // the travelling right cap: fill, rim
  const tabRefs = useRef([]);
  const geo = useRef(null);           // { w, rad } of a resting lens
  const phys = useRef({ l: at(0), r: at(0), lift: at(0) });
  const flight = useRef(null);        // the running compositor animation
  const drag = useRef(null);          // the live drag, if any
  const gesture = useRef(null);       // a press that may become a drag
  const swallowClick = useRef(false);
  const prevActive = useRef(-1);
  const [lifted, setLifted] = useState(false);
  const [under, setUnder] = useState(null);
  // The tab just chosen, lit before its page has finished rendering --
  // the bar answers the touch, not the router.
  const [pending, setPending] = useState(null);

  const active = items.findIndex((it) => !!matchPath({ path: it.to, end: !!it.end }, loc.pathname));
  const shown = pending ?? active;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => { setPending(null); }, [active]);

  const rectOf = useCallback((i) => {
    const tab = tabRefs.current[i];
    const track = trackRef.current;
    if (!tab || !track) return null;
    const a = tab.getBoundingClientRect();
    // The lens is positioned inside the track's border, not on it.
    const origin = track.getBoundingClientRect().left + track.clientLeft;
    return { l: a.left - origin, r: a.right - origin, w: a.width };
  }, []);

  // The three transforms that draw a lens spanning [l, r], lifted by `lift`.
  const shape = useCallback((l, r, lift) => {
    const { w, rad } = geo.current;
    const s = Math.max(2 * rad, r - l);
    const thin = 1 - SQUASH * clamp(s / w - 1, 0, 1);
    return {
      lens: `translateX(${(l + s / 2).toFixed(2)}px) scale(${(1 + LIFT_SCALE * lift).toFixed(4)}) scaleY(${thin.toFixed(4)}) translateX(${(-s / 2).toFixed(2)}px)`,
      // The middle overlaps each cap by 1px (glassTabBar.css).
      mid: `scaleX(${((s - 2 * rad + 2) / (w - 2 * rad + 2)).toFixed(4)})`,
      cap: `translateX(${(s - w).toFixed(2)}px)`,
    };
  }, []);

  const paint = useCallback((f) => {
    lensRef.current.style.transform = f.lens;
    midRef.current.forEach((el) => { el.style.transform = f.mid; });
    capRef.current.forEach((el) => { el.style.transform = f.cap; });
  }, []);

  // Where the lens is right now, mid-flight or not, with its velocity --
  // the starting point for whatever moves it next. Stops the flight and
  // pins the lens there, so nothing jumps.
  const halt = useCallback(() => {
    const fl = flight.current;
    flight.current = null;
    if (fl) {
      const t = Number(fl.anims[0].currentTime);
      const done = fl.anims[0].playState === 'finished' || !Number.isFinite(t);
      const st = done ? fl.frames[fl.frames.length - 1] : fl.frames[clamp(Math.floor((t * FPS) / 1000), 0, fl.frames.length - 1)];
      fl.anims.forEach((a) => a.cancel());
      phys.current = copy(st);
      paint(shape(st.l.x, st.r.x, st.lift.x));
    }
    return copy(phys.current);
  }, [paint, shape]);

  const place = useCallback((l, r) => {
    halt();
    phys.current = { l: at(l), r: at(r), lift: at(0) };
    paint(shape(l, r, 0));
  }, [halt, paint, shape]);

  // Simulate the springs from where the lens is to [tl, tr] and hand the
  // whole trajectory to the compositor.
  const fly = useCallback((tl, tr) => {
    const st = halt();
    const goingRight = tl > st.l.x;
    const cl = goingRight ? TRAIL : LEAD;
    const cr = goingRight ? LEAD : TRAIL;
    const dt = 1 / FPS / SUBSTEPS;
    const frames = [];
    for (let i = 0; i < FPS * 2; i++) {
      frames.push(copy(st));
      if (still(st.l, tl, 0.1) && still(st.r, tr, 0.1) && still(st.lift, 0, 0.002)) break;
      for (let j = 0; j < SUBSTEPS; j++) {
        spring(st.l, tl, cl, dt);
        spring(st.r, tr, cr, dt);
        spring(st.lift, 0, LIFT, dt);
      }
    }
    const end = { l: at(tl), r: at(tr), lift: at(0) };
    frames.push(end);
    phys.current = copy(end);
    const kf = frames.map((f) => shape(f.l.x, f.r.x, f.lift.x));
    paint(kf[kf.length - 1]); // what remains once the animation is gone
    if (typeof lensRef.current.animate !== 'function' || frames.length < 3) return;
    const opts = { duration: ((frames.length - 1) * 1000) / FPS, easing: 'linear' };
    flight.current = {
      tl, tr, frames,
      anims: [
        lensRef.current.animate(kf.map((f) => ({ transform: f.lens })), opts),
        ...midRef.current.map((el) => el.animate(kf.map((f) => ({ transform: f.mid })), opts)),
        ...capRef.current.map((el) => el.animate(kf.map((f) => ({ transform: f.cap })), opts)),
      ],
    };
  }, [halt, paint, shape]);

  const moveTo = useCallback((i, { instant = false } = {}) => {
    const r = rectOf(i);
    if (!r || !geo.current) return;
    if (instant || reduced) { place(r.l, r.r); return; }
    const fl = flight.current;
    if (fl && fl.tl === r.l && fl.tr === r.r && fl.anims[0].playState !== 'finished') return; // already going there
    if (!fl && phys.current.l.x === r.l && phys.current.r.x === r.r && phys.current.lift.x === 0) return;
    fly(r.l, r.r);
  }, [rectOf, reduced, place, fly]);

  // A resting lens is one tab wide; its ends are half-circles of the
  // lens's height (or narrower, on a screen too small for that).
  const measure = useCallback(() => {
    const tab = rectOf(0);
    const lens = lensRef.current;
    if (!tab || !lens) return false;
    const h = lens.offsetHeight || 52;
    const rad = Math.max(1, Math.min(h / 2, (tab.w - 2) / 2));
    geo.current = { w: tab.w, rad };
    lens.style.width = `${tab.w}px`;
    lens.style.setProperty('--rad', `${rad}px`);
    return true;
  }, [rectOf]);

  // The route moved: so does the lens. Arriving from nowhere -- first
  // paint, or back from a page that is not a tab (Profile, Settings) --
  // it appears in place: flying in from wherever it was last parked
  // would be motion for nothing.
  useLayoutEffect(() => {
    if (!geo.current) measure();
    if (active >= 0 && !drag.current) moveTo(active, { instant: prevActive.current < 0 });
    prevActive.current = active;
  }, [active, measure, moveTo]);

  // The bar changed size (rotation, a resized window): re-measure and
  // re-seat the lens without travel. Subscribed once -- an observer's
  // first callback fires on subscribing, and re-subscribing per route
  // would re-seat the lens mid-slide.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return undefined;
    let width = track.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      const now = track.getBoundingClientRect().width;
      if (Math.abs(now - width) < 0.5) return;
      width = now;
      if (!measure() || drag.current) return;
      if (activeRef.current >= 0) moveTo(activeRef.current, { instant: true });
    });
    ro.observe(track);
    return () => ro.disconnect();
  }, [measure, moveTo]);

  useEffect(() => () => {
    if (drag.current) cancelAnimationFrame(drag.current.raf);
    flight.current?.anims.forEach((a) => a.cancel());
  }, []);

  const nearest = (clientX) => {
    let best = 0;
    let bestD = Infinity;
    tabRefs.current.forEach((t, i) => {
      if (!t) return;
      const r = t.getBoundingClientRect();
      const d = Math.abs(clientX - (r.left + r.width / 2));
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  // Where the finger wants the lens: centred under it, kept on the bar.
  const fingerTarget = (clientX) => {
    const first = rectOf(0);
    const last = rectOf(items.length - 1);
    const track = trackRef.current;
    const origin = track.getBoundingClientRect().left + track.clientLeft;
    const w = geo.current.w;
    return clamp(clientX - origin - w / 2, first.l, last.r - w);
  };

  const chase = () => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const elapsed = Math.min(0.05, (now - d.last) / 1000);
    d.last = now;
    const st = phys.current;
    const tl = d.target;
    const tr = d.target + geo.current.w;
    if (reduced) {
      phys.current = { l: at(tl), r: at(tr), lift: at(0) };
    } else {
      const goingRight = tl > st.l.x;
      const n = Math.max(1, Math.round(elapsed * FPS * SUBSTEPS));
      for (let j = 0; j < n; j++) {
        spring(st.l, tl, goingRight ? DRAG_TRAIL : DRAG_LEAD, elapsed / n);
        spring(st.r, tr, goingRight ? DRAG_LEAD : DRAG_TRAIL, elapsed / n);
        spring(st.lift, 1, LIFT, elapsed / n);
      }
    }
    const p = phys.current;
    paint(shape(p.l.x, p.r.x, p.lift.x));
    d.raf = requestAnimationFrame(chase);
  };

  const beginDrag = (e) => {
    try { trackRef.current.setPointerCapture(e.pointerId); } catch { /* already released */ }
    if (!geo.current && !measure()) return false;
    phys.current = halt();
    drag.current = { target: fingerTarget(e.clientX), last: performance.now(), raf: 0, under: nearest(e.clientX) };
    drag.current.raf = requestAnimationFrame(chase);
    setLifted(true);
    setUnder(drag.current.under);
    try { navigator.vibrate?.(8); } catch { /* not supported */ }
    return true;
  };

  const endDrag = (clientX, cancelled) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g?.dragging) return;
    const d = drag.current;
    drag.current = null;
    if (d) cancelAnimationFrame(d.raf);
    swallowClick.current = !cancelled;
    setLifted(false);
    setUnder(null);
    const target = cancelled ? active : nearest(clientX);
    if (target < 0) {
      // Dragged on a page that is no tab, and let go of nothing: the
      // lens just lands back in the bar and fades.
      const p = phys.current;
      fly(p.l.x, p.r.x);
      return;
    }
    moveTo(target);
    if (target !== active) { setPending(target); navigate(items[target].to); }
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    swallowClick.current = false;
    gesture.current = { id: e.pointerId, x0: e.clientX, dragging: false };
  };
  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.dragging) {
      if (Math.abs(e.clientX - g.x0) < DRAG_SLOP) return;
      if (!beginDrag(e)) return;
      g.dragging = true;
    }
    const d = drag.current;
    d.target = fingerTarget(e.clientX);
    const u = nearest(e.clientX);
    if (u !== d.under) {
      d.under = u;
      setUnder(u);
      try { navigator.vibrate?.(4); } catch { /* not supported */ }
    }
  };
  const onPointerUp = (e) => { if (gesture.current?.id === e.pointerId) endDrag(e.clientX, false); };
  const onPointerCancel = (e) => { if (gesture.current?.id === e.pointerId) endDrag(e.clientX, true); };
  const onClickCapture = (e) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <nav className={`gtb${lifted ? ' is-lifted' : ''}`} aria-label={ariaLabel}>
      <div
        ref={trackRef}
        className="gtb__track"
        data-tour={tourId}
        style={{ '--n': items.length }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClickCapture={onClickCapture}
      >
        <span ref={lensRef} className={`gtb__lens${active < 0 && !lifted ? ' is-hidden' : ''}`} aria-hidden="true">
          {['fill', 'rim'].map((layer, j) => (
            <span key={layer} className={`gtb__lens-${layer}`}>
              <i className="gtb__lens-l" />
              <i ref={(el) => { midRef.current[j] = el; }} className="gtb__lens-m" />
              <i ref={(el) => { capRef.current[j] = el; }} className="gtb__lens-r" />
            </span>
          ))}
        </span>
        {items.map((it, i) => (
          <NavLink
            key={it.to}
            ref={(el) => { tabRefs.current[i] = el; }}
            to={it.to}
            end={it.end}
            draggable={false}
            onClick={(e) => {
              // Start the slide on the tap itself, not a frame or two
              // later when the route has resolved. A modified click opens
              // a new tab and leaves this one where it is.
              if (!e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                moveTo(i);
                if (i !== active) setPending(i);
              }
            }}
            className={`gtb__tab${shown === i ? ' is-active' : ''}${under === i ? ' is-under' : ''}`}
          >
            <span className="gtb__icon"><Icon name={it.icon} size={22} strokeWidth={shown === i ? 2.3 : 1.8} /></span>
            <span className="gtb__label">{it.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
