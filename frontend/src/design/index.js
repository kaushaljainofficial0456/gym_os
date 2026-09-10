/**
 * SK OS design system — public entry point.
 *
 *   import { cn, Reveal, Tilt, AmbientBackdrop, easing } from '@/design';
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ THIS BARREL MUST STAY FREE OF three.js / @react-three/fiber.      │
 * └──────────────────────────────────────────────────────────────────┘
 * Almost every screen imports from here, so anything reachable from this
 * file lands in the entry chunk that every user downloads on first paint.
 *
 * `Stage` is therefore NOT exported: it imports `Canvas` from
 * @react-three/fiber, and re-exporting it once already cost a measured
 * **224 kB -> 509 kB gzipped** regression in the entry bundle, with
 * three.js hoisted out of its lazy chunk. Import it directly from
 * `design/three/Stage.jsx` if you are building a new 3D surface and
 * accept that cost inside your own lazy boundary.
 *
 * `AmbientBackdrop` IS safe to export: it is the lazy boundary itself and
 * contains no 3D imports, only the decision of whether to load them.
 *
 * Docs: frontend/DESIGN_SYSTEM.md
 */

export { cn } from './cn.js';

export {
  brand,
  status,
  statusLight,
  easing,
  duration,
  spring,
  perf,
  radius,
  z,
  FRAME_BUDGET_MS,
} from './tokens.js';

export {
  motion,
  AnimatePresence,
  useReducedMotion,
  fadeUp,
  fadeIn,
  scaleIn,
  staggerContainer,
  Reveal,
  Stagger,
  PageTransition,
  Tilt,
  Pressable,
  AnimatedNumber,
} from './motion/index.jsx';

// Three-free: the lazy boundary, the capability check, and the tiering
// hooks. NOT Stage — see the header note.
export { default as AmbientBackdrop, useThemePalette, GradientFallback } from './three/AmbientBackdrop.jsx';
export { hasWebGL } from './three/webgl.js';
export { guessDeviceTier, useAdaptiveQuality, useIsActive } from './three/useDeviceTier.js';
