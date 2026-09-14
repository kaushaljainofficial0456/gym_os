/**
 * AUTH ORBIT — the 3D element behind the sign-in pages.
 *
 * RINGS, BECAUSE THE RING IS ALREADY THIS PRODUCT'S MOTIF. Adherence,
 * goal progress, capacity, a client's journey — all of it is drawn as an
 * arc somewhere in the app. A generic blob or a floating geometric
 * sculpture would look fine and mean nothing; three concentric rings
 * slowly finding alignment is the thing the product actually does,
 * rendered large. The first screen should promise what the rest keeps.
 *
 * LOADED LAZILY, LIKE EVERY OTHER SCENE HERE. Nothing imports this
 * statically — see the header of AmbientBackdrop.jsx for the measured
 * cost (224 kB → 509 kB gzipped) of getting that wrong. Login is the
 * first paint for every unauthenticated visitor and the one page that
 * must never feel slow.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: no bloom, no postprocessing, no
 * shadow maps. This sits BEHIND a form people have to read and type in,
 * so it gets the leftover frames, not the budget. Segment counts step
 * down with the device tier, and the whole thing is skipped entirely for
 * reduced-motion or no-WebGL by the wrapper above it.
 */
import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStageTier } from '../Stage.jsx';
import { brand } from '../../tokens.js';

/* Tube segments are the expensive axis on a torus; radial segments barely
   move the needle. Low tier still reads as a smooth ring at this scale. */
const SEG_BY_TIER = {
  low: [80, 10],
  medium: [140, 14],
  high: [220, 20],
};

/** The three rings, tilted so they read as a system rather than a target.
 *  Radii are spaced unevenly on purpose — evenly spaced rings look like a
 *  dartboard, which is a different and much cheaper idea. */
const RINGS = [
  { r: 1.70, tube: 0.020, tilt: [0.42, 0.10, 0.00], spin: 0.055, opacity: 0.95 },
  { r: 2.35, tube: 0.013, tilt: [-0.30, 0.45, 0.22], spin: -0.038, opacity: 0.62 },
  { r: 3.10, tube: 0.008, tilt: [0.18, -0.55, -0.14], spin: 0.024, opacity: 0.34 },
];

function Ring({ spec, color, segs, reduced }) {
  const ref = useRef();
  const geom = useMemo(
    () => new THREE.TorusGeometry(spec.r, spec.tube, segs[1], segs[0]),
    [spec.r, spec.tube, segs],
  );
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: spec.opacity,
      // Additive would blow out on the light theme's near-white ground;
      // normal blending keeps one material honest in both.
      blending: THREE.NormalBlending,
      depthWrite: false,
    }),
    [color, spec.opacity],
  );

  useFrame((_, dt) => {
    if (!ref.current || reduced) return;
    // Clamped delta: a backgrounded tab resumes with a huge dt and the
    // rings would snap round rather than continue turning.
    const d = Math.min(dt, 0.05);
    ref.current.rotation.z += spec.spin * d;
    ref.current.rotation.x += spec.spin * d * 0.35;
  });

  return <mesh ref={ref} geometry={geom} material={mat} rotation={spec.tilt} />;
}

export default function AuthOrbit({
  tier: tierProp,
  color = brand.dark.accent,
  accentDeep = brand.dark.accentDeep,
  reduced = false,
}) {
  const stageTier = useStageTier();
  const tier = tierProp ?? stageTier;
  const segs = SEG_BY_TIER[tier] ?? SEG_BY_TIER.medium;
  const group = useRef();
  const { viewport } = useThree();

  /* PARALLAX THAT FOLLOWS THE POINTER, barely.
     Big enough to feel alive when you move the mouse, small enough that
     nobody notices it as an effect — and eased rather than tracked, so it
     drifts to the pointer instead of snapping to it. */
  useFrame((state, dt) => {
    if (!group.current || reduced) return;
    const d = Math.min(dt, 0.05);
    const tx = state.pointer.y * 0.10;
    const ty = state.pointer.x * 0.14;
    group.current.rotation.x += (tx - group.current.rotation.x) * Math.min(1, d * 1.6);
    group.current.rotation.y += (ty - group.current.rotation.y) * Math.min(1, d * 1.6);
  });

  // Keep the composition off-centre and scaled to the viewport, so the
  // rings sit behind the headline rather than colliding with it.
  const scale = Math.min(1, viewport.width / 9);

  return (
    <group ref={group} position={[0, 0, 0]} scale={scale}>
      {RINGS.map((spec, i) => (
        <Ring
          key={spec.r}
          spec={spec}
          // The outermost ring takes the deeper partner colour so the set
          // has depth instead of three copies of one line weight.
          color={i === RINGS.length - 1 ? accentDeep : color}
          segs={segs}
          reduced={reduced}
        />
      ))}
    </group>
  );
}
