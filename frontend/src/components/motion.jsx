import { useEffect, useRef, useState } from 'react';
import { cls } from '../utils.js';

// Fade + translate-up reveal on mount. Optional delay for staggering.
// Respects prefers-reduced-motion via CSS (animations are ~0 there).
export function Reveal({ children, delay = 0, as: Tag = 'div', className, style, once = true }) {
  const [shown, setShown] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) { setShown(true); return; }
    if (typeof IntersectionObserver === 'undefined') { setShown(true); return; }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setShown(true);
        if (once) obs.disconnect();
      } else if (!once) {
        setShown(false);
      }
    }, { threshold: 0.08 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [once]);

  return (
    <Tag ref={ref} className={cls(shown ? 'anim-fadeUp' : 'opacity-0', className)}
      style={{ animationDelay: `${delay}ms`, ...style }}>
      {children}
    </Tag>
  );
}

// Simple stagger container: children each animate in with increasing delay.
export function Stagger({ children, step = 70, className, as: Tag = 'div' }) {
  const kids = Array.isArray(children) ? children : [children];
  return (
    <Tag className={className}>
      {kids.map((kid, i) => (
        <Reveal key={kid?.key ?? i} delay={i * step}>{kid}</Reveal>
      ))}
    </Tag>
  );
}
