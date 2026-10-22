/**
 * BARBELL MARK — the brand badge as a real object, lit like a product shot.
 *
 * Not a toy version of the logo: an Olympic bar in proportion -- a brushed
 * steel grip, polished collars and sleeves, satin black bumper plates with
 * steel hub inserts and a fine rubber grain -- held inside a bevelled band
 * of champagne metal. It assembles on the intro's beats (the band sweeps
 * clockwise from 12, the bar draws out, the plates rise onto the sleeves)
 * and then turns slowly at a three-quarter angle, leaning toward the
 * pointer or the tilt of a phone.
 *
 * LIGHT IS THE WHOLE LOOK. Metal has no colour of its own; it shows what
 * surrounds it. So the scene builds its own photo studio once at mount --
 * a large warm softbox overhead, a tall one to the left, a narrow rim
 * light behind, a soft key from the front -- and renders it into a PMREM
 * environment. No HDR download (the CSP would refuse one anyway).
 * Khronos PBR Neutral tone mapping keeps the materials' real colours
 * instead of ACES's crushed, oversaturated look.
 *
 * The mark is not positioned by this file: it reads the DOM slot the page
 * reserved for it and fits itself to that box every frame, so CSS owns the
 * layout and the mark glides with it when the stage folds away.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

export const CAMERA = { position: [0, 0, 9], fov: 28 };

const R = 1.58;                  // band radius, world units at scale 1
const BAND_W = 0.1;              // radial width
const BAND_D = 0.15;             // depth
const BAND_SEGMENTS = 220;
const GRIP = 0.4;                // grip half-length
const SLEEVE_END = 0.99;
const PLATES = [
  { x: 0.522, r: 0.66, t: 0.17, at: 0.55 },
  { x: 0.675, r: 0.44, t: 0.13, at: 0.66 },
];
const FIT = R + BAND_W / 2;

/* CSS cubic-bezier, so the 3D keeps the SVG mark's and the intro's timing. */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i += 1) {
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (sx(t) - x) / d;
    }
    return sy(Math.min(1, Math.max(0, t)));
  };
}
const inOut = bezier(0.65, 0, 0.35, 1);
const out = bezier(0.16, 1, 0.3, 1);
const phase = (t, start, dur, ease) => ease(Math.min(1, Math.max(0, (t - start) / dur)));
const v2 = (pts) => pts.map(([x, y]) => new THREE.Vector2(x, y));

/** A solid of revolution about the bar's axis (x). */
function aroundBar(points, segments = 64) {
  const g = new THREE.LatheGeometry(v2(points), segments);
  g.rotateZ(-Math.PI / 2);
  return g;
}

/** Bevelled band, swept clockwise from 12 o'clock: drawing the first N
 *  segments sweeps the way the intro's ring does. */
function bandGeometry() {
  const a = R - BAND_W / 2, b = R + BAND_W / 2, h = BAND_D / 2, e = 0.018;
  const g = new THREE.LatheGeometry(v2([
    [a, -h + e], [a + e, -h], [b - e, -h], [b, -h + e],
    [b, h - e], [b - e, h], [a + e, h], [a, h - e], [a, -h + e],
  ]), BAND_SEGMENTS);
  g.rotateX(-Math.PI / 2);       // phi 0 at the top, increasing clockwise
  return g;
}

/** Bumper plate: recessed faces, a raised rounded rim. */
function plateGeometry(r, t) {
  const h = t / 2, hub = 0.152, face = h * 0.84;
  return aroundBar([
    [hub, -face], [hub + 0.02, -face], [r * 0.87, -face], [r * 0.91, -h], [r - 0.03, -h],
    [r - 0.008, -h + 0.014], [r, -h + 0.034], [r, h - 0.034], [r - 0.008, h - 0.014], [r - 0.03, h],
    [r * 0.91, h], [r * 0.87, face], [hub + 0.02, face], [hub, face], [hub, -face],
  ], 96);
}

/** Steel hub insert, a touch proud of the plate's face. */
function hubGeometry(t) {
  const h = t / 2 * 0.92, r0 = 0.076, r1 = 0.158;
  return aroundBar([[r0, -h], [r1 - 0.01, -h], [r1, -h + 0.01], [r1, h - 0.01], [r1 - 0.01, h], [r0, h], [r0, -h]], 64);
}

