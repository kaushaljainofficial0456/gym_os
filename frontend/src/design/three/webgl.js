/**
 * WebGL capability check — deliberately in its OWN module with no three.js
 * or R3F import.
 *
 * WHY IT IS SPLIT OUT: this has to be callable BEFORE deciding whether to
 * download the 3D bundle. If it lived in Stage.jsx (which imports
 * `Canvas` from @react-three/fiber), merely asking "can this device do
 * WebGL?" would drag ~500 kB of three.js into the caller's chunk — which
 * is precisely the bug this file's existence prevents. Measured: the
 * first build of this design system shipped 509 kB gzipped in the entry
 * chunk instead of 224 kB for exactly that reason.
 */
let _webglOk = null;

export function hasWebGL() {
  if (_webglOk !== null) return _webglOk;
  if (typeof document === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    _webglOk = !!(
      window.WebGLRenderingContext &&
      (c.getContext('webgl') || c.getContext('experimental-webgl'))
    );
  } catch {
    // Some hardened/embedded browsers throw rather than returning null.
    _webglOk = false;
  }
  return _webglOk;
}
