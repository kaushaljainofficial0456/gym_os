/**
 * The 3D body, shared by the muscle picker (MuscleBody3DImpl) and the
 * Workout page's "today's muscles" (BodyPreview3DImpl): the model, how its
 * mesh names map to muscles, the clay look, framing, and the mapping from
 * an exercise's primary_muscle to the body's muscle groups.
 *
 * Imports three.js -- only ever reached through a lazy import.
 */
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';

export const BODY_URL = '/assets/anatomy/skos-body-v2.glb';

// Draco-compressed; the decoder is served from our own origin
// (frontend/public/draco/) because the CSP does not allow Google's CDN.
useGLTF.setDecoderPath('/draco/');

/** Start loading and decoding the model now (idempotent). */
export function preloadBody() { useGLTF.preload(BODY_URL); }

/**
 * The muscle a mesh belongs to. Names are "<muscleId>.l" / ".r" in the
 * file, but three's GLTFLoader sanitizes node names and DROPS THE DOT
 * ("pectoralis_major.l" arrives as "pectoralis_majorl").
 */
export function muscleIdOf(name, map) {
  const n = String(name || '');
  const dotted = n.replace(/\.[lr]$/i, '');
  if (map?.[dotted]) return dotted;
  const bare = n.replace(/[._]?[lr]$/i, '');
  if (map?.[bare]) return bare;
  return dotted;
}

export function cssColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return new THREE.Color(v || fallback);
  } catch { return new THREE.Color(fallback); }
}
export const isDark = () => document.documentElement.classList.contains('dark');

/**
 * THE CLAY: a matcap drawn on a canvas -- the technique of a ZBrush
 * anatomy render. Lighting lives in a small picture of a lit sphere, read
 * by each surface's direction to the camera, so the body looks studio-lit
 * from every angle with no lights to compute. One per theme, shared.
 */
const matcaps = {};
export function matcapFor(dark) {
  const key = dark ? 'dark' : 'light';
  if (matcaps[key]) return matcaps[key];
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const r = S / 2;
  const base = dark ? [176, 168, 160] : [196, 188, 180];
  const sphere = (x, y, rad, stops) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    stops.forEach(([o, col]) => gr.addColorStop(o, col));
    g.fillStyle = gr;
    g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();
  };
  sphere(r * 0.72, r * 0.6, r * 1.55, [
    [0, `rgb(${base.map((v) => Math.min(255, v + 58)).join(',')})`],
    [0.45, `rgb(${base.join(',')})`],
    [0.85, `rgb(${base.map((v) => Math.round(v * 0.42)).join(',')})`],
    [1, `rgb(${base.map((v) => Math.round(v * 0.3)).join(',')})`],
  ]);
  g.globalCompositeOperation = 'lighter';
  sphere(r * 0.62, r * 0.5, r * 0.55, [[0, 'rgba(255,248,240,.22)'], [1, 'rgba(255,248,240,0)']]);
  const rim = g.createRadialGradient(r, r, r * 0.78, r, r, r);
  rim.addColorStop(0, 'rgba(0,0,0,0)');
  rim.addColorStop(0.75, 'rgba(150,170,205,0)');
  rim.addColorStop(1, 'rgba(150,170,205,.32)');
  g.fillStyle = rim;
  g.beginPath(); g.arc(r, r, r, -Math.PI * 0.55, Math.PI * 0.35); g.lineTo(r, r); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  matcaps[key] = tex;
  return tex;
}

/** The warm red a picked or worked muscle glows in, in either theme. */
export const hotColor = () => cssColor('--m-energy', '#D97B84');

/**
 * How far a perspective camera must stand to see the whole box, for this
 * field of view and canvas aspect. Width allows for the body turning (its
 * widest side is not always facing the camera).
 */
export function fitDistance(size, fovDeg, aspect, margin = 1.08) {
  const t = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const halfH = (size.y / 2) * margin;
  const halfW = (Math.max(size.x, size.z) / 2) * margin;
  return Math.max(halfH / t, halfW / (t * aspect)) + Math.max(size.x, size.z) / 2;
}

/**
 * An exercise's primary_muscle -> the body's muscle groups it lights up.
 * The library files UPPER/LOWER CHEST, SHOULDERS, POSTERIOR CHAIN and FULL
 * BODY; the body has one chest, three delt heads, and so on.
 */
const ALL = ['CHEST', 'FRONT DELTS', 'SIDE DELTS', 'REAR DELTS', 'TRAPS', 'UPPER BACK', 'LATS', 'BICEPS', 'TRICEPS',
  'FOREARMS', 'ABS', 'CORE', 'LOWER BACK', 'GLUTES', 'QUADS', 'HAMSTRINGS', 'CALVES'];
const FOCUS = {
  'UPPER CHEST': ['CHEST'], 'LOWER CHEST': ['CHEST'],
  SHOULDERS: ['FRONT DELTS', 'SIDE DELTS', 'REAR DELTS'],
  CORE: ['CORE', 'ABS'],
  'POSTERIOR CHAIN': ['LOWER BACK', 'GLUTES', 'HAMSTRINGS'],
  'FULL BODY': ALL,
};
export function groupsForMuscles(muscles = []) {
  const out = new Set();
  for (const m of muscles) {
    const k = String(m || '').toUpperCase().replace(/_/g, ' ').trim();
    (FOCUS[k] || (ALL.includes(k) ? [k] : [])).forEach((g) => out.add(g));
  }
  return out;
}
