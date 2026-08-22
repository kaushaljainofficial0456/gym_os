/**
 * SK OS DESIGN TOKENS — the single source of truth.
 *
 * WHY THIS FILE EXISTS
 * Before this, the same brand colour was written in four places: as hex in
 * `tailwind.config.js`, as a CSS var in `theme.css`, as a hardcoded
 * `linear-gradient(135deg, #0A8A85, #14C4BC)` inside `.btn-primary` /
 * `.tab.active` / `.navlink.active`, and AGAIN as a `!important` override
 * for light mode. Changing the brand colour meant finding all four. Worse,
 * two of the Tailwind token NAMES had drifted away from their values --
 * `ember` was `#0A8A85` (a teal, not an ember) and `gold` was `#14C4BC`
 * (a cyan, not a gold) -- so the names actively lied to whoever read them.
 *
 * The rule this file establishes: **a colour is defined once, as a CSS
 * variable, and everything else references it.** Light mode then works by
 * redefining variables, not by overriding 110 Tailwind classes with
 * `!important`.
 *
 * WHY CHANNELS, NOT HEX, FOR SOLID COLOURS
 * Tailwind needs raw `R G B` channels to support opacity modifiers like
 * `bg-accent/30`. `--accent: #14C4BC` cannot produce that; `--accent-rgb:
 * 20 196 188` can, via `rgb(var(--accent-rgb) / <alpha-value>)`. The
 * existing code uses those modifiers heavily (`gold/40` appears 29 times),
 * so this is a hard requirement, not a preference.
 *
 * IMPORTANT — NOT EVERY TOKEN IS CHANNEL-BASED, ON PURPOSE:
 * `--line`, `--mute` and `--faint` already bake in an alpha (`--line` is
 * `rgba(255,255,255,.07)`). They are consumed BOTH bare (`border-line`,
 * expecting the .07) and with modifiers (`border-line/40`, expecting .40).
 * A single channel-based token cannot serve both, because Tailwind
 * substitutes `<alpha-value>` with `1` when no modifier is present, which
 * would turn every hairline border into solid white. They are therefore
 * left as literal rgba() in the Tailwind config, where Tailwind's own rgba
 * parser handles the modifier correctly. This is a deliberate exception,
 * documented so nobody "fixes" it into a regression.
 *
 * These JS exports are for code that needs a colour at runtime -- notably
 * the 3D layer, where three.js needs a real number and cannot read a CSS
 * variable off an element. Everything else should use Tailwind classes.
 */

/* ------------------------------------------------------------------ */
/*  Brand                                                              */
/* ------------------------------------------------------------------ */

/**
 * Dark is the SK OS signature; light is the warm-luxury alternate.
 * Kept as explicit pairs so the 3D layer can pick the right one, since a
 * WebGL scene cannot inherit a CSS variable.
 */
export const brand = {
  dark: {
    accent: '#E07A63',        // terracotta
    accentDeep: '#C15C4C',    // gradient partner, deeper end
    accentContrast: '#2B120A',// dark ink ON the accent
    cyan: '#22D3EE',
    violet: '#7C3AED',
    bg: '#1C1210',            // warm near-black canvas
    panel: '#2A1D19',
    ink: '#F7ECE7',
  },
  light: {
    accent: '#C15C4C',        // terracotta for light mode
    accentDeep: '#9C4436',
    accentContrast: '#FFFFFF',
    cyan: '#0E7490',
    violet: '#6D28D9',
    bg: '#FFDFDD',            // blush
    panel: '#FFFFFF',
    ink: '#2B211C',
  },
};

/** Semantic status colours. Identical in both themes -- "danger" must not
 *  change hue with the theme, or users learn the colour twice. */
export const status = {
  good: '#7AA880',
  warn: '#C7955C',
  bad: '#C15C4C',
};

/* ------------------------------------------------------------------ */
/*  Motion                                                             */
/* ------------------------------------------------------------------ */

/**
 * One easing curve dominates this codebase already --
 * `cubic-bezier(.22,.8,.3,1)` appears in .card, .btn, Ring, Bar and the
 * keyframes. It is preserved as `standard` rather than replaced, so new
 * framer-motion components feel identical to the existing CSS ones. A
 * design system that introduces a SECOND "house curve" just makes the app
 * feel like two apps.
 */
export const easing = {
  standard: [0.22, 0.8, 0.3, 1],   // the existing house curve
  out: [0.16, 1, 0.3, 1],          // longer tail, for entrances
  inOut: [0.65, 0, 0.35, 1],       // symmetric, for reversible motion
};

/** Durations in SECONDS (framer-motion's unit), mirroring the CSS ms
 *  values already in theme.css so the two systems stay in step. */
export const duration = {
  instant: 0.12,
  fast: 0.22,     // .btn / .card transitions
  base: 0.3,      // fadeUp
  slow: 0.45,
  slower: 0.8,    // Ring / Bar fills
};

/** Springs for gesture-driven motion, where a duration is the wrong model
 *  -- a dragged/tilted element should respond to velocity, not a clock. */
export const spring = {
  /** Snappy UI response: buttons, toggles, tilt. */
  snappy: { type: 'spring', stiffness: 400, damping: 30, mass: 0.6 },
  /** Softer, for larger surfaces like sheets and modals. */
  soft: { type: 'spring', stiffness: 260, damping: 32, mass: 0.9 },
  /** Nearly critically damped -- almost no overshoot. For anything showing
   *  a NUMBER, where bounce reads as the value itself wobbling. */
  precise: { type: 'spring', stiffness: 300, damping: 40, mass: 0.8 },
};

/* ------------------------------------------------------------------ */
/*  3D performance budget                                              */
/* ------------------------------------------------------------------ */

/**
 * The honest constraint: this app's users are on Indian mid-range Android
 * phones, not developer MacBooks. The existing bundle already ships
 * three.js at 508 kB (129 kB gzipped) for a single backdrop. 3D that drops
 * the interface to 20 fps is not "premium", it is broken -- so every 3D
 * surface declares a tier and the renderer scales to the device rather
 * than hoping.
 *
 * `dpr` caps device pixel ratio: an unclamped DPR of 3 on a modern phone
 * renders NINE times the pixels of DPR 1, which is the single most common
 * cause of a beautiful scene running at 15 fps.
 */
export const perf = {
  high:   { dpr: [1, 2],   antialias: true,  shadows: true,  postprocessing: true  },
  medium: { dpr: [1, 1.5], antialias: true,  shadows: false, postprocessing: false },
  low:    { dpr: [1, 1],   antialias: false, shadows: false, postprocessing: false },
};

/** Frame budget in ms. Below this we downgrade a tier. 16.7ms = 60fps;
 *  we allow a little headroom before reacting so a single janky frame
 *  (a GC pause, a route change) does not permanently degrade quality. */
export const FRAME_BUDGET_MS = 22;

/* ------------------------------------------------------------------ */
/*  Elevation / radii                                                  */
/* ------------------------------------------------------------------ */

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,      // .card
  xl: 20,
  pill: 999,
};

/** z-index scale. Exists so nobody writes `z-index: 99999` again --
 *  every layer that can overlap is enumerated and ordered here. */
export const z = {
  base: 0,
  raised: 10,
  sticky: 20,
  drawer: 30,
  modal: 50,
  toast: 60,
  tooltip: 70,
};
