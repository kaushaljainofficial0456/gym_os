/**
 * ExerciseVisual — premium anatomical exercise visualization.
 *
 * Draws a stylized athletic figure with highlighted muscle regions,
 * smooth requestAnimationFrame-based animation, play/pause/speed controls,
 * and reduced-motion accessibility support.
 *
 * Zero new dependencies — pure React + SVG + requestAnimationFrame.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTheme } from '../themeContext.jsx';

/* ════════════════════════════════════════════════════════════════
   BODY SVG — anatomical silhouette (viewBox 0 0 200 380)
   ════════════════════════════════════════════════════════════════ */

const BODY_SILHOUETTE = `
  M100,18 C110,18 118,24 118,34 C118,44 110,50 100,50 C90,50 82,44 82,34 C82,24 90,18 100,18 Z
  M96,50 L94,60 L106,60 L104,50 Z
  M68,68 C66,64 60,62 52,64 L36,78 L32,108 L42,110 L52,86 L56,72 Z
  M132,68 C134,64 140,62 148,64 L164,78 L168,108 L158,110 L148,86 L144,72 Z
  M68,68 Q82,62 100,60 Q118,62 132,68 L126,116 Q112,124 100,126 Q88,124 74,116 Z
  M42,110 L36,160 L32,190 L44,192 L48,164 L52,112 Z
  M158,110 L164,160 L168,190 L156,192 L152,164 L148,112 Z
  M74,116 Q88,122 100,124 Q112,122 126,116 L124,200 Q112,208 100,210 Q88,208 76,200 Z
  M80,210 L76,280 L72,340 L68,360 L82,362 L86,344 L90,282 L92,212 Z
  M108,212 L110,282 L114,344 L118,362 L132,360 L128,340 L124,280 L120,210 Z
  M86,280 Q88,290 90,300 L84,342 L72,340 Z
  M114,280 Q112,290 110,300 L116,342 L128,340 Z
`;

/* ════════════════════════════════════════════════════════════════
   MUSCLE REGIONS — fillable path regions on the body
   ════════════════════════════════════════════════════════════════ */

const MUSCLE_PATHS = {
  chest:      'M76,76 Q100,68 124,76 L120,108 Q100,114 80,108 Z',
  shoulders_L:'M56,64 L42,74 L46,92 L56,86 L64,72 Z',
  shoulders_R:'M144,64 L158,74 L154,92 L144,86 L136,72 Z',
  biceps_L:   'M46,92 L40,128 L52,130 L56,94 Z',
  biceps_R:   'M154,92 L160,128 L148,130 L144,94 Z',
  triceps_L:  'M48,94 L42,130 L54,132 L58,96 Z',
  triceps_R:  'M152,94 L158,130 L146,132 L142,96 Z',
  forearms_L: 'M40,128 L34,178 L46,180 L52,130 Z',
  forearms_R: 'M160,128 L166,178 L154,180 L148,130 Z',
  core:       'M84,118 Q100,124 116,118 L118,190 Q100,196 82,190 Z',
  quads_L:    'M80,210 L76,272 L92,274 L94,214 Z',
  quads_R:    'M120,210 L124,272 L108,274 L106,214 Z',
  hamstrings_L:'M80,210 L76,278 L84,280 L92,216 Z',
  hamstrings_R:'M120,210 L124,278 L116,280 L108,216 Z',
  glutes:     'M80,190 Q100,200 120,190 L122,218 Q100,224 78,218 Z',
  lats_L:     'M78,80 L72,108 L80,112 L84,84 Z',
  lats_R:     'M122,80 L128,108 L120,112 L116,84 Z',
  traps:      'M86,56 Q100,50 114,56 L112,78 Q100,84 88,78 Z',
  calves_L:   'M78,280 L74,338 L90,340 L92,282 Z',
  calves_R:   'M122,280 L126,338 L110,340 L108,282 Z',
};

/* ════════════════════════════════════════════════════════════════
   EXERCISE POSE DEFINITIONS
   Each exercise has 2-4 keyframes: { t: 0-1, overrides: {...} }
   overrides shift muscle group paths (dx, dy) to create movement.
   ════════════════════════════════════════════════════════════════ */

