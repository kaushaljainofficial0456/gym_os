/**
 * The opening: the Barbell logo reveal, once each time the app is opened.
 *
 * A 4-second muted clip over everything, while the app loads underneath --
 * so by the time the logo settles, the screen behind it is ready. It fades
 * out on its own, and any tap skips it.
 *
 * It must never cost anyone the app:
 *   - once per launch (sessionStorage), not on every navigation or reload
 *     within the same open tab;
 *   - not shown at all to people who asked for reduced motion, or to
 *     automated browsers (the e2e and visual tests);
 *   - abandoned if the video has not started within START_TIMEOUT_MS (slow
 *     network, blocked autoplay) and capped at MAX_MS whatever happens.
 *
 * The clip is landscape (1280x720). It is shown whole -- never cropped,
 * which would cut "BARBELL" on a phone -- and its top and bottom edges are
 * masked into the black so the frame does not read as a box.
 */
import { useEffect, useRef, useState } from 'react';

const SEEN_KEY = 'barbell-intro-seen';
const SRC = '/assets/intro/intro.mp4';
const START_TIMEOUT_MS = 2500;
const MAX_MS = 7000;
const FADE_MS = 450;
const FADE_Y = 'linear-gradient(to bottom, transparent, #000 22%, #000 78%, transparent)';
const FADE_X = 'linear-gradient(to right, transparent, #000 7%, #000 93%, transparent)';

// Decided once per page load. React may run a state initialiser twice (dev
// StrictMode); the second run would see the "seen" flag the first one set
// and wrongly skip the intro.
let decision = null;
function shouldPlay() {
  if (decision === null) decision = decide();
  return decision;
}

function decide() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.navigator.webdriver) return false;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    if (window.sessionStorage.getItem(SEEN_KEY)) return false;
    window.sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Storage blocked (private mode): play it, just once for this page.
  }
  return true;
}

export default function IntroSplash() {
  const [phase, setPhase] = useState(() => (shouldPlay() ? 'playing' : 'gone'));
  const videoRef = useRef(null);

  const finish = () => setPhase((p) => (p === 'playing' ? 'leaving' : p));

  useEffect(() => {
    if (phase === 'leaving') {
      const h = setTimeout(() => setPhase('gone'), FADE_MS);
      return () => clearTimeout(h);
    }
    if (phase !== 'playing') return undefined;
    const v = videoRef.current;
    let started = false;
    const onPlaying = () => { started = true; };
    v?.addEventListener('playing', onPlaying);
    v?.play?.().catch(() => finish());
    const noStart = setTimeout(() => { if (!started) finish(); }, START_TIMEOUT_MS);
    const cap = setTimeout(finish, MAX_MS);
    return () => { v?.removeEventListener('playing', onPlaying); clearTimeout(noStart); clearTimeout(cap); };
  }, [phase]);

  if (phase === 'gone') return null;

  return (
    <div
      role="presentation"
      onClick={finish}
      className="fixed inset-0 z-[200] grid place-items-center cursor-pointer"
      style={{
        background: '#000',
        opacity: phase === 'leaving' ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
      }}
    >
      <video
        ref={videoRef}
        src={SRC}
        muted
        autoPlay
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden="true"
        onEnded={finish}
        onError={finish}
        className="pointer-events-none select-none"
        style={{
          // The clip's own 16:9 box, as large as the screen allows, so the
          // fade below lands on the FRAME's edges and not the screen's.
          width: 'min(100vw, 177.78vh)',
          aspectRatio: '16 / 9',
          objectFit: 'cover',
          // Each edge of the frame fades into the black on its own; the
          // middle, where the letters are, stays untouched.
          WebkitMaskImage: `${FADE_Y}, ${FADE_X}`,
          WebkitMaskComposite: 'source-in',
          maskImage: `${FADE_Y}, ${FADE_X}`,
          maskComposite: 'intersect',
        }}
      />
      <span className="sr-only">Barbell</span>
    </div>
  );
}
