/**
 * MuscleBody3DImpl -- the 3D muscle picker (v2 body).
 *
 * The model is one continuous sculpted body built from Z-Anatomy geometry
 * (scripts/anatomy/build_body_v2_stage_*.py): every superficial muscle plus
 * the skull, hands and feet, fused into a single surface, then cut back
 * into tappable regions -- "<muscleId>.l" / "<muscleId>.r" -- and "body"
 * for everything that is not a muscle group in the exercise library.
 * Soft shadow is baked into the vertex colours, so it reads as a sculpt.
 *
 *  - Turn it with a finger: swipe sideways and it spins like a turntable,
 *    with momentum. Up and down is left to the page (touch-action: pan-y
 *    in anatomy.css), so a body inside a scrolling sheet never traps the
 *    scroll. A mouse wheel zooms.
 *  - Tap a muscle: the whole group lights up, both sides, and onSelect
 *    reports it. A drag never counts as a tap.
 *  - It only draws while something moves (frameloop "demand"): a still
 *    body costs nothing, which is the difference between a premium feel
 *    and a phone that runs hot.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Rotate3d } from 'lucide-react';
import { useGLTF, OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import Stage from '../../design/three/Stage.jsx';
import './anatomy.css';

export const BODY_URL = '/assets/anatomy/skos-body-v2.glb';

// The model is Draco-compressed; the decoder is served from our own origin
// (frontend/public/draco/) because the CSP does not allow Google's CDN.
useGLTF.setDecoderPath('/draco/');

/**
 * The muscle a mesh belongs to. Names are "<muscleId>.l" / ".r" in the
 * file, but three's GLTFLoader sanitizes node names and DROPS THE DOT
 * ("pectoralis_major.l" arrives as "pectoralis_majorl"), so a plain
 * ".l" strip matched nothing and no tap ever reached a muscle.
 */
function muscleIdOf(name, map) {
  const n = String(name || '');
  const dotted = n.replace(/\.[lr]$/i, '');
  if (map?.[dotted]) return dotted;
  const bare = n.replace(/[._]?[lr]$/i, '');
  if (map?.[bare]) return bare;
  return dotted;
}

function cssColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return new THREE.Color(v || fallback);
  } catch { return new THREE.Color(fallback); }
}
const isDark = () => document.documentElement.classList.contains('dark');

/**
 * THE CLAY: a matcap, drawn here on a canvas -- the technique a ZBrush
 * anatomy render uses. Lighting lives in a small picture of a lit sphere,
 * read by the surface's direction to the camera, so the body looks studio-
 * lit from every angle with no lights, shadows or environment to compute.
 * Cheaper than real lighting, and the soft occlusion baked into the model's
 * vertex colours does the rest.
 */
function makeMatcap(dark) {
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
  // body of the sphere: lit from high on the left, falling into shadow low right
  sphere(r * 0.72, r * 0.6, r * 1.55, [
    [0, `rgb(${base.map((v) => Math.min(255, v + 58)).join(',')})`],
    [0.45, `rgb(${base.join(',')})`],
    [0.85, `rgb(${base.map((v) => Math.round(v * 0.42)).join(',')})`],
    [1, `rgb(${base.map((v) => Math.round(v * 0.3)).join(',')})`],
  ]);
  g.globalCompositeOperation = 'lighter';
  // soft specular sheen
  sphere(r * 0.62, r * 0.5, r * 0.55, [[0, 'rgba(255,248,240,.22)'], [1, 'rgba(255,248,240,0)']]);
  // cool rim from behind on the right edge
  const rim = g.createRadialGradient(r, r, r * 0.78, r, r, r);
  rim.addColorStop(0, 'rgba(0,0,0,0)');
  rim.addColorStop(0.75, 'rgba(150,170,205,.0)');
  rim.addColorStop(1, 'rgba(150,170,205,.32)');
  g.fillStyle = rim;
  g.beginPath(); g.arc(r, r, r, -Math.PI * 0.55, Math.PI * 0.35); g.lineTo(r, r); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function Body({ map, selectedGroup, hovered, onPick, onHover, onReady }) {
  const { scene } = useGLTF(BODY_URL);
  const { invalidate } = useThree();
  const theme = useMemo(() => ({
    matcap: makeMatcap(isDark()),
    white: new THREE.Color(1, 1, 1),
    // The muscle you picked glows in the app's warm "effort" red: clearly
    // a muscle, clearly picked, in either theme.
    hot: cssColor('--m-energy', '#D97B84'),
  }), []);
  useEffect(() => () => theme.matcap.dispose(), [theme]);

  // One material per region, so lighting one group never touches another.
  const meshes = useMemo(() => {
    const list = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const id = muscleIdOf(o.name, map);
      o.material = new THREE.MeshMatcapMaterial({
        matcap: theme.matcap,
        color: theme.white.clone(),
        vertexColors: !!o.geometry.attributes.color,
      });
      o.userData.muscleId = id;
      o.userData.group = map?.[id]?.exerciseMuscleGroup || null;
      list.push(o);
    });
    return list;
  }, [scene, map, theme]);

  useEffect(() => { if (meshes.length) onReady?.(scene); }, [meshes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Paint the picked group, with one soft pulse so the tap is felt; it
  // renders frames only for those ~0.45 s.
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
        // A drag that ends over the body is not a tap.
        if (e.delta > 8) return;
        e.stopPropagation();
        const id = e.object.userData.muscleId;
        if (map?.[id]) onPick?.(id);
      }}
      onPointerOver={(e) => {
        if (e.pointerType !== 'mouse') return;
        e.stopPropagation();
        onHover?.(e.object.userData.group);
        document.body.style.cursor = e.object.userData.group ? 'pointer' : 'grab';
      }}
      onPointerOut={(e) => {
        if (e.pointerType !== 'mouse') return;
        onHover?.(null);
        document.body.style.cursor = '';
      }}
    />
  );
}