const EXERCISE_POSES = {
  squat: {
    duration: 3.0,
    primary: ['quads', 'glutes'],
    secondary: ['hamstrings', 'core'],
    keyframes: [
      { t: 0,   bodyDy: 0,   quadStretch: 0,   kneeAngle: 0 },
      { t: 0.4, bodyDy: 22,  quadStretch: 8,   kneeAngle: 30 },
      { t: 0.5, bodyDy: 26,  quadStretch: 10,  kneeAngle: 35 },
      { t: 1.0, bodyDy: 0,   quadStretch: 0,   kneeAngle: 0 },
    ],
  },
  bench_press: {
    duration: 3.2,
    primary: ['chest', 'triceps'],
    secondary: ['shoulders'],
    keyframes: [
      { t: 0,   armAngle: 0,  barDy: 0 },
      { t: 0.4, armAngle: 25, barDy: 12 },
      { t: 0.5, armAngle: 30, barDy: 14 },
      { t: 1.0, armAngle: 0,  barDy: 0 },
    ],
  },
  shoulder_press: {
    duration: 2.8,
    primary: ['shoulders'],
    secondary: ['triceps', 'core'],
    keyframes: [
      { t: 0,   armDy: 0,  barDy: 0 },
      { t: 0.4, armDy: -20, barDy: -20 },
      { t: 0.5, armDy: -22, barDy: -22 },
      { t: 1.0, armDy: 0,  barDy: 0 },
    ],
  },
  deadlift: {
    duration: 3.4,
    primary: ['hamstrings', 'glutes', 'lower_back'],
    secondary: ['traps', 'forearms'],
    keyframes: [
      { t: 0,   bodyAngle: 40, barDy: 20 },
      { t: 0.45, bodyAngle: 5,  barDy: 0 },
      { t: 0.55, bodyAngle: 5,  barDy: 0 },
      { t: 1.0, bodyAngle: 40, barDy: 20 },
    ],
  },
  bicep_curl: {
    duration: 2.4,
    primary: ['biceps'],
    secondary: ['forearms'],
    keyframes: [
      { t: 0,   curlAngle: 0 },
      { t: 0.4, curlAngle: 110 },
      { t: 0.5, curlAngle: 115 },
      { t: 1.0, curlAngle: 0 },
    ],
  },
  lateral_raise: {
    duration: 3.0,
    primary: ['shoulders'],
    secondary: ['traps'],
    keyframes: [
      { t: 0,   raiseAngle: 0 },
      { t: 0.4, raiseAngle: 85 },
      { t: 0.5, raiseAngle: 90 },
      { t: 1.0, raiseAngle: 0 },
    ],
  },
  triceps_pushdown: {
    duration: 2.6,
    primary: ['triceps'],
    secondary: ['core'],
    keyframes: [
      { t: 0,   pushAngle: 0 },
      { t: 0.4, pushAngle: 40 },
      { t: 0.5, pushAngle: 42 },
      { t: 1.0, pushAngle: 0 },
    ],
  },
  lat_pulldown: {
    duration: 2.8,
    primary: ['lats'],
    secondary: ['biceps', 'core'],
    keyframes: [
      { t: 0,   pullDy: -14 },
      { t: 0.4, pullDy: 10 },
      { t: 0.5, pullDy: 12 },
      { t: 1.0, pullDy: -14 },
    ],
  },
  push_up: {
    duration: 2.8,
    primary: ['chest', 'triceps'],
    secondary: ['core', 'shoulders'],
    keyframes: [
      { t: 0,   bodyAngle: 0, armAngle: 0 },
      { t: 0.4, bodyAngle: 8, armAngle: 20 },
      { t: 0.5, bodyAngle: 10, armAngle: 24 },
      { t: 1.0, bodyAngle: 0, armAngle: 0 },
    ],
  },
  plank: {
    duration: 4.0,
    primary: ['core'],
    secondary: ['shoulders', 'glutes'],
    keyframes: [
      { t: 0,   breathe: 0 },
      { t: 0.25, breathe: 1.5 },
      { t: 0.5,  breathe: 0 },
      { t: 0.75, breathe: -1 },
      { t: 1.0,  breathe: 0 },
    ],
  },
  lunges: {
    duration: 3.0,
    primary: ['quads', 'glutes'],
    secondary: ['hamstrings', 'core'],
    keyframes: [
      { t: 0,   lungeDepth: 0 },
      { t: 0.4, lungeDepth: 18 },
      { t: 0.5, lungeDepth: 20 },
      { t: 1.0, lungeDepth: 0 },
    ],
  },
  hip_thrust: {
    duration: 2.6,
    primary: ['glutes'],
    secondary: ['hamstrings', 'core'],
    keyframes: [
      { t: 0,   hipDy: 6 },
      { t: 0.4, hipDy: -8 },
      { t: 0.5, hipDy: -10 },
      { t: 1.0, hipDy: 6 },
    ],
  },
  seated_row: {
    duration: 3.0,
    primary: ['lats', 'traps'],
    secondary: ['biceps', 'core'],
    keyframes: [
      { t: 0,   rowDy: 0 },
      { t: 0.4, rowDy: -12 },
      { t: 0.5, rowDy: -14 },
      { t: 1.0, rowDy: 0 },
    ],
  },
  leg_press: {
    duration: 3.0,
    primary: ['quads', 'glutes'],
    secondary: ['hamstrings'],
    keyframes: [
      { t: 0,   legDy: 0 },
      { t: 0.4, legDy: 16 },
      { t: 0.5, legDy: 18 },
      { t: 1.0, legDy: 0 },
    ],
  },
  incline_db_press: {
    duration: 3.2,
    primary: ['chest', 'shoulders'],
    secondary: ['triceps'],
    keyframes: [
      { t: 0,   armAngle: 0,  dbDy: 0 },
      { t: 0.4, armAngle: 22, dbDy: 10 },
      { t: 0.5, armAngle: 26, dbDy: 12 },
      { t: 1.0, armAngle: 0,  dbDy: 0 },
    ],
  },
  romanian_deadlift: {
    duration: 3.4,
    primary: ['hamstrings', 'glutes'],
    secondary: ['lower_back', 'core'],
    keyframes: [
      { t: 0,   bodyAngle: 35, barDy: 18 },
      { t: 0.45, bodyAngle: 2,  barDy: 0 },
      { t: 0.55, bodyAngle: 2,  barDy: 0 },
      { t: 1.0, bodyAngle: 35, barDy: 18 },
    ],
  },
  cable_crunch: {
    duration: 2.6,
    primary: ['core'],
    secondary: ['obliques'],
    keyframes: [
      { t: 0,   crunchAngle: 0 },
      { t: 0.4, crunchAngle: 20 },
      { t: 0.5, crunchAngle: 22 },
      { t: 1.0, crunchAngle: 0 },
    ],
  },
  dumbbell_row: {
    duration: 2.8,
    primary: ['lats'],
    secondary: ['biceps', 'core'],
    keyframes: [
      { t: 0,   rowAngle: 0 },
      { t: 0.4, rowAngle: -30 },
      { t: 0.5, rowAngle: -32 },
      { t: 1.0, rowAngle: 0 },
    ],
  },
};

