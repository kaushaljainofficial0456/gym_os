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
 * The clip is portrait (1080x1920) on pure black, first frame black and
 * last frame the still wordmark. It is shown whole, centred on the same
 * black: on a phone it fills the screen, on a wide screen it sits in the
 * middle, and either way its own black merges with the backdrop -- there is
 * no frame edge to see.
 */
import { useEffect, useRef, useState } from 'react';

const SEEN_KEY = 'barbell-intro-seen';
const SRC = '/assets/intro/barbell-intro.mp4';
const START_TIMEOUT_MS = 2500;
const MAX_MS = 7000;
const FADE_MS = 450;

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
        className="pointer-events-none select-none absolute inset-0 w-full h-full object-contain"
      />
      <span className="sr-only">Barbell</span>
    </div>
  );
}