/**
 * The entrance: the body turns in from three-quarters to face you, once.
 * That half-second of motion is the "you can turn this" -- no buttons.
 */
function Entrance({ controlsRef, frame, onDone }) {
  const { camera, invalidate } = useThree();
  useEffect(() => {
    const c = controlsRef.current;
    if (!c || !frame) return undefined;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const phi = Math.PI / 2.15;
    const from = reduce ? 0 : 0.95;
    const start = performance.now();
    let raf = 0;
    const place = (theta) => {
      camera.position.copy(frame.target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(frame.radius, phi, theta)));
      c.target.copy(frame.target);
      c.update();
      invalidate();
    };
    const step = (t) => {
      const k = Math.min(1, (t - start) / 1100);
      const e = 1 - (1 - k) ** 4;
      place(from * (1 - e));
      if (k < 1) raf = requestAnimationFrame(step); else onDone?.();
    };
    place(from);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [frame]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * @param labelFor  group -> name shown on the body ("Core", not whichever
 *                  muscle of the group happens to be first in the map)
 */
export default function MuscleBody3DImpl({ map, selectedGroup, onSelect, labelFor, compact = false }) {
  const [hovered, setHovered] = useState(null);
  const [frame, setFrame] = useState(null);
  const [moved, setMoved] = useState(false);
  const controlsRef = useRef(null);

  const onReady = (scene) => {
    const box = new THREE.Box3().setFromObject(scene);
    const target = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // Far enough to see head to feet in a short, wide panel.
    setFrame({ target, radius: size.y * 1.62 });
  };

  const nameOf = (g) => {
    if (!g) return null;
    if (labelFor?.[g]) return labelFor[g];
    const k = map && Object.keys(map).find((id) => map[id].exerciseMuscleGroup === g);
    return k ? map[k].displayName.replace(/\s*\(.*\)$/, '') : g;
  };
  const label = nameOf(selectedGroup);
  const hoverLabel = nameOf(hovered);

  return (
    <div className="mb3d">
      <Stage
        interactive
        maxTier="high"
        className="mb3d__canvas"
        frameloop="demand"
        dpr={[1, 1.75]}
        camera={{ position: [0, 1, 3.4], fov: 32, near: 0.05, far: 30 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => { gl.toneMapping = THREE.NoToneMapping; }}
      >
        <Body map={map} selectedGroup={selectedGroup} hovered={hovered}
          onHover={setHovered} onReady={onReady}
          onPick={(id) => { setMoved(true); onSelect?.(map[id].exerciseMuscleGroup, id, map[id].displayName); }} />
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enablePan={false}
          enableDamping
          dampingFactor={0.09}
          rotateSpeed={0.85}
          minPolarAngle={Math.PI / 2.15}
          maxPolarAngle={Math.PI / 2.15}
          minDistance={frame ? frame.radius * 0.35 : 1}
          maxDistance={frame ? frame.radius * 1.1 : 8}
          target={frame ? frame.target : undefined}
          onStart={() => setMoved(true)}
        />
        {frame && <Entrance controlsRef={controlsRef} frame={frame} />}
      </Stage>

      {!frame && <div className="mb3d__loading" aria-hidden="true"><span /></div>}

      {(label || hoverLabel) ? (
        <div className="mb3d__label" aria-live="polite"><i aria-hidden="true" />{label || hoverLabel}</div>
      ) : (!moved && frame && !compact) ? (
        <div className="mb3d__hint"><Rotate3d size={15} strokeWidth={2} aria-hidden="true" />Swipe to turn · tap a muscle</div>
      ) : null}
    </div>
  );
}

useGLTF.preload(BODY_URL);