// Alias map: animation_key → pose name
const KEY_ALIASES = {
  leg_press: 'leg_press',
  seated_row: 'seated_row',
  romanian_deadlift: 'romanian_deadlift',
  cable_crunch: 'cable_crunch',
  incline_db_press: 'incline_db_press',
  dumbbell_row: 'dumbbell_row',
  overhead_press: 'shoulder_press',
  db_bench_press: 'bench_press',
  cable_crossover: 'bench_press',
  face_pull: 'seated_row',
  calf_raise: 'lateral_raise',
  hamstring_curl: 'deadlift',
  leg_extension: 'squat',
  chest_fly: 'bench_press',
  cable_row: 'seated_row',
  pull_up: 'lat_pulldown',
  chin_up: 'lat_pulldown',
  dip: 'triceps_pushdown',
  skull_crusher: 'triceps_pushdown',
  overhead_extension: 'triceps_pushdown',
  preacher_curl: 'bicep_curl',
  hammer_curl: 'bicep_curl',
  concentration_curl: 'bicep_curl',
  shrug: 'lateral_raise',
  upright_row: 'lateral_raise',
  reverse_fly: 'lateral_raise',
};

/* ════════════════════════════════════════════════════════════════
   INTERPOLATION ENGINE
   ════════════════════════════════════════════════════════════════ */

