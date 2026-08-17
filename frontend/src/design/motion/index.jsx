/**
 * SK OS MOTION SYSTEM — framer-motion primitives.
 *
 * WHY THIS EXISTS
 * The app already animates, via CSS keyframes in theme.css plus an
 * IntersectionObserver `Reveal` in components/motion.jsx. That covers
 * entrances well and is genuinely lightweight. What it cannot do is
 * INTERRUPTIBLE motion: a CSS animation that is halfway through and gets
 * re-triggered restarts or fights itself, and anything gesture-driven
 * (drag, tilt, press) has no clock to animate against. That is the gap
 * this fills -- not "CSS animation is bad".
 *
 * THE COMPATIBILITY RULE
 * `Reveal` and `Stagger` are re-exported here with the SAME API as
 * components/motion.jsx, because pages across the app already import them.
 * New code can import from `@/design/motion`; old code keeps working
 * untouched. No page had to be edited to land this.
 *
 * REDUCED MOTION IS ENFORCED, NOT SUGGESTED
 * theme.css already zeroes CSS animation durations under
 * `prefers-reduced-motion`. That rule cannot reach framer-motion, which
 * animates via inline style/JS. So every primitive here checks the
 * preference itself and renders the FINAL state directly. Vestibular
 * disorders are a real accessibility need, and a design system that only
 * honours the preference in one of its two animation engines is worse
 * than one that honours it in neither -- it looks fixed while still
 * shipping the problem.
 */
import { forwardRef, useEffect } from 'react';
import {
  motion,
  AnimatePresence,
  useReducedMotion,
  useMotionValue,
  useSpring,
  useTransform,
} from 'framer-motion';
import { easing, duration, spring } from '../tokens.js';
import { cn } from '../cn.js';

export { motion, AnimatePresence, useReducedMotion };

/* ------------------------------------------------------------------ */
/*  Variants                                                           */
/* ------------------------------------------------------------------ */

/** Shared entrance. `y` is small on purpose: an 8px rise reads as
 *  "settling into place"; a 40px one reads as "flying in" and gets tiring
 *  when every card on a dashboard does it. Matches the existing CSS
 *  `fadeUp` keyframe so both engines produce the same feel. */
export const fadeUp = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: duration.base, ease: easing.standard },
  },
};

export const fadeIn = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.fast, ease: easing.standard } },
};

export const scaleIn = {
  hidden: { opacity: 0, scale: 0.97 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: duration.fast, ease: easing.standard },
  },
};

/** Container that staggers its children. Uses framer's built-in
 *  orchestration rather than per-child delay math, so adding or removing
 *  a child cannot desynchronise the sequence. */
export const staggerContainer = (step = 0.06) => ({
  hidden: {},
  visible: { transition: { staggerChildren: step } },
});

/* ------------------------------------------------------------------ */
/*  Entrance primitives                                                */
/* ------------------------------------------------------------------ */

/**
 * Reveal on scroll-into-view.
 * API-compatible with components/motion.jsx's `Reveal` (children, delay in
 * MS, as, className, style, once) so it is a drop-in.
 */
export function Reveal({
  children,
  delay = 0,
  as = 'div',
  className,
  style,
  once = true,
  y = 8,
  ...rest
}) {
  const reduced = useReducedMotion();
  const Tag = motion[as] || motion.div;

  // Reduced motion: render the destination state, no transition at all.
  if (reduced) {
    return <Tag className={className} style={style} {...rest}>{children}</Tag>;
  }

  return (
    <Tag
      className={className}
      style={style}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, amount: 0.08 }}   // 0.08 matches the old observer threshold
      transition={{
        duration: duration.base,
        ease: easing.standard,
        delay: delay / 1000,              // callers pass ms, framer wants s
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/**
 * Stagger container. `step` is in MS to match the old component's default
 * of 70ms.
 */
export function Stagger({ children, step = 70, className, as = 'div', ...rest }) {
  const reduced = useReducedMotion();
  const Tag = motion[as] || motion.div;
  const kids = Array.isArray(children) ? children : [children];

  if (reduced) {
    return <Tag className={className} {...rest}>{children}</Tag>;
  }

  return (
    <Tag
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.08 }}
      variants={staggerContainer(step / 1000)}
      {...rest}
    >
      {kids.map((kid, i) => (
        <motion.div key={kid?.key ?? i} variants={fadeUp}>
          {kid}
        </motion.div>
      ))}
    </Tag>
  );
}

