/**
 * AUTH AURA — light and depth behind the sign-in pages. No geometry.
 *
 * THIS REPLACES A SET OF CONCENTRIC RINGS, which read as busy rather than
 * premium: three shapes turning at three different rates gives the eye
 * something to track and follow, and the one thing a sign-in background
 * must not do is compete with the form in front of it. The feedback was
 * exactly right — "very complex" — and the fix is not smaller rings, it
 * is no rings.
 *
 * WHAT IS LEFT is three very large, very soft blooms of light drifting
 * almost imperceptibly past each other. There is no edge anywhere in the
 * scene, so there is no shape to notice; what you get is depth and a slow
 * change in the quality of the light, which is the thing expensive
 * software actually does behind a login. If someone looks straight at it
 * and cannot say what it is, it is working.
 *
 * WHY SPRITES AND A CANVAS GRADIENT, not a shader: three draw calls, no
 * shader compilation on first paint, no postprocessing pass, and a soft
 * falloff that is genuinely round rather than a polygon approximation.
 * The whole scene is cheaper than the rings it replaces.
 *
 * Motion is trigonometric over elapsed time rather than integrated, so
 * cost is constant per frame and nothing desynchronises when the tab is
 * backgrounded and rAF pauses — the same discipline as AuroraField.
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { brand } from '../../tokens.js';

/** A radial gradient painted once into a texture. Alpha falls to zero
 *  well before the edge, so the sprite has no visible boundary at any
 *  size — which is the entire point. */
function useBloomTexture() {
  return useMemo(() => {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // Eased stops rather than linear: a linear ramp reads as a disc with a
    // soft edge, this reads as light.
    g.addColorStop(0.00, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.62)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.24)');
    g.addColorStop(0.70, 'rgba(255,255,255,0.06)');
    g.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
}

/* Three blooms, deliberately unequal in size, depth and speed — matched
   ones would beat against each other and become a pattern to notice. */
const BLOOMS = [
  { scale: 7.0, at: [-1.5, -0.7, -1.0], drift: [0.9, 0.6], speed: 0.045, opacity: 0.34 },
  { scale: 5.2, at: [1.7, 0.9, -0.4], drift: [0.7, 1.0], speed: 0.031, opacity: 0.26 },
  { scale: 9.0, at: [0.4, 1.6, -2.2], drift: [1.2, 0.5], speed: 0.019, opacity: 0.16 },
];

function Bloom({ spec, color, tex, reduced }) {
  const ref = useRef();

  useFrame((state) => {
    if (!ref.current || reduced) return;
    const t = state.clock.elapsedTime * spec.speed;
    // Two different frequencies per axis, so the path never repeats
    // visibly inside a session.
    ref.current.position.x = spec.at[0] + Math.sin(t * 1.0) * spec.drift[0];
    ref.current.position.y = spec.at[1] + Math.cos(t * 0.7) * spec.drift[1];
  });

  return (
    <sprite ref={ref} position={spec.at} scale={[spec.scale, spec.scale, 1]}>
      <spriteMaterial
        map={tex}
        color={color}
        transparent
        opacity={spec.opacity}
        depthWrite={false}
        // Normal, not additive: additive blows out to white on the light
        // theme's near-white ground. One material, honest in both themes.
        blending={THREE.NormalBlending}
      />
    </sprite>
  );
}

export default function AuthAura({
  color = brand.dark.accent,
  accentDeep = brand.dark.accentDeep,
  reduced = false,
}) {
  const tex = useBloomTexture();
  return (
    <group>
      {BLOOMS.map((spec, i) => (
        <Bloom
          key={spec.scale}
          spec={spec}
          // The largest, furthest bloom takes the deeper partner colour so
          // the light has some temperature to it rather than one flat tint.
          color={i === BLOOMS.length - 1 ? accentDeep : color}
          tex={tex}
          reduced={reduced}
        />
      ))}
    </group>
  );
}
