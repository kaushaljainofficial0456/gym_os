/**
 * The 3D rings. Lazy-loaded by FuelRings.jsx -- never import this file
 * statically, it pulls in three.js.
 *
 * Each ring is a torus whose shader discards everything past the ring's
 * progress, so filling a ring is a uniform change, not new geometry. The
 * end is capped with a small lit sphere so a ring reads as a rounded arc
 * rather than a sliced tube. Progress eases toward its target every frame,
 * which is what makes logging a meal visibly "pour" into the rings.
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import Stage from '../../design/three/Stage.jsx';
import { useRingColors } from './FuelRings.jsx';

const VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uProgress;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    // An empty ring draws nothing -- not even the seam column at u = 0.
    if (vUv.x > uProgress || uProgress < 0.002) discard;
    vec3 n = normalize(vNormal);
    vec3 v = normalize(-vView);
    vec3 l = normalize(vec3(0.35, 0.9, 1.0));
    float diff = max(dot(n, l), 0.0);
    float spec = pow(max(dot(reflect(-l, n), v), 0.0), 28.0);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 2.4);
    // A brighter leading edge: the eye reads which way the ring is filling.
    float head = smoothstep(uProgress - 0.22, uProgress, vUv.x) * step(0.001, uProgress);
    vec3 col = uColor * (0.42 + 0.58 * diff) + vec3(spec * 0.45) + uColor * rim * 0.55 + uColor * head * 0.18;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

// The hole inside the fat ring has to hold the centre label (kcal left,
// eaten / target), so the macro rings sit close under the calorie ring and
// the inner tubes are thin. Keep the hole in step with HOLE in
// FuelRings.jsx, which sizes the label for it.
const RINGS = [
  { key: 'calories', radius: 1.62, tube: 0.125 },
  { key: 'protein', radius: 1.4, tube: 0.068 },
  { key: 'carbs', radius: 1.21, tube: 0.068 },
  { key: 'fat', radius: 1.02, tube: 0.068 },
];

function Ring({ radius, tube, color, trackColor, target }) {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uColor: { value: new THREE.Color(color) }, uProgress: { value: 0 }, uOpacity: { value: 1 } },
    side: THREE.DoubleSide,
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const capMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uColor: { value: new THREE.Color(color) }, uProgress: { value: 2 }, uOpacity: { value: 1 } },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const geo = useMemo(() => new THREE.TorusGeometry(radius, tube, 20, 180), [radius, tube]);
  // The track sits just inside the filled tube, so the two never z-fight.
  const trackGeo = useMemo(() => new THREE.TorusGeometry(radius, tube * 0.9, 16, 120), [radius, tube]);
  const capGeo = useMemo(() => new THREE.SphereGeometry(tube, 20, 14), [tube]);
  const start = useRef();
  const head = useRef();
  const p = useRef(0);

  useFrame((_, dt) => {
    mat.uniforms.uColor.value.set(color);
    capMat.uniforms.uColor.value.set(color);
    // Critically damped ease toward the target: no overshoot on a number
    // someone is reading as "how much is left".
    p.current += (target - p.current) * (1 - Math.exp(-dt * 3.2));
    if (Math.abs(target - p.current) < 0.0005) p.current = target;
    mat.uniforms.uProgress.value = p.current;
    const a = p.current * Math.PI * 2;
    const visible = p.current > 0.004;
    if (head.current) {
      head.current.visible = visible;
      head.current.position.set(Math.cos(a) * radius, Math.sin(a) * radius, 0);
    }
    if (start.current) start.current.visible = visible;
  });

  return (
    <group>
      <mesh geometry={trackGeo}>
        <meshBasicMaterial color={trackColor} transparent opacity={0.07} depthWrite={false} />
      </mesh>
      <mesh geometry={geo} material={mat} />
      <mesh ref={start} geometry={capGeo} material={capMat} position={[radius, 0, 0]} />
      <mesh ref={head} geometry={capGeo} material={capMat} />
    </group>
  );
}

function Rings({ progress, over }) {
  const colors = useRingColors(over);
  const group = useRef();
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!group.current) return;
    // Tilted back like a dial seen from above, breathing slightly.
    group.current.rotation.x = -0.32 + Math.sin(t * 0.6) * 0.035;
    group.current.rotation.y = Math.sin(t * 0.35) * 0.12;
  });
  return (
    // Start at twelve o'clock and fill clockwise, like every ring people know.
    <group ref={group}>
      <group rotation={[0, 0, -Math.PI / 2]} scale={[-1, 1, 1]}>
        {RINGS.map((r) => (
          <Ring key={r.key} radius={r.radius} tube={r.tube} color={colors[r.key]} trackColor={colors.track} target={progress[r.key]} />
        ))}
      </group>
    </group>
  );
}

export default function FuelRingsScene({ size, progress, over, fallback }) {
  return (
    <Stage className="absolute inset-0" style={{ width: size, height: size }} fallback={fallback} maxTier="medium"
           camera={{ position: [0, 0, 5.1], fov: 42 }}>
      <Rings progress={progress} over={over} />
    </Stage>
  );
}
