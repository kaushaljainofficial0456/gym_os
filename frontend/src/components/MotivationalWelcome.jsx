import { useEffect, useState } from 'react';
import { getNextQuote } from '../data/quoteRotation.js';
import { useTheme } from '../themeContext.jsx';
import { brand } from '../design/tokens.js';

export default function MotivationalWelcome({ onComplete }) {
  const [quote] = useState(() => getNextQuote());
  const [phase, setPhase] = useState('enter');
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  useEffect(() => {
    const holdTimer = setTimeout(() => setPhase('hold'), 100);
    const exitTimer = setTimeout(() => setPhase('exit'), 2800);
    const doneTimer = setTimeout(() => onComplete?.(), 3600);
    return () => { clearTimeout(holdTimer); clearTimeout(exitTimer); clearTimeout(doneTimer); };
  }, [onComplete]);

  const baseTransition = 'transition-all duration-700 ease-out';
  const opacity = phase === 'enter' ? 'opacity-0' : phase === 'hold' ? 'opacity-100' : 'opacity-0';
  const transform = phase === 'enter' ? 'translate-y-3 scale-[0.98]' : phase === 'hold' ? 'translate-y-0 scale-100' : '-translate-y-2 scale-[0.99]';

  const bgColor = isDark ? brand.dark.bg : brand.light.bg;
  const textColor = isDark ? 'rgba(240,244,243,.88)' : 'rgba(61,48,38,.88)';
  const accentGlow = isDark ? 'rgb(var(--accent-rgb) / .30)' : 'rgba(140,106,77,.12)';
  const accentGlow2 = isDark ? 'rgb(var(--accent-deep-rgb) / .35)' : 'rgba(177,134,99,.08)';

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden"
         style={{ background: bgColor }}>
      {/* ambient glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full opacity-20"
             style={{ background: `radial-gradient(circle, ${accentGlow}, transparent 70%)` }} />
        <div className="absolute bottom-1/4 left-1/3 w-[300px] h-[300px] rounded-full opacity-10"
             style={{ background: `radial-gradient(circle, ${accentGlow2}, transparent 70%)` }} />
      </div>

      {/* content */}
      <div className={`relative z-10 flex flex-col items-center px-8 max-w-md ${baseTransition} ${opacity} ${transform}`}>
        {/* logo */}
        <div className="mb-8 flex items-center gap-3 opacity-70">
          <img src="/logo.png" alt="SK OS" className="w-10 h-10 rounded-xl" />
          <span className="font-brand text-sm tracking-wide" style={{ color: textColor }}>SK OS</span>
        </div>

        {/* quote */}
        <blockquote className="text-center">
          <p className="font-display text-lg sm:text-xl leading-relaxed tracking-tight"
             style={{ color: textColor }}>
            &ldquo;{quote}&rdquo;
          </p>
        </blockquote>

        {/* subtle divider */}
        <div className="mt-8 w-12 h-[1.5px] rounded-full"
             style={{ background: `linear-gradient(90deg, transparent, ${isDark ? 'rgb(var(--accent-rgb) / .45)' : 'rgba(140,106,77,.25)'}, transparent)` }} />
      </div>
    </div>
  );
}
