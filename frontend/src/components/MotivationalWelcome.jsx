/**
 * ARRIVAL — the moment between signing in and the home screen.
 *
 * The brand's black, the badge drawing itself in, the person's name in the
 * serif, and one line from the quote rotation. About three seconds, and a
 * tap anywhere skips it -- a ceremony nobody can hurry is a delay.
 *
 * Portalled to <body>: it is opened from inside the sign-in panel, whose
 * entrance animation transforms it, and a transformed ancestor turns
 * position:fixed into "fixed to that box".
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getNextQuote } from '../data/quoteRotation.js';
import BrandMark from './brand/BrandMark.jsx';
import './auth/auth.css';

const HOLD_MS = 2600;
const FADE_MS = 520;

export default function MotivationalWelcome({ name, onComplete }) {
  const [quote] = useState(() => getNextQuote());
  const [leaving, setLeaving] = useState(false);
  const done = useRef(onComplete);
  done.current = onComplete;
  const first = String(name || '').trim().split(/\s+/)[0];

  useEffect(() => {
    const out = setTimeout(() => setLeaving(true), HOLD_MS);
    return () => clearTimeout(out);
  }, []);
  useEffect(() => {
    if (!leaving) return undefined;
    const t = setTimeout(() => done.current?.(), FADE_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  return createPortal(
    <div className={`arrival${leaving ? ' is-leaving' : ''}`} role="status" aria-live="polite" onClick={() => setLeaving(true)}>
      <div className="auth-aurora" />
      <div className="arrival__inner">
        <BrandMark animate className="arrival__mark" />
        <h2 className="arrival__hello">
          <span className="auth-word"><span style={{ animationDelay: '700ms' }}>{first ? `Welcome, ${first}.` : 'Welcome.'}</span></span>
        </h2>
        <p className="arrival__quote">&ldquo;{quote}&rdquo;</p>
      </div>
    </div>,
    document.body,
  );
}
