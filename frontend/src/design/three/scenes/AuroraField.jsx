/**
 * AuroraField — the default SK OS ambient backdrop.
 *
 * WHAT IT IS: a slow, drifting field of instanced particles tinted with
 * the brand accent, plus a soft light sweep. Designed to sit BEHIND
 * content at low opacity, not to be looked at directly.
 *
 * WHY INSTANCED, AND WHY THIS FEW
 * One InstancedMesh draws all particles in a single draw call. Naive
 * per-particle meshes would issue `count` draw calls, which is what makes
 * "just a few floating dots" tank a mid-range phone. Counts are tied to
 * the device tier, and even 'high' stays modest -- this is a background,
 * and spending the frame budget here means the actual interface has less.
 *
 * MOTION IS COMPUTED, NOT SIMULATED: positions come from a cheap
 * trigonometric drift over elapsed time rather than a physics step, so
 * cost is constant per frame and there is no state to desynchronise when
 * the tab is backgrounded and rAF pauses.
 *
 * Colour is passed in from JS tokens because a WebGL material cannot read
 * a CSS variable -- see src/design/tokens.js `brand`.
 */
import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStageTier } from '../Stage.jsx';

const COUNT_BY_TIER = { low: 60, medium: 140, high: 260 };

export default function AuroraField({
  tier: tierProp,
  color = '#14C4BC',
  accentDeep = '#0A8A85',
  speed = 0.06,
  spread = 9,
}) {
  const meshRef = useRef();
  // Tier comes from Stage unless a caller pins it explicitly. This is what
  // makes the particle COUNT adapt, not just the renderer settings.
  const stageTier = useStageTier();
  const tier = tierProp ?? stageTier;
  const count = COUNT_BY_TIER[tier] ?? COUNT_BY_TIER.medium;

  // Per-particle constants generated once. Recomputing these each frame
  // would be the actual cost; the animation below only reads them.
  const seeds = useMemo(() => {
    const arr = new Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = {
        x: (Math.random() - 0.5) * spread * 2,
        y: (Math.random() - 0.5) * spread,
        z: (Math.random() - 0.5) * spread,
        phase: Math.random() * Math.PI * 2,
        amp: 0.3 + Math.random() * 0.9,
        scale: 0.012 + Math.random() * 0.03,
      };
    }
    return arr;
  }, [count, spread]);

  // Two-tone: particles lerp between the brand's deep and bright ends so
  // the field reads as one material with depth rather than flat dots.
  const colorAttr = useMemo(() => {
    const a = new THREE.Color(accentDeep);
    const b = new THREE.Color(color);
    const buf = new Float32Array(count * 3);
    const tmp = new THREE.Color();
    for (let i = 0; i < count; i++) {
      tmp.copy(a).lerp(b, Math.random());
      buf[i * 3] = tmp.r;
      buf[i * 3 + 1] = tmp.g;
      buf[i * 3 + 2] = tmp.b;
    }
    return buf;
  }, [count, color, accentDeep]);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime * speed;

    for (let i = 0; i < count; i++) {
      const s = seeds[i];
      // Cheap drift: two out-of-phase sines. No sqrt, no normalisation.
      dummy.position.set(
        s.x + Math.sin(t + s.phase) * s.amp,
        s.y + Math.cos(t * 0.8 + s.phase) * s.amp * 0.6,
        s.z
      );
      dummy.scale.setScalar(s.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      {/* Ambient only at low tier: lights are per-fragment cost and this
          scene's material is unlit-ish, so extra lights buy little. */}
      <ambientLight intensity={0.6} />
      {tier !== 'low' && (
        <pointLight position={[4, 3, 5]} intensity={0.8} color={color} />
      )}

      <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
        {/* An 8-segment sphere is plenty at this on-screen size; the
            vertex count of a 32-segment default would be ~16x for pixels
            nobody can distinguish. */}
        <sphereGeometry args={[1, 8, 8]}>
          <instancedBufferAttribute
            attach="attributes-color"
            args={[colorAttr, 3]}
          />
        </sphereGeometry>
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={0.55}
          blending={THREE.AdditiveBlending}
          depthWrite={false}   // additive particles must not occlude each other
        />
      </instancedMesh>
    </>
  );
}
