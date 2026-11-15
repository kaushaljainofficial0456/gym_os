/**
 * Today's muscles on the 3D body -- the Workout page hero.
 *
 * The same sculpted model as the muscle picker, shown front and back side
 * by side in ONE canvas: two clones of the scene that share its geometry
 * (so the memory is the model once), each with its own materials. The
 * muscles today's session works glow in the same warm red as a picked
 * muscle. It is a picture, not a control: it draws once, then never again
 * until the session changes (frameloop "demand"), and it stays mounted
 * while scrolled away so coming back never rebuilds it (keepMounted).
 */
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import Stage from '../../design/three/Stage.jsx';
import { BODY_URL, muscleIdOf, matcapFor, hotColor, isDark, groupsForMuscles } from './bodyModel.js';

const FOV = 24;

function Pair({ map, groups, onReady }) {
  const { scene } = useGLTF(BODY_URL);
  const { camera, size, invalidate } = useThree();
  const theme = useMemo(() => ({ matcap: matcapFor(isDark()), white: new THREE.Color(1, 1, 1), hot: hotColor() }), []);

  const { front, back, dims } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const d = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const make = () => {
      const s = scene.clone(true);
      s.position.sub(c);                       // centre each at the origin
      s.traverse((o) => {
        if (!o.isMesh) return;
        const id = muscleIdOf(o.name, map);
        o.userData.group = map?.[id]?.exerciseMuscleGroup || null;
        o.material = new THREE.MeshMatcapMaterial({ matcap: theme.matcap, color: theme.white.clone(), vertexColors: !!o.geometry.attributes.color });
        o.raycast = () => {};                  // a picture: nothing to hit
      });
      return s;
    };
    return { front: make(), back: make(), dims: d };
  }, [scene, map, theme]);

  const gap = dims.x * 0.06;
  const offset = dims.x / 2 + gap / 2;

  // Light up today's muscles on both figures.
  useEffect(() => {
    for (const root of [front, back]) {
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.material.color.copy(theme.white);
        if (o.userData.group && groups.has(o.userData.group)) o.material.color.lerp(theme.hot, 0.86).multiplyScalar(1.08);
      });
    }
    invalidate();
  }, [front, back, groups, theme, invalidate]);

  // Frame both figures before the first frame, for this canvas's shape.
  useLayoutEffect(() => {
    if (!size.width || !size.height) return;
    const t = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const aspect = size.width / size.height;
    const halfH = (dims.y / 2) * 1.04;
    const halfW = ((dims.x * 2 + gap) / 2) * 1.04;
    const dist = Math.max(halfH / t, halfW / (t * aspect)) + dims.z / 2;
    camera.position.set(0, dims.y * 0.02, dist);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    invalidate();
  }, [size.width, size.height, dims, gap]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the page once the first real frame is on screen, so the flat
  // figures it shows meanwhile can step aside without a blank moment.
  useEffect(() => {
    let a = 0; let b = 0;
    a = requestAnimationFrame(() => { b = requestAnimationFrame(() => onReady?.()); });
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* Each clone carries its own centring offset, so the placement
          lives on a wrapping group rather than overwriting it. */}
      <group position={[-offset, 0, 0]}><primitive object={front} /></group>
      <group position={[offset, 0, 0]} rotation={[0, Math.PI, 0]}><primitive object={back} /></group>
    </>
  );
}

export default function BodyPreview3DImpl({ map, muscles, onReady }) {
  const groups = useMemo(() => groupsForMuscles(muscles), [muscles]);
  return (
    <Stage
      className="wk-body3d__canvas"
      frameloop="demand"
      keepMounted
      dpr={[1, 2]}
      camera={{ position: [0, 0, 8], fov: FOV, near: 0.05, far: 40 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'default' }}
      onCreated={({ gl }) => { gl.toneMapping = THREE.NoToneMapping; }}
    >
      {map && <Pair map={map} groups={groups} onReady={onReady} />}
    </Stage>
  );
}