// Smooth ease-in-out
function ease(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// Interpolate between two keyframes at progress 0-1
function interpolatePose(keyframes, progress) {
  if (!keyframes || keyframes.length < 2) return {};
  const p = Math.max(0, Math.min(1, progress));
  let i = 0;
  for (i = 0; i < keyframes.length - 1; i++) {
    if (p <= keyframes[i + 1].t) break;
  }
  const k0 = keyframes[i];
  const k1 = keyframes[Math.min(i + 1, keyframes.length - 1)];
  const segLen = k1.t - k0.t;
  const local = segLen > 0 ? (p - k0.t) / segLen : 0;
  const eased = ease(local);
  const result = {};
  for (const key of Object.keys(k0)) {
    if (key === 't') continue;
    if (typeof k0[key] === 'number' && typeof k1[key] === 'number') {
      result[key] = k0[key] + (k1[key] - k0[key]) * eased;
    } else {
      result[key] = k0[key];
    }
  }
  return result;
}

/* ════════════════════════════════════════════════════════════════
   THEME COLORS
   ════════════════════════════════════════════════════════════════ */

const THEMES = {
  dark: {
    bodyStroke: 'rgba(255,255,255,0.25)',
    bodyFill: 'rgba(255,255,255,0.06)',
    muscleFill: 'rgb(var(--accent-rgb) / .45)',
    muscleGlow: 'var(--accent)',
    muscleGlowOpacity: 0.35,
    accentStart: 'var(--accent-deep)',
    accentEnd: 'var(--accent)',
    barColor: 'var(--ink)',
    barShadow: 'rgb(var(--accent-rgb) / .4)',
    groundStroke: 'rgba(255,255,255,0.08)',
    glowColor: 'rgb(var(--accent-rgb) / .08)',
    textPrimary: 'var(--ink)',
    textSecondary: 'rgba(255,255,255,0.5)',
    chipBg: 'rgba(255,255,255,0.06)',
    chipBorder: 'rgba(255,255,255,0.1)',
    controlBg: 'rgba(255,255,255,0.08)',
    controlBorder: 'rgba(255,255,255,0.12)',
    restGlow: 'rgb(var(--accent-rgb) / .12)',
    prGlow: 'rgb(var(--warn-rgb) / .25)',
    prColor: 'rgb(var(--warn-rgb))',
    bgGradient: 'radial-gradient(140% 100% at 50% 110%, rgb(var(--accent-rgb) / .06), transparent 55%)',
  },
  light: {
    bodyStroke: 'rgb(var(--ink-rgb) / .3)',
    bodyFill: 'rgb(var(--ink-rgb) / .04)',
    muscleFill: 'rgb(var(--accent-rgb) / .4)',
    muscleGlow: 'var(--accent)',
    muscleGlowOpacity: 0.25,
    accentStart: 'var(--accent)',
    accentEnd: 'var(--accent-deep)',
    barColor: 'var(--ink)',
    barShadow: 'rgb(var(--accent-rgb) / .35)',
    groundStroke: 'rgb(var(--ink-rgb) / .1)',
    glowColor: 'rgb(var(--accent-rgb) / .06)',
    textPrimary: 'var(--ink)',
    textSecondary: 'rgb(var(--ink-rgb) / .5)',
    chipBg: 'rgb(var(--ink-rgb) / .05)',
    chipBorder: 'rgb(var(--ink-rgb) / .1)',
    controlBg: 'rgb(var(--ink-rgb) / .06)',
    controlBorder: 'rgb(var(--ink-rgb) / .1)',
    restGlow: 'rgb(var(--accent-rgb) / .08)',
    prGlow: 'rgb(var(--warn-rgb) / .15)',
    prColor: 'rgb(var(--warn-rgb))',
    bgGradient: 'radial-gradient(140% 100% at 50% 110%, rgb(var(--accent-rgb) / .06), transparent 55%)',
  },
};

/* ════════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ════════════════════════════════════════════════════════════════ */

export default function ExerciseVisual({
  anim,            // animation_key from exercise_library
  muscle,          // primary_muscle label (string)
  secondaryMuscles, // comma-separated secondary muscles (optional)
  label,           // chip label
  size = 'md',     // 'sm' | 'md' | 'lg'
  className = '',
  autoPlay = true,
  showControls = true,
  intensity = 1.0, // animation intensity multiplier (0-1)
}) {
  const { theme } = useTheme();
  const t = THEMES[theme] || THEMES.dark;
  const [playing, setPlaying] = useState(autoPlay);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef(null);
  const startTimeRef = useRef(null);
  const pausedAtRef = useRef(0);

  // Resolve pose
  const poseKey = KEY_ALIASES[anim] || (EXERCISE_POSES[anim] ? anim : null);
  const pose = poseKey ? EXERCISE_POSES[poseKey] : null;

  // Detect reduced motion
  const prefersReduced = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // Animation loop
  useEffect(() => {
    if (!pose || !playing || prefersReduced) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (!playing && pose) setProgress(0);
      return;
    }
    const durationMs = (pose.duration / speed) * 1000;
    startTimeRef.current = performance.now() - (pausedAtRef.current * durationMs);
    const loop = (now) => {
      const elapsed = now - startTimeRef.current;
      const p = (elapsed % durationMs) / durationMs;
      setProgress(p);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [pose, playing, speed, prefersReduced]);

  // Pause / resume tracking
  const togglePlay = useCallback(() => {
    if (playing) {
      pausedAtRef.current = progress;
    }
    setPlaying(!playing);
  }, [playing, progress]);

  // Compute current interpolated values
  const poseValues = useMemo(() => {
    if (!pose) return {};
    return interpolatePose(pose.keyframes, progress);
  }, [pose, progress]);

  // Map muscle name → region keys
  const activeRegions = useMemo(() => {
    const regions = [];
    const mapMuscle = (m) => {
      const u = String(m || '').toUpperCase();
      if (u.includes('CHEST')) regions.push('chest');
      if (u.includes('SHOULDER') || u.includes('DELT')) regions.push('shoulders_L', 'shoulders_R');
      if (u.includes('BICEP')) regions.push('biceps_L', 'biceps_R');
      if (u.includes('TRICEP')) regions.push('triceps_L', 'triceps_R');
      if (u.includes('FOREARM')) regions.push('forearms_L', 'forearms_R');
      if (u.includes('LATS')) regions.push('lats_L', 'lats_R');
      if (u.includes('BACK') || u.includes('TRAPS')) regions.push('traps');
      if (u.includes('LOWER')) regions.push('traps');
      if (u.includes('GLUTE')) regions.push('glutes');
      if (u.includes('HAMSTRING')) regions.push('hamstrings_L', 'hamstrings_R');
      if (u.includes('QUAD')) regions.push('quads_L', 'quads_R');
      if (u.includes('CALF')) regions.push('calves_L', 'calves_R');
      if (u.includes('CORE') || u.includes('ABS') || u.includes('ABDOMIN')) regions.push('core');
    };
    mapMuscle(muscle);
    if (secondaryMuscles) mapMuscle(secondaryMuscles);
    // Also use pose-defined muscles if no explicit muscle prop
    if (!muscle && pose) {
      (pose.primary || []).forEach(m => mapMuscle(m));
      (pose.secondary || []).forEach(m => mapMuscle(m));
    }
    return [...new Set(regions)];
  }, [muscle, secondaryMuscles, pose]);

  const primaryRegions = useMemo(() => {
    const regions = [];
    const mapMuscle = (m) => {
      const u = String(m || '').toUpperCase();
      if (u.includes('CHEST')) regions.push('chest');
      if (u.includes('SHOULDER') || u.includes('DELT')) regions.push('shoulders_L', 'shoulders_R');
      if (u.includes('BICEP')) regions.push('biceps_L', 'biceps_R');
      if (u.includes('TRICEP')) regions.push('triceps_L', 'triceps_R');
      if (u.includes('LATS')) regions.push('lats_L', 'lats_R');
      if (u.includes('GLUTE')) regions.push('glutes');
      if (u.includes('HAMSTRING')) regions.push('hamstrings_L', 'hamstrings_R');
      if (u.includes('QUAD')) regions.push('quads_L', 'quads_R');
      if (u.includes('CORE') || u.includes('ABS')) regions.push('core');
      if (u.includes('TRAPS')) regions.push('traps');
    };
    mapMuscle(muscle);
    if (!muscle && pose) (pose.primary || []).forEach(m => mapMuscle(m));
    return [...new Set(regions)];
  }, [muscle, pose]);

  // Compute pose-specific transforms
  const bodyTransform = useMemo(() => {
    const dy = (poseValues.bodyDy || 0) * intensity;
    const angle = (poseValues.bodyAngle || 0) * intensity;
    const breathe = (poseValues.breathe || 0) * intensity;
    return `translate(0, ${dy + breathe}) rotate(${angle}, 100, 160)`;
  }, [poseValues, intensity]);

  // Size classes
  const sizeClasses = {
    sm: 'h-28 md:h-32',
    md: 'h-40 md:h-48',
    lg: 'h-56 md:h-64',
  };

  // Unique ID prefix for SVG filters
  const uid = useMemo(() => 'ev_' + Math.random().toString(36).slice(2, 8), []);

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-line ${className}`}
      style={{ backgroundImage: t.bgGradient, background: undefined }}
    >
      <div
        className="absolute inset-0 rounded-2xl pointer-events-none"
        style={{ backgroundImage: t.bgGradient }}
        aria-hidden="true"
      />

      <div className={`relative flex justify-center items-center ${sizeClasses[size]} px-4 py-3`}>
        <svg
          viewBox="0 0 200 380"
          className="h-full w-auto max-w-full"
          role="img"
          aria-label={label || muscle || 'Exercise animation'}
          style={{ filter: `drop-shadow(0 0 20px ${t.glowColor})` }}
        >
          <defs>
            {/* Muscle glow filter */}
            <filter id={`${uid}_glow`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
              <feFlood floodColor={t.muscleGlow} floodOpacity={t.muscleGlowOpacity} result="color" />
              <feComposite in="color" in2="blur" operator="in" result="glow" />
              <feMerge>
                <feMergeNode in="glow" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Accent gradient for bar/equipment */}
            <linearGradient id={`${uid}_accent`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={t.accentStart} />
              <stop offset="100%" stopColor={t.accentEnd} />
            </linearGradient>

            {/* Body gradient */}
            <linearGradient id={`${uid}_bodyGrad`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={t.bodyFill} stopOpacity="0.8" />
              <stop offset="100%" stopColor={t.bodyFill} stopOpacity="0.4" />
            </linearGradient>

            {/* Primary muscle gradient */}
            <linearGradient id={`${uid}_primaryGrad`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={t.muscleFill} />
              <stop offset="100%" stopColor={t.muscleFill} stopOpacity="0.6" />
            </linearGradient>
          </defs>

          {/* Ground line */}
          <line x1="20" y1="362" x2="180" y2="362" stroke={t.groundStroke} strokeWidth="1.5" />

          {/* Body group with pose transform */}
          <g transform={bodyTransform}>
            {/* Body silhouette */}
            <path
              d={BODY_SILHOUETTE}
              fill={`url(#${uid}_bodyGrad)`}
              stroke={t.bodyStroke}
              strokeWidth="1.5"
              strokeLinejoin="round"
            />

            {/* Muscle regions */}
            {Object.entries(MUSCLE_PATHS).map(([key, d]) => {
              const isActive = activeRegions.includes(key);
              const isPrimary = primaryRegions.includes(key);
              if (!isActive) return null;
              return (
                <path
                  key={key}
                  d={d}
                  fill={isPrimary ? `url(#${uid}_primaryGrad)` : t.muscleFill}
                  stroke={t.muscleGlow}
                  strokeWidth={isPrimary ? '1.5' : '0.8'}
                  strokeOpacity={isPrimary ? '0.6' : '0.3'}
                  filter={isPrimary ? `url(#${uid}_glow)` : undefined}
                  opacity={isPrimary ? 0.9 : 0.5}
                  style={{ transition: 'opacity 0.4s ease' }}
                />
              );
            })}

            {/* Equipment / bar for specific exercises */}
            {pose && renderEquipment(pose, poseValues, t, uid, intensity)}
          </g>
        </svg>
      </div>

      {/* Chips: label + muscle */}
      {(label || muscle) && (
        <div className="absolute top-2 left-2 flex gap-1.5 max-w-[85%] z-10">
          {muscle && (
            <span
              className="px-2 py-0.5 rounded-full text-[9px] font-grotesk font-semibold backdrop-blur-sm"
              style={{ background: t.chipBg, border: `1px solid ${t.muscleGlow}40`, color: t.muscleGlow }}
            >
              {muscle}
            </span>
          )}
          {label && (
            <span
              className="px-2 py-0.5 rounded-full text-[9px] font-grotesk backdrop-blur-sm"
              style={{ background: t.chipBg, border: `1px solid ${t.chipBorder}`, color: t.textSecondary }}
            >
              {label}
            </span>
          )}
        </div>
      )}

      {/* Controls */}
      {showControls && pose && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1.5 z-10">
          <button
            onClick={togglePlay}
            className="w-7 h-7 rounded-full grid place-items-center text-[11px] backdrop-blur-sm active:scale-90 transition-transform"
            style={{ background: t.controlBg, border: `1px solid ${t.controlBorder}`, color: t.textPrimary }}
            aria-label={playing ? 'Pause animation' : 'Play animation'}
          >
            {playing ? '⏸' : '▶'}
          </button>
          {[0.5, 1, 2].map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className="w-7 h-7 rounded-full grid place-items-center text-[9px] font-grotesk font-semibold backdrop-blur-sm active:scale-90 transition-transform"
              style={{
                background: speed === s ? `${t.muscleGlow}30` : t.controlBg,
                border: `1px solid ${speed === s ? t.muscleGlow + '50' : t.controlBorder}`,
                color: speed === s ? t.muscleGlow : t.textSecondary,
              }}
              aria-label={`Speed ${s}x`}
            >
              {s === 0.5 ? '½' : s === 1 ? '1' : '2'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   EQUIPMENT RENDERERS — pose-specific bar/weight visuals
   ════════════════════════════════════════════════════════════════ */

function renderEquipment(pose, values, t, uid, intensity) {
  const pv = values;

  // Barbell exercises
  if (['bench_press', 'squat', 'shoulder_press', 'deadlift', 'incline_db_press', 'romanian_deadlift'].includes(pose)) {
    const barDy = (pv.barDy || 0) * intensity;
    const armAngle = (pv.armAngle || 0) * intensity;
    const bodyAngle = (pv.bodyAngle || 0) * intensity;

    if (pose === 'squat') {
      // Bar across shoulders
      return (
        <g>
          <line x1="58" y1={48 + barDy} x2="142" y2={48 + barDy}
            stroke={t.barColor} strokeWidth="3" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${t.barShadow})` }} />
          <rect x="52" y={42 + barDy} width="10" height="14" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
          <rect x="138" y={42 + barDy} width="10" height="14" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
        </g>
      );
    }
    if (pose === 'bench_press' || pose === 'incline_db_press') {
      // Bar above chest
      return (
        <g transform={`rotate(${-armAngle}, 100, 86)`}>
          <line x1="56" y1={72 + barDy} x2="144" y2={72 + barDy}
            stroke={t.barColor} strokeWidth="3" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${t.barShadow})` }} />
          <rect x="50" y={66 + barDy} width="10" height="12" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
          <rect x="140" y={66 + barDy} width="10" height="12" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
        </g>
      );
    }
    if (pose === 'shoulder_press') {
      const armDy = (pv.armDy || 0) * intensity;
      return (
        <g>
          <line x1="58" y1={52 + armDy} x2="142" y2={52 + armDy}
            stroke={t.barColor} strokeWidth="3" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${t.barShadow})` }} />
          <rect x="52" y={46 + armDy} width="10" height="12" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
          <rect x="138" y={46 + armDy} width="10" height="12" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
        </g>
      );
    }
    if (pose === 'deadlift' || pose === 'romanian_deadlift') {
      const barY = 200 + barDy;
      return (
        <g>
          <line x1="56" y1={barY} x2="144" y2={barY}
            stroke={t.barColor} strokeWidth="3" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${t.barShadow})` }} />
          <rect x="50" y={barY - 7} width="10" height="14" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
          <rect x="140" y={barY - 7} width="10" height="14" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
        </g>
      );
    }
  }

  // Dumbbell exercises
  if (['bicep_curl', 'lateral_raise', 'dumbbell_row'].includes(pose)) {
    const curlAngle = (pv.curlAngle || 0) * intensity;
    const raiseAngle = (pv.raiseAngle || 0) * intensity;

    if (pose === 'bicep_curl') {
      return (
        <g>
          {/* Left dumbbell */}
          <g transform={`rotate(${-curlAngle * 0.8}, 88, 108)`}>
            <rect x="82" y="140" width="14" height="8" rx="3" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5"
              style={{ filter: `drop-shadow(0 0 4px ${t.barShadow})` }} />
          </g>
          {/* Right dumbbell (main) */}
          <g transform={`rotate(${curlAngle}, 112, 108)`}>
            <rect x="106" y="140" width="14" height="8" rx="3" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5"
              style={{ filter: `drop-shadow(0 0 4px ${t.barShadow})` }} />
          </g>
        </g>
      );
    }
    if (pose === 'lateral_raise') {
      const armSpread = raiseAngle / 90;
      return (
        <g>
          <g transform={`rotate(${-raiseAngle}, 88, 88)`}>
            <rect x="82" y="128" width="12" height="8" rx="3" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5"
              style={{ filter: `drop-shadow(0 0 4px ${t.barShadow})` }} />
          </g>
          <g transform={`rotate(${raiseAngle}, 112, 88)`}>
            <rect x="106" y="128" width="12" height="8" rx="3" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5"
              style={{ filter: `drop-shadow(0 0 4px ${t.barShadow})` }} />
          </g>
        </g>
      );
    }
    if (pose === 'dumbbell_row') {
      const rowAngle = (pv.rowAngle || 0) * intensity;
      return (
        <g transform={`rotate(${rowAngle}, 100, 86)`}>
          <rect x="92" y="140" width="16" height="8" rx="3" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5"
            style={{ filter: `drop-shadow(0 0 4px ${t.barShadow})` }} />
        </g>
      );
    }
  }

  // Cable / pushdown exercises
  if (['triceps_pushdown', 'lat_pulldown', 'cable_crunch', 'seated_row'].includes(pose)) {
    const pushAngle = (pv.pushAngle || 0) * intensity;
    const pullDy = (pv.pullDy || 0) * intensity;
    const rowDy = (pv.rowDy || 0) * intensity;
    const crunchAngle = (pv.crunchAngle || 0) * intensity;

    if (pose === 'triceps_pushdown') {
      return (
        <g>
          {/* Cable from above */}
          <line x1="100" y1="10" x2="100" y2={62 + pushAngle} stroke={t.barColor} strokeWidth="1.5" strokeDasharray="3,3" opacity="0.5" />
          <rect x="92" y={58 + pushAngle} width="16" height="6" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5"
            style={{ filter: `drop-shadow(0 0 4px ${t.barShadow})` }} />
        </g>
      );
    }
    if (pose === 'lat_pulldown') {
      return (
        <g>
          <line x1="100" y1="10" x2="100" y2={52 + pullDy} stroke={t.barColor} strokeWidth="1.5" strokeDasharray="3,3" opacity="0.5" />
          <line x1="66" y1={42 + pullDy} x2="134" y2={42 + pullDy}
            stroke={t.barColor} strokeWidth="3" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${t.barShadow})` }} />
          <rect x="60" y={36 + pullDy} width="10" height="12" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
          <rect x="130" y={36 + pullDy} width="10" height="12" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
        </g>
      );
    }
    if (pose === 'seated_row') {
      return (
        <g transform={`translate(${rowDy * 0.5}, 0)`}>
          <line x1="100" y1="80" x2="100" y2={100 + rowDy} stroke={t.barColor} strokeWidth="1.5" strokeDasharray="3,3" opacity="0.5" />
          <rect x="92" y={96 + rowDy} width="16" height="6" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5"
            style={{ filter: `drop-shadow(0 0 4px ${t.barShadow})` }} />
        </g>
      );
    }
    if (pose === 'cable_crunch') {
      return (
        <g transform={`rotate(${crunchAngle}, 100, 100)`}>
          <line x1="100" y1="10" x2="100" y2="50" stroke={t.barColor} strokeWidth="1.5" strokeDasharray="3,3" opacity="0.5" />
          <rect x="93" y="46" width="14" height="5" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
        </g>
      );
    }
  }

  // Push-up (no equipment, just hand positions)
  if (pose === 'push_up') {
    const armAngle = (pv.armAngle || 0) * intensity;
    return (
      <g transform={`rotate(${(pv.bodyAngle || 0) * intensity}, 100, 160)`}>
        {/* Hands on ground */}
        <circle cx={60 - armAngle * 0.3} cy="166" r="4" fill={t.bodyFill} stroke={t.bodyStroke} strokeWidth="1.5" />
        <circle cx={140 + armAngle * 0.3} cy="166" r="4" fill={t.bodyFill} stroke={t.bodyStroke} strokeWidth="1.5" />
      </g>
    );
  }

  // Lunges (no equipment)
  if (pose === 'lunges') {
    const depth = (pv.lungeDepth || 0) * intensity;
    return (
      <g transform={`translate(0, ${depth * 0.3})`}>
        <circle cx="94" cy="136" r="3" fill={t.bodyFill} stroke={t.bodyStroke} strokeWidth="1" />
        <circle cx="106" cy="136" r="3" fill={t.bodyFill} stroke={t.bodyStroke} strokeWidth="1" />
      </g>
    );
  }

  // Hip thrust (barbell on hips)
  if (pose === 'hip_thrust') {
    const hipDy = (pv.hipDy || 0) * intensity;
    return (
      <g>
        <line x1="76" y1={190 + hipDy} x2="124" y2={190 + hipDy}
          stroke={t.barColor} strokeWidth="3" strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 6px ${t.barShadow})` }} />
        <rect x="70" y={184 + hipDy} width="10" height="12" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
        <rect x="120" y={184 + hipDy} width="10" height="12" rx="2" fill={t.accentStart} stroke={t.barColor} strokeWidth="1.5" />
      </g>
    );
  }

  return null;
}

/* ════════════════════════════════════════════════════════════════
   EXPORTS
   ════════════════════════════════════════════════════════════════ */

export { EXERCISE_POSES, KEY_ALIASES, MUSCLE_PATHS };
