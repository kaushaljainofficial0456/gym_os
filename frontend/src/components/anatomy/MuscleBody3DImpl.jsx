/**
 * MuscleBody3DImpl — the actual 3D muscle picker.
 *
 * Loads frontend/public/assets/anatomy/skos-muscular-body.glb (isolated,
 * decimated Z-Anatomy geometry -- see docs/anatomy-asset.md), attaches a
 * click/hover handler to every mesh, tints the selected/hovered muscle(s)
 * using the app's own --accent token (read live so it follows the trainer
 * theme, not a hardcoded colour), and exposes front/rear/360 camera control.
 *
 * Mesh names in the GLB are "<muscleId>.l" / "<muscleId>.r" (see
 * skos-muscle-map.json, keyed by muscleId without the side suffix) --
 * clicking either side reports the same exerciseMuscleGroup.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGLTF, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import Stage from '../../design/three/Stage.jsx';

const GLB_URL = '/assets/anatomy/skos-muscular-body.glb';

const stripSide = (name) => name.replace(/\.[lr]$/i, '');

function readCssColor(varName, fallbackHex) {
  if (typeof document === 'undefined') return new THREE.Color(fallbackHex);
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  try {
    return new THREE.Color(v || fallbackHex);
  } catch {
    return new THREE.Color(fallbackHex);
  }
}

function Body({ map, selectedGroup, onSelect, hovered, setHovered, onReady }) {
  const { scene } = useGLTF(GLB_URL);

  // Give every mesh its OWN material instance (the GLB ships one shared
  // material) so tinting one muscle never affects its siblings, and tag it
  // with the muscle-map entry it resolves to.
  const meshes = useMemo(() => {
    const list = [];
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.material = obj.material.clone();
      obj.userData.muscleId = stripSide(obj.name);
      obj.userData.baseColor = obj.material.color.clone();
      list.push(obj);
    });
    return list;
  }, [scene]);

  useEffect(() => {
    if (meshes.length) onReady?.(scene, meshes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshes]);

  const accent = useMemo(() => readCssColor('--accent', '#E07A63'), []);

  useEffect(() => {
    for (const mesh of meshes) {
      const info = map?.[mesh.userData.muscleId];
      const group = info?.exerciseMuscleGroup;
      const isSelected = selectedGroup && group === selectedGroup;
      const isHovered = hovered && group === hovered;
      if (isSelected) {
        mesh.material.emissive = accent;
        mesh.material.emissiveIntensity = 0.55;
      } else if (isHovered) {
        mesh.material.emissive = accent;
        mesh.material.emissiveIntensity = 0.25;
      } else {
        mesh.material.emissive = new THREE.Color(0, 0, 0);
        mesh.material.emissiveIntensity = 0;
      }
    }
  }, [meshes, map, selectedGroup, hovered, accent]);

  const handleClick = (e) => {
    e.stopPropagation();
    const id = stripSide(e.object.name);
    const info = map?.[id];
    if (!info) return;
    onSelect?.(info.exerciseMuscleGroup, id, info.displayName);
  };

  const handleOver = (e) => {
    e.stopPropagation();
    const info = map?.[stripSide(e.object.name)];
    if (info) setHovered(info.exerciseMuscleGroup);
    document.body.style.cursor = 'pointer';
  };
  const handleOut = (e) => {
    e.stopPropagation();
    setHovered(null);
    document.body.style.cursor = 'auto';
  };

  return <primitive object={scene} onClick={handleClick} onPointerOver={handleOver} onPointerOut={handleOut} />;
}

function CameraRig({ controlsRef, target, radius, view }) {
  useEffect(() => {
    if (!view || !controlsRef.current || !radius) return;
    const controls = controlsRef.current;
    const camera = controls.object;
    const azimuth = view === 'rear' ? Math.PI : 0;
    const polar = Math.PI / 2.35; // a touch above horizontal, not top-down
    const spherical = new THREE.Spherical(radius, polar, azimuth);
    const offset = new THREE.Vector3().setFromSpherical(spherical);
    camera.position.copy(target).add(offset);
    controls.target.copy(target);
    controls.update();
  }, [view, controlsRef, target, radius]);
  return null;
}

export default function MuscleBody3DImpl({ map, selectedGroup, onSelect }) {
  const [hovered, setHovered] = useState(null);
  const [view, setView] = useState('front');
  const [frame, setFrame] = useState(null); // { target: Vector3, radius }
  const controlsRef = useRef(null);

  const handleReady = (scene) => {
    const box = new THREE.Box3().setFromObject(scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 1.6 || 3;
    setFrame({ target: center, radius });
  };

  return (
    <div className="relative w-full h-full">
      <Stage
        interactive
        maxTier="high"
        className="w-full h-full"
        camera={{ position: [0, 1.2, 3], fov: 40 }}
      >
        {/* Studio 3-point setup -- the grey clay material (see
            scripts/anatomy/process_and_export.py) reads flat under a plain
            ambient+key pair; the added rim light is what actually separates
            the sculpted edges from the panel background. */}
        <ambientLight intensity={0.5} />
        <directionalLight position={[3, 5, 4]} intensity={1.15} />
        <directionalLight position={[-3, 2, -3]} intensity={0.4} />
        <directionalLight position={[0, 2.5, -4]} intensity={0.6} />
        <Body map={map} selectedGroup={selectedGroup} onSelect={onSelect} hovered={hovered} setHovered={setHovered} onReady={handleReady} />
        <OrbitControls
          ref={controlsRef}
          enablePan={false}
          minDistance={frame ? frame.radius * 0.4 : 1}
          maxDistance={frame ? frame.radius * 2 : 8}
          target={frame ? frame.target : undefined}
        />
        {frame && <CameraRig controlsRef={controlsRef} target={frame.target} radius={frame.radius} view={view} />}
      </Stage>

      {/* front/rear snap controls -- 360 free rotation still works via drag */}
      <div className="absolute top-2 right-2 flex gap-1 z-10">
        {['front', 'rear'].map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`chip !text-[10px] border capitalize ${view === v ? 'bg-gold/20 border-gold/40 text-gold' : 'border-line text-mute bg-panel/80'}`}
          >
            {v}
          </button>
        ))}
      </div>

      {hovered && (
        <div className="absolute bottom-2 left-2 chip !text-[10px] border-line bg-panel/90 text-ink pointer-events-none">
          {map?.[Object.keys(map).find((k) => map[k].exerciseMuscleGroup === hovered)]?.displayName || hovered}
        </div>
      )}
    </div>
  );
}

useGLTF.preload(GLB_URL);
