import * as THREE from 'three';
import { useRef, useEffect, useState, useCallback } from 'react';

/* ------------------------------------------------------------------ */
/*  SK OS "Focus Tunnel" backdrop                               */
/*  Adapted from a 21st.dev Three.js tunnel into the SK OS                 */
/*  visual language: ember -> gold burn points, container-based,       */
/*  reduced-motion fallback, mobile layer reduction, visibility pause. */
/*  Usage: <TunnelBackdrop /> inside a `relative overflow-hidden`      */
/*  sized container (it fills it absolutely).                          */
/* ------------------------------------------------------------------ */

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = (e) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [breakpoint]);
  return isMobile;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && !!window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e) => setReduced(e.matches);
    setReduced(mq.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduced;
}

/* ------------------------- shader (templated) ----------------------- */

const vertexShader = `void main(){ gl_Position = vec4(position, 1.0); }`;

function fragmentShader({ layers = 96, ringPoints = 128, pointA = '0.031,0.498,0.482', pointB = '0.071,0.722,0.690', speed = 0.7 }) {
  return `
uniform float iTime;
uniform vec3 iResolution;

#define TAU 6.2831853071795865
#define TUNNEL_LAYERS ${layers}
#define RING_POINTS ${ringPoints}
#define POINT_SIZE 1.8
#define POINT_COLOR_A vec3(${pointA})
#define POINT_COLOR_B vec3(${pointB})
#define SPEED ${speed}

float sq(float x){ return x*x; }

vec2 AngRep(vec2 uv, float angle){
  vec2 polar = vec2(atan(uv.y, uv.x), length(uv));
  polar.x = mod(polar.x + angle/2.0, angle) - angle/2.0;
  return polar.y * vec2(cos(polar.x), sin(polar.x));
}

float sdCircle(vec2 uv, float r){ return length(uv) - r; }

vec3 MixShape(float sd, vec3 fill, vec3 target){
  float blend = smoothstep(0.0, 1.0/iResolution.y, sd);
  return mix(fill, target, blend);
}

vec2 TunnelPath(float x){
  vec2 offs = vec2(
    0.2 * sin(TAU * x * 0.5) + 0.4 * sin(TAU * x * 0.2 + 0.3),
    0.3 * cos(TAU * x * 0.3) + 0.2 * cos(TAU * x * 0.1)
  );
  offs *= smoothstep(1.0, 4.0, x);
  return offs;
}

void main(){
  vec2 res = iResolution.xy / iResolution.y;
  vec2 uv = gl_FragCoord.xy / iResolution.y - res/2.0;
  vec3 color = vec3(0.0);
  float repAngle = TAU / float(RING_POINTS);
  float pointSize = POINT_SIZE / (2.0 * iResolution.y);
  float camZ = iTime * SPEED;
  vec2 camOffs = TunnelPath(camZ);

  for(int i = 1; i <= TUNNEL_LAYERS; i++){
    float pz = 1.0 - (float(i) / float(TUNNEL_LAYERS));
    pz -= mod(camZ, 4.0 / float(TUNNEL_LAYERS));
    vec2 offs = TunnelPath(camZ + pz) - camOffs;
    float ringRad = 0.15 * (1.0 / sq(pz * 0.8 + 0.4));
    if(abs(length(uv + offs) - ringRad) < pointSize * 1.5){
      vec2 aruv = AngRep(uv + offs, repAngle);
      float pdist = sdCircle(aruv - vec2(ringRad, 0), pointSize);
      vec3 ptColor = (mod(float(i/2), 2.0) == 0.0) ? POINT_COLOR_A : POINT_COLOR_B;
      float shade = (1.0 - pz);
      color = MixShape(pdist, ptColor * shade, color);
    }
  }

  gl_FragColor = vec4(color, 1.0);
}
`;
}

/* --------------------------- three helpers -------------------------- */

function createThreeForCanvas(canvas, width, height, shaderOpts) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Cap pixel ratio to avoid excessive GPU usage.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      iTime: { value: 0 },
      iResolution: { value: new THREE.Vector3(width, height, 1) },
    },
    vertexShader,
    fragmentShader: fragmentShader(shaderOpts),
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  return { renderer, scene, camera, material, mesh, geometry };
}

function disposeThree(ctx) {
  try {
    ctx.scene.remove(ctx.mesh);
    ctx.mesh.geometry.dispose();
    ctx.material.dispose();
    ctx.renderer.dispose();
  } catch (e) {
    // ignore disposal errors
  }
}

/* ----------------------------- component ---------------------------- */

export default function TunnelBackdrop() {
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const lastTimeRef = useRef(0);
  const animRef = useRef(null);
  const pausedRef = useRef(false);
  const rafResizeRef = useRef(false);
  const isMobile = useIsMobile();
  const reduced = usePrefersReducedMotion();

  // Mobile / low-power devices: halve the tunnel density and slow it down.
  const shaderOpts = isMobile
    ? { layers: 48, ringPoints: 96, speed: 0.45 }
    : { layers: 96, ringPoints: 128, speed: 0.7 };

  const animate = useCallback((time) => {
    if (!ctxRef.current) return;
    animRef.current = requestAnimationFrame(animate);
    if (pausedRef.current) {
      lastTimeRef.current = time;
      return;
    }
    time *= 0.001; // ms -> s
    const delta = time - (lastTimeRef.current || time);
    lastTimeRef.current = time;
    ctxRef.current.material.uniforms.iTime.value += delta * 0.5;
    ctxRef.current.renderer.render(ctxRef.current.scene, ctxRef.current.camera);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === 'undefined') return;
    // Reduced motion: never start the WebGL loop, keep the static fallback.
    if (reduced) return;

    const container = canvas.parentElement;
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    const ctx = createThreeForCanvas(canvas, width, height, shaderOpts);
    ctxRef.current = ctx;

    const resizeObserver = new ResizeObserver(() => {
      if (!ctxRef.current || rafResizeRef.current) return;
      rafResizeRef.current = true;
      requestAnimationFrame(() => {
        rafResizeRef.current = false;
        const w = container.clientWidth;
        const h = container.clientHeight;
        ctxRef.current.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        ctxRef.current.renderer.setSize(w, h, false);
        ctxRef.current.material.uniforms.iResolution.value.set(w, h, 1);
      });
    });
    resizeObserver.observe(container);

    // Pause the loop when the tab is hidden to save CPU.
    const handleVisibility = () => { pausedRef.current = !!document.hidden; };
    document.addEventListener('visibilitychange', handleVisibility);
    handleVisibility();

    animRef.current = requestAnimationFrame(animate);

    return () => {
      resizeObserver.disconnect();
      if (animRef.current) cancelAnimationFrame(animRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (ctxRef.current) {
        disposeThree(ctxRef.current);
        ctxRef.current = null;
      }
    };
  }, [animate, reduced, isMobile]);

  if (reduced) {
    // Static fallback: soft burn glow, no motion, no WebGL.
    return (
      <div
        className="absolute inset-0 overflow-hidden"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(70% 90% at 50% 115%, rgb(var(--accent-rgb) / .22), transparent 62%), radial-gradient(55% 70% at 50% -10%, rgba(8,127,123,.14), transparent 60%)',
        }}
      />
    );
  }

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" id="tunnel-canvas" />
    </div>
  );
}
