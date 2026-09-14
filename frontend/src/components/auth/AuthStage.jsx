/**
 * AUTH STAGE — the left half of every sign-in screen.
 *
 * THIS IS THE FIRST IMPRESSION, and the first impression of a product
 * that measures things should not be a stock gradient. It is also the
 * page with the least right to be slow: the 3D behind it is lazy, tier-
 * gated, skipped entirely without WebGL or with reduced motion, and the
 * words below paint before any of it loads. Nothing here blocks the form.
 *
 * THE HEADLINE WRITES ITSELF IN, word by word, behind a soft mask — not
 * a character-by-character typewriter. A real typewriter at a readable
 * speed takes two seconds to say three words, and by the fourth visit it
 * is something you wait through. A mask reveal reads as *composed*: fast
 * enough to feel instant, slow enough to feel deliberate, and finished
 * before anyone could have started reading. The caret is the one nod to
 * typing — it travels with the last word and then retires.
 *
 * REDUCED MOTION IS NOT A LESSER VERSION. Everything lands in its final
 * position immediately; no fade-from-nothing, no drift. The page is
 * identical, it simply does not perform.
 */
import { lazy, Suspense } from 'react';
import Logo from '../Logo.jsx';

/* LAZY, AND THAT IS NOT OPTIONAL.
 *
 * Login is EAGERLY bundled -- it is the first thing an unauthenticated
 * visitor needs, so App.jsx deliberately keeps it out of the lazy routes.
 * Anything this file imports statically therefore lands in the chunk
 * EVERY first-time visitor downloads before anything paints. Importing
 * AmbientBackdrop directly cost 8.8 kB gzip of entry weight (83.68 ->
 * 92.48) by dragging framer-motion and the device-tier code in with it,
 * measured, before this boundary was added.
 *
 * The stage's words, logo and vignette are plain CSS and paint on the
 * first frame. The backdrop arrives afterwards or never; either way it
 * is never between a visitor and the sign-in form. */
const AmbientBackdrop = lazy(() =>
  import('../../design/three/AmbientBackdrop.jsx'));

const EASE = [0.22, 0.8, 0.3, 1];

/** Words, each masked by its own overflow-hidden line box. Framer is
 *  already a dependency; this needs nothing new. */
function WrittenLine({ children, delay = 0, reduced, className, style, caret }) {
  const words = String(children).split(' ');
  return (
    <span className={className} style={style}>
      {words.map((w, i) => (
        <span key={`${w}-${i}`} className="inline-block overflow-hidden align-bottom">
          <span
            className="inline-block"
            style={reduced ? undefined : {
              animation: `authWordIn 620ms cubic-bezier(${EASE.join(',')}) both`,
              animationDelay: `${delay + i * 55}ms`,
            }}
          >
            {w}
            {i < words.length - 1 ? ' ' : ''}
          </span>
        </span>
      ))}
      {caret && !reduced && (
        <span
          aria-hidden="true"
          className="inline-block align-bottom"
          style={{
            width: '2px',
            height: '0.82em',
            marginLeft: '.12em',
            background: 'var(--accent)',
            animation: `authCaret 900ms steps(1,end) ${delay + words.length * 55 + 380}ms 3, authCaretOut 400ms ease ${delay + words.length * 55 + 3100}ms both`,
          }}
        />
      )}
    </span>
  );
}

export default function AuthStage({ reduced = false, eyebrow, lines = [], footer }) {
  return (
    <div
      className="hidden lg:flex flex-col justify-between p-12 relative overflow-hidden"
      style={{ borderRight: '1px solid var(--line)' }}
    >
      {/* Light, not geometry — three very soft blooms drifting behind
          everything. Rings were tried here first and read as busy: three
          shapes turning at three rates give the eye something to track,
          which is the one thing a sign-in background must not do. Lazy
          and tier-gated; it decides for itself whether to exist at all. */}
      <Suspense fallback={null}>
        <AmbientBackdrop scene="aura" intensity={0.9} maxTier="medium" />
      </Suspense>

      {/* A vignette so the headline never has to compete with a ring
          passing behind it. Pure CSS, paints instantly, and does the job
          whether or not the 3D ever arrives. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(120% 90% at 18% 78%, rgb(var(--bg-rgb) / .92) 0%, rgb(var(--bg-rgb) / .55) 42%, transparent 78%)',
        }}
      />

      <div className="flex items-center gap-4 relative">
        <Logo className="w-14 h-14 rounded-2xl shadow-glow" />
        <div>
          <div className="font-brand font-bold tracking-wide" style={{ color: 'var(--ink)' }}>Barbell</div>
          <div className="text-[10px] tracking-[.25em] uppercase font-grotesk" style={{ color: 'var(--mute)' }}>
            Your fitness business, engineered.
          </div>
        </div>
      </div>

      <div className="relative">
        {eyebrow && (
          <div
            className="text-[10px] font-grotesk uppercase tracking-[.28em] mb-5"
            style={{
              color: 'var(--faint)',
              ...(reduced ? {} : { animation: `authFadeUp 700ms cubic-bezier(${EASE.join(',')}) 80ms both` }),
            }}
          >
            {eyebrow}
          </div>
        )}

        <h1 className="font-display font-bold text-5xl leading-[1.08] tracking-tight" style={{ color: 'var(--ink)' }}>
          {lines.map((l, i) => (
            <span key={l.text} className="block">
              <WrittenLine
                reduced={reduced}
                delay={220 + i * 190}
                caret={i === lines.length - 1}
                style={l.accent ? { color: 'var(--accent)' } : undefined}
              >
                {l.text}
              </WrittenLine>
            </span>
          ))}
        </h1>

        {footer && (
          <div
            className="mt-8 flex items-center gap-2 text-[11px] font-grotesk uppercase tracking-[.2em]"
            style={{
              color: 'var(--faint)',
              ...(reduced ? {} : { animation: `authFadeUp 800ms cubic-bezier(${EASE.join(',')}) ${420 + lines.length * 190}ms both` }),
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