/** The bar: knurled grip, collar flanges, sleeves with chamfered ends. */
function barGeometries() {
  const grip = aroundBar([[0, -GRIP], [0.04, -GRIP], [0.04, GRIP], [0, GRIP]], 48);
  const flange = (x) => aroundBar([[0.04, x - 0.02], [0.098, x - 0.02], [0.104, x - 0.012], [0.104, x + 0.012], [0.098, x + 0.02], [0.04, x + 0.02]], 64);
  const sleeve = (s) => aroundBar(s > 0
    ? [[0, GRIP + 0.02], [0.071, GRIP + 0.02], [0.071, SLEEVE_END - 0.012], [0.062, SLEEVE_END], [0, SLEEVE_END]]
    : [[0, -SLEEVE_END], [0.062, -SLEEVE_END], [0.071, -SLEEVE_END + 0.012], [0.071, -GRIP - 0.02], [0, -GRIP - 0.02]], 64);
  const clip = (x) => aroundBar([[0.07, x - 0.018], [0.09, x - 0.018], [0.094, x], [0.09, x + 0.018], [0.07, x + 0.018]], 48);
  return {
    grip,
    polished: [flange(-GRIP - 0.0), flange(GRIP + 0.0), sleeve(-1), sleeve(1), clip(-0.765), clip(0.765)],
  };
}

/** Fine grain for the rubber, and a hairline knurl for the grip. */
function noiseTexture(size, fn) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = fn(x, y);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** The studio, rendered once into a prefiltered environment map. */
function buildStudio(gl, accent) {
  const room = new THREE.Scene();
  room.background = new THREE.Color('#050505');
  const plane = new THREE.PlaneGeometry(1, 1);
  const mats = [];
  const softbox = (color, intensity, pos, size) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide });
    mats.push(m);
    const mesh = new THREE.Mesh(plane, m);
    mesh.position.set(...pos);
    mesh.scale.set(size[0], size[1], 1);
    mesh.lookAt(0, 0, 0);
    room.add(mesh);
  };
  softbox('#fff3e8', 3.0, [0, 6, 2], [7, 4]);          // warm softbox overhead
  softbox('#ffffff', 4.2, [-6, 1, 2.5], [2.2, 6]);     // tall softbox, left
  softbox('#f4ece6', 1.5, [3, 1.5, 7], [4, 2.5]);      // soft key, front right
  softbox(accent, 2.2, [5.5, -0.5, -1], [0.6, 6]);     // narrow rim, right, in the theme's tint
  softbox('#ffffff', 4.5, [0, 3.5, -6], [9, 1.1]);     // rim from behind, top edges
  softbox('#fff6ef', 3.2, [-4.5, 1, -4.5], [1.2, 5]);  // rim from behind-left, plate silhouettes
  softbox('#2a2522', 1.0, [0, -6, 1], [9, 5]);         // dim warm floor bounce
  const pmrem = new THREE.PMREMGenerator(gl);
  const target = pmrem.fromScene(room, 0.02);
  pmrem.dispose();
  plane.dispose();
  mats.forEach((m) => m.dispose());
  return target;
}

/** Pointer (desktop) and device tilt (phones), as a [-1, 1] pair. */
function useLean() {
  const lean = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e) => {
      lean.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      lean.current.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    let base = null;
    const onTilt = (e) => {
      if (e.gamma == null || e.beta == null) return;
      if (!base) base = { g: e.gamma, b: e.beta };
      lean.current.x = Math.max(-1, Math.min(1, (e.gamma - base.g) / 25));
      lean.current.y = Math.max(-1, Math.min(1, (e.beta - base.b) / 25));
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    // Android delivers orientation without asking; iOS needs a permission
    // prompt a sign-in screen has no business showing -- there the mark
    // keeps its own slow turn.
    window.addEventListener('deviceorientation', onTilt, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('deviceorientation', onTilt);
    };
  }, []);
  return lean;
}