/**
 * Route-level transition wrapper. Deliberately subtle and FAST
 * (`duration.fast`): a page transition is latency the user did not ask
 * for, so it should confirm the navigation happened and get out of the
 * way. Long, showy page transitions are the most common way an app that
 * demos well becomes tiring to actually use.
 */
export function PageTransition({ children, className }) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: duration.fast, ease: easing.standard }}
    >
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Gesture primitives — the part CSS could not do                     */
/* ------------------------------------------------------------------ */

/**
 * Pointer-tracking 3D tilt. This is the "3D feel" that belongs on
 * ordinary cards -- it costs a CSS transform, not a WebGL context, so it
 * can be used freely where a real <Stage> cannot.
 *
 * DISABLED ON TOUCH, deliberately: without a hovering cursor there is no
 * tilt to track, and wiring it to touch-move means the card tilts while
 * the user is trying to scroll the page. `(hover: hover)` is the correct
 * query -- narrow width does not imply touch, and touch does not imply
 * narrow.
 */
export function Tilt({
  children,
  className,
  max = 8,           // degrees; beyond ~10 it stops reading as depth and starts reading as broken
  scale = 1.01,
  ...rest
}) {
  const reduced = useReducedMotion();
  const canHover =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(hover: hover)').matches;

  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);

  // Spring the ROTATION, not the pointer position, so the card eases to
  // rest when the cursor leaves instead of snapping flat.
  const rx = useSpring(useTransform(py, [0, 1], [max, -max]), spring.snappy);
  const ry = useSpring(useTransform(px, [0, 1], [-max, max]), spring.snappy);

  if (reduced || !canHover) {
    return <div className={className} {...rest}>{children}</div>;
  }

  return (
    <motion.div
      className={cn('will-change-transform', className)}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
      whileHover={{ scale }}
      transition={spring.snappy}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        px.set((e.clientX - r.left) / r.width);
        py.set((e.clientY - r.top) / r.height);
      }}
      onPointerLeave={() => { px.set(0.5); py.set(0.5); }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * Press feedback. Scale-down-on-press is the single highest
 * value-per-byte interaction in a mobile app: it makes a tap feel
 * acknowledged before any network response arrives.
 *
 * Renders a real <button> by default so it stays keyboard- and
 * screen-reader-accessible -- a motion.div with an onClick is not a
 * button, however much it looks like one.
 */
export const Pressable = forwardRef(function Pressable(
  { children, className, as = 'button', disabled, ...rest },
  ref
) {
  const reduced = useReducedMotion();
  const Tag = motion[as] || motion.button;
  return (
    <Tag
      ref={ref}
      className={className}
      disabled={disabled}
      whileTap={reduced || disabled ? undefined : { scale: 0.97 }}
      whileHover={reduced || disabled ? undefined : { scale: 1.02 }}
      transition={spring.snappy}
      {...rest}
    >
      {children}
    </Tag>
  );
});

/**
 * Animated number. Springs to the target rather than re-running a
 * fixed-duration count-up, so a value that changes mid-animation
 * retargets smoothly instead of restarting.
 *
 * Uses `spring.precise` (near-critically damped) on purpose: overshoot on
 * a NUMBER reads as the value itself wobbling, which is unacceptable when
 * the number is someone's calorie total or lift weight.
 */
export function AnimatedNumber({ value, decimals = 0, className }) {
  const reduced = useReducedMotion();
  const mv = useSpring(0, spring.precise);
  const text = useTransform(mv, (v) =>
    Number(v).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );

  // Retarget the spring whenever the value changes. In an effect, not
  // during render -- mutating a motion value while rendering is a side
  // effect React is allowed to discard or replay under StrictMode.
  useEffect(() => {
    mv.set(value);
  }, [mv, value]);

  if (reduced) {
    return (
      <span className={className}>
        {Number(value).toLocaleString('en-US', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })}
      </span>
    );
  }
  return <motion.span className={className}>{text}</motion.span>;
}
