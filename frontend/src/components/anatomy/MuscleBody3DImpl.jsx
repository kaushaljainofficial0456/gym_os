/**
 * MuscleBody3DImpl -- the 3D muscle picker.
 *
 * The model is one continuous sculpted body built from Z-Anatomy geometry
 * (scripts/anatomy/build_body_v2_stage_*.py), cut into tappable regions
 * ("<muscleId>.l" / ".r") and "body" for everything that is not a muscle
 * group in the exercise library. See bodyModel.js for the shared parts.
 *
 *  - Swipe sideways to turn it, with momentum. Up and down is left to the
 *    page (touch-action: pan-y), so a body in a scrolling sheet never traps
 *    the scroll. A mouse wheel zooms.
 *  - Tap a muscle: its whole group lights up, both sides. A drag never
 *    counts as a tap.
 *  - FRAMED BEFORE IT IS SEEN: the camera is placed in a layout effect,
 *    from the model's real size and the canvas's real shape, before the
 *    first frame -- it used to start from a default position, and the first
 *    frame on a phone showed the body with its head cut off. The canvas
 *    fades in once framed.
 *  - Draws only while something moves (frameloop "demand").
 */
import { useLayoutEffect, useEffect, useMemo, useRef, useState } from 'react';
import { useGLTF, OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { Rotate3d } from 'lucide-react';
import * as THREE from 'three';
import Stage from '../../design/three/Stage.jsx';
import { BODY_URL, muscleIdOf, matcapFor, hotColor, isDark, fitDistance, preloadBody } from './bodyModel.js';
import './anatomy.css';

const FOV = 30;
const PHI = Math.PI / 2.12;       // a touch above eye level
const START_TURN = 0.95;          // the entrance turns in from here

function Body({ map, selectedGroup, hovered, onPick, onHover, onFramed }) {
  const { scene } = useGLTF(BODY_URL);
  const { camera, size, invalidate, controls } = useThree();
  const theme = useMemo(() => ({ matcap: matcapFor(isDark()), white: new THREE.Color(1, 1, 1), hot: hotColor() }), []);

  // One material per region, so lighting one group never touches another.
  const meshes = useMemo(() => {
    const list = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const id = muscleIdOf(o.name, map);
      o.material = new THREE.MeshMatcapMaterial({ matcap: theme.matcap, color: theme.white.clone(), vertexColors: !!o.geometry.attributes.color });
      o.userData.muscleId = id;
      o.userData.group = map?.[id]?.exerciseMuscleGroup || null;
      list.push(o);
    });
    return list;
  }, [scene, map, theme]);

  // Frame synchronously, before the first frame is drawn, and again when
  // the canvas changes shape. The entrance starts turned in a little.
  const framedOnce = useRef(false);
  useLayoutEffect(() => {
    if (!meshes.length || !size.width || !size.height) return;
    const box = new THREE.Box3().setFromObject(scene);
    const target = box.getCenter(new THREE.Vector3());
    const dims = box.getSize(new THREE.Vector3());
    const radius = fitDistance(dims, FOV, size.width / size.height, 1.06);
    const theta = framedOnce.current
      ? new THREE.Spherical().setFromVector3(camera.position.clone().sub(target)).theta
      : START_TURN;
    camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(radius, PHI, theta)));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    if (controls) { controls.target.copy(target); controls.update(); }
    invalidate();
    onFramed?.({ target, radius, first: !framedOnce.current });
    framedOnce.current = true;
  }, [meshes, size.width, size.height, controls]); // eslint-disable-line react-hooks/exhaustive-deps

  // Paint the picked group, with one soft pulse so the tap is felt.
  useEffect(() => {
    const paint = (boost) => {
      for (const m of meshes) {
        const g = m.userData.group;
        const on = !!g && g === selectedGroup;
        const hover = !on && !!g && g === hovered;
        m.material.color.copy(theme.white);
        if (on) m.material.color.lerp(theme.hot, 0.86).multiplyScalar(1.1 + boost);
        else if (hover) m.material.color.lerp(theme.hot, 0.32);
      }
      invalidate();
    };
    if (!selectedGroup) { paint(0); return undefined; }
    const start = performance.now();
    let raf = 0;
    const step = (t) => {
      const k = Math.min(1, (t - start) / 450);
      paint(0.35 * Math.sin(Math.PI * k));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [meshes, selectedGroup, hovered, theme, invalidate]);

  return (
    <primitive
      object={scene}
      onClick={(e) => {
        if (e.delta > 8) return;      // a drag that ends over the body is not a tap
        e.stopPropagation();
        const id = e.object.userData.muscleId;
        if (map?.[id]) onPick?.(id);
      }}
      onPointerOver={(e) => {
        if (e.pointerType !== 'mouse') return;
        e.stopPropagation();
        onHover?.(e.object.userData.group);
        document.body.style.cursor = e.object.userData.group ? 'pointer' : '';
      }}
      onPointerOut={(e) => {
        if (e.pointerType !== 'mouse') return;
        onHover?.(null);
        document.body.style.cursor = '';
      }}
    />
  );
}

/** The entrance: from three-quarters round to facing you, once. That half
 *  second of motion is the "you can turn this" -- there are no buttons. */
function Entrance({ frame }) {
  const { camera, invalidate, controls } = useThree();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !frame || !controls) return undefined;
    done.current = true;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = reduce ? 0 : START_TURN;
    const start = performance.now();
    let raf = 0;
    const place = (theta) => {
      camera.position.copy(frame.target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(frame.radius, PHI, theta)));
      controls.target.copy(frame.target);
      controls.update();
      invalidate();
    };
    const step = (t) => {
      const k = Math.min(1, (t - start) / 1050);
      place(from * (1 - k) ** 4);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    place(from);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [frame, controls]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * @param labelFor  group -> the name shown ("Core", not whichever muscle
 *                  of the group happens to be first in the map)
 */
export default function MuscleBody3DImpl({ map, selectedGroup, onSelect, labelFor, compact = false }) {
  const [hovered, setHovered] = useState(null);
  const [frame, setFrame] = useState(null);
  const [moved, setMoved] = useState(false);

  const nameOf = (g) => {
    if (!g) return null;
    if (labelFor?.[g]) return labelFor[g];
    const k = map && Object.keys(map).find((id) => map[id].exerciseMuscleGroup === g);
    return k ? map[k].displayName.replace(/\s*\(.*\)$/, '') : g;
  };
  const label = nameOf(selectedGroup) || nameOf(hovered);

  return (
    <div className={`mb3d${frame ? ' is-ready' : ''}`}>
      <Stage
        interactive
        maxTier="high"
        className="mb3d__canvas"
        frameloop="demand"
        dpr={[1, 1.75]}
        camera={{ position: [0, 0.9, 6], fov: FOV, near: 0.05, far: 40 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => { gl.toneMapping = THREE.NoToneMapping; }}
      >
        <Body map={map} selectedGroup={selectedGroup} hovered={hovered}
          onHover={setHovered}
          onFramed={(f) => setFrame((cur) => cur || f)}
          onPick={(id) => { setMoved(true); onSelect?.(map[id].exerciseMuscleGroup, id, map[id].displayName); }} />
        <OrbitControls
          makeDefault
          enablePan={false}
          enableDamping
          dampingFactor={0.09}
          rotateSpeed={0.85}
          minPolarAngle={PHI}
          maxPolarAngle={PHI}
          minDistance={frame ? frame.radius * 0.38 : 0.5}
          maxDistance={frame ? frame.radius * 1.12 : 12}
          onStart={() => setMoved(true)}
        />
        <Entrance frame={frame} />
      </Stage>

      {!frame && <div className="mb3d__loading" aria-hidden="true"><span /></div>}

      {/* Top-left, clear of the body -- never over its legs. */}
      {label ? (
        <div className="mb3d__label" aria-live="polite"><i aria-hidden="true" />{label}</div>
      ) : (!moved && frame && !compact) ? (
        <div className="mb3d__hint"><Rotate3d size={14} strokeWidth={2} aria-hidden="true" />Swipe to turn</div>
      ) : null}
    </div>
  );
}

preloadBody();