export default function BarbellMark({ slotRef, startAt = 0, accent = '#B4C2CE', onReady }) {
  const { gl, scene } = useThree();
  const mark = useRef(null);
  const bar = useRef(null);
  const plates = useRef([]);
  const lean = useLean();
  const sm = useRef({ x: 0, y: 0, s: 0, lx: 0, ly: 0, fitted: false });
  const frames = useRef(0);

  const geo = useMemo(() => ({
    band: bandGeometry(),
    bar: barGeometries(),
    plates: PLATES.map((p) => plateGeometry(p.r, p.t)),
    hubs: PLATES.map((p) => hubGeometry(p.t)),
  }), []);

  const mats = useMemo(() => {
    const grain = noiseTexture(128, () => 118 + Math.random() * 40);
    grain.repeat.set(26, 3);
    const knurl = noiseTexture(64, (x, y) => (((x + y) % 4 < 2) !== ((x - y + 64) % 4 < 2) ? 200 : 70));
    knurl.repeat.set(10, 16);
    return {
      band: new THREE.MeshPhysicalMaterial({ color: '#efe0cf', metalness: 1, roughness: 0.2, envMapIntensity: 1.15 }),
      grip: new THREE.MeshPhysicalMaterial({ color: '#b9bcbf', metalness: 1, roughness: 0.38, bumpMap: knurl, bumpScale: 0.6 }),
      polished: new THREE.MeshPhysicalMaterial({ color: '#e7e8ea', metalness: 1, roughness: 0.12 }),
      plate: new THREE.MeshPhysicalMaterial({
        color: '#171615', metalness: 0, roughness: 0.55, bumpMap: grain, bumpScale: 0.35,
        clearcoat: 0.35, clearcoatRoughness: 0.38,
      }),
      hub: new THREE.MeshPhysicalMaterial({ color: '#d9dadc', metalness: 1, roughness: 0.2 }),
    };
  }, []);

  useEffect(() => {
    gl.toneMapping = THREE.NeutralToneMapping;
    gl.toneMappingExposure = 1.05;
    Object.values(mats).forEach((m) => { m.needsUpdate = true; });
    const env = buildStudio(gl, accent);
    scene.environment = env.texture;
    return () => { scene.environment = null; env.dispose(); };
  }, [gl, scene, accent, mats]);

  useEffect(() => () => {
    geo.band.dispose(); geo.bar.grip.dispose(); geo.bar.polished.forEach((g) => g.dispose());
    geo.plates.forEach((g) => g.dispose()); geo.hubs.forEach((g) => g.dispose());
    Object.values(mats).forEach((m) => { m.bumpMap?.dispose(); m.dispose(); });
  }, [geo, mats]);

  const perSegment = 8 * 6;      // band profile: 9 points -> 8 quads per segment
  const drawn = useRef(-1);
  const viewH = 2 * CAMERA.position[2] * Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2));

  useFrame((state, dt) => {
    const g = mark.current;
    if (!g) return;
    const t = (performance.now() - startAt) / 1000;
    const step = Math.min(dt, 0.05);

    // ── assemble, on the intro's beats ──
    const sweep = Math.round(phase(t, 0.15, 0.9, inOut) * BAND_SEGMENTS) * perSegment;
    if (sweep !== drawn.current) { geo.band.setDrawRange(0, sweep); drawn.current = sweep; }
    if (bar.current) bar.current.scale.x = Math.max(0.0001, phase(t, 0.3, 0.65, inOut));
    plates.current.forEach((p, i) => {
      if (!p) return;
      const s = Math.max(0.0001, phase(t, PLATES[i >> 1].at, 0.5, out));
      p.scale.set(1, s, s);
    });

    // ── fit the DOM slot ──
    const s = sm.current;
    const slot = slotRef?.current;
    if (slot) {
      const a = slot.getBoundingClientRect();
      const b = gl.domElement.getBoundingClientRect();
      if (a.width > 0 && b.height > 0) {
        const u = viewH / b.height;
        const tx = (a.left + a.width / 2 - (b.left + b.width / 2)) * u;
        const ty = -(a.top + a.height / 2 - (b.top + b.height / 2)) * u;
        const ts = ((a.width / 2) * u) / FIT;
        if (!s.fitted) { s.x = tx; s.y = ty; s.s = ts; s.fitted = true; }
        const k = 1 - Math.exp(-step * 9);
        s.x += (tx - s.x) * k; s.y += (ty - s.y) * k; s.s += (ts - s.s) * k;
      }
    }

    // ── a slow three-quarter turn, leaning toward the viewer ──
    const time = state.clock.elapsedTime;
    const kl = 1 - Math.exp(-step * 2);
    s.lx += (lean.current.x - s.lx) * kl;
    s.ly += (lean.current.y - s.ly) * kl;
    const settle = phase(t, 0.4, 1.6, out);
    g.rotation.set(
      0.1 * settle + Math.sin(time * 0.31) * 0.035 - s.ly * 0.16,
      (-0.46 + Math.sin(time * 0.21) * 0.2) * settle + s.lx * 0.3,
      0,
    );
    g.position.set(s.x, s.y + Math.sin(time * 0.8) * 0.025 * s.s, 0);
    g.scale.setScalar(s.s || 0.0001);

    frames.current += 1;
    if (frames.current === 3) onReady?.();
  });

  return (
    <>
    <directionalLight position={[3, 5, 6]} intensity={0.6} color="#fff4ea" />
    <group ref={mark}>
      <mesh geometry={geo.band} material={mats.band} />
      <group ref={bar}>
        <mesh geometry={geo.bar.grip} material={mats.grip} />
        {geo.bar.polished.map((g2, i) => <mesh key={i} geometry={g2} material={mats.polished} />)}
      </group>
      {PLATES.flatMap((p, i) => [-1, 1].map((side, j) => (
        <group key={`${i}${side}`} position={[side * p.x, 0, 0]} ref={(el) => { plates.current[i * 2 + j] = el; }}>
          <mesh geometry={geo.plates[i]} material={mats.plate} />
          <mesh geometry={geo.hubs[i]} material={mats.hub} />
        </group>
      )))}
    </group>
    </>
  );
}
