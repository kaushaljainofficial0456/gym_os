/**
 * AUTH SHELL — every screen between opening the app and reaching a home
 * dashboard sits in this frame.
 *
 * THE STAGE continues the intro: the same black, the same ring-and-barbell
 * badge drawing in on the same beats, the same Cinzel wordmark. Where the
 * device can afford it the badge becomes a real-time 3D object (MarkStage);
 * the flat mark underneath is what everyone else sees, and what everyone
 * sees for the moment before the 3D arrives.
 *
 * THE PANEL is the app: the theme's own ground, one question at a time.
 * On a phone it is a sheet pulled up over the stage; the stage is tall on
 * the welcome screen and folds to a compact header the moment there is a
 * form to fill in. On a desktop the stage takes the left half and carries
 * one short line of copy, and the panel holds the right.
 *
 * Used two ways: as the persistent layout of the signed-out routes
 * (AuthLayout, so the stage -- and its WebGL context -- survives moving
 * from Welcome to Sign in to Set up), and directly by the signed-in steps
 * that come before a dashboard (terms, joining a gym).
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../../themeContext.jsx';
import BrandMark from '../brand/BrandMark.jsx';
import Wordmark from '../brand/Wordmark.jsx';
import MarkStage from './MarkStage.jsx';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.js';
import './auth.css';

// Decorative and late to arrive anyway (its cards fly in after a second),
// so it stays out of the first download -- and if its file ever fails to
// load, the stage simply goes without it.
const Showcase = lazy(() => import('./Showcase.jsx').catch(() => ({ default: () => null })));

const LEGAL = [
  ['About', '/about'], ['Contact', '/contact'], ['Terms', '/terms'],
  ['Privacy', '/privacy'], ['Refunds', '/refund-policy'], ['Shipping', '/shipping-policy'],
];

/** The desktop line, written in word by word. Keyed by its text so a new
 *  screen's line writes itself in again. */
function Headline({ lines }) {
  let n = 0;
  return (
    <p className="auth-headline" key={lines.map((l) => l.text).join('|')}>
      {lines.map((l) => (
        <span key={l.text} className={`block${l.accent ? ' is-accent' : ''}`}>
          {l.text.split(' ').map((w, i, all) => {
            n += 1;
            return (
              <span key={i} className="auth-word">
                <span style={{ animationDelay: `${900 + n * 70}ms` }}>{w}{i < all.length - 1 ? ' ' : ''}</span>
              </span>
            );
          })}
        </span>
      ))}
    </p>
  );
}

/** Pointer, or a phone's tilt, as CSS variables on the stage: the
 *  showcase cards lean by their own depth. Throttled to one write a frame. */
function useParallax(ref, off) {
  useEffect(() => {
    const el = ref.current;
    if (!el || off) return undefined;
    let raf = 0;
    let x = 0;
    let y = 0;
    const write = () => { raf = 0; el.style.setProperty('--px', x.toFixed(3)); el.style.setProperty('--py', y.toFixed(3)); };
    const queue = () => { if (!raf) raf = requestAnimationFrame(write); };
    const onMove = (e) => { x = (e.clientX / window.innerWidth) * 2 - 1; y = (e.clientY / window.innerHeight) * 2 - 1; queue(); };
    let base = null;
    const onTilt = (e) => {
      if (e.gamma == null || e.beta == null) return;
      if (!base) base = { g: e.gamma, b: e.beta };
      x = Math.max(-1, Math.min(1, (e.gamma - base.g) / 20));
      y = Math.max(-1, Math.min(1, (e.beta - base.b) / 20));
      queue();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('deviceorientation', onTilt, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('deviceorientation', onTilt);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, off]);
}

export default function AuthShell({ variant = 'compact', headline, showcase = 'welcome', children, legal = true }) {
  const { resolved } = useTheme();
  const reduced = usePrefersReducedMotion();
  const slotRef = useRef(null);
  const stageRef = useRef(null);
  useParallax(stageRef, reduced);
  // One clock for the flat mark's CSS draw-in and the 3D one: if the 3D
  // arrives mid-draw it picks up at the same moment instead of restarting.
  const [startAt] = useState(() => (typeof performance !== 'undefined' ? performance.now() : 0));
  const [live, setLive] = useState(false);
  const onReady = useCallback(() => setLive(true), []);

  return (
    <div className="auth-root" data-variant={variant}>
      <section className="auth-stage" ref={stageRef}>
        <div className="auth-aurora" />
        <MarkStage slotRef={slotRef} startAt={startAt} accent={resolved === 'light' ? '#F0D2C8' : '#CBD6E0'} onReady={onReady} />
        <div className="auth-brand">
          <div ref={slotRef} className="auth-mark-slot">
            <BrandMark animate className={`auth-mark-svg${live ? ' is-hidden' : ''}`} />
          </div>
          <Wordmark animate delay={900} className="auth-wordmark" />
        </div>
        {showcase && <Suspense fallback={null}><Showcase set={showcase} /></Suspense>}
        {headline && <Headline lines={headline} />}
        <div className="auth-stage__grain" />
      </section>

      <main className="auth-panel">
        <div className="auth-panel__inner">{children}</div>
        {legal && (
          <nav className="auth-legal" aria-label="Legal and company">
            {LEGAL.map(([label, to]) => <Link key={to} to={to}>{label}</Link>)}
          </nav>
        )}
      </main>
    </div>
  );
}
