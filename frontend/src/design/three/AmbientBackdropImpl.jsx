/**
 * AmbientBackdrop implementation — the 3D half.
 *
 * LOADED ONLY VIA React.lazy FROM ./AmbientBackdrop.jsx. Nothing should
 * import this statically; doing so pulls three.js (~500 kB) into the
 * importer's chunk and defeats the code-splitting. See the long note at
 * the top of AmbientBackdrop.jsx for the measured cost of getting this
 * wrong.
 *
 * Everything three-free (palette, fallback, WebGL + visibility gating)
 * already happened in the wrapper; this file assumes 3D is wanted and
 * simply composes Stage + scene.
 */
import { lazy } from 'react';
import Stage from './Stage.jsx';
import { GradientFallback } from './AmbientBackdrop.jsx';

// Scenes stay individually lazy so adding a second scene does not make
// the first one's chunk bigger.
const AuroraField = lazy(() => import('./scenes/AuroraField.jsx'));

export default function AmbientBackdropImpl({
  palette,
  intensity = 0.5,
  maxTier = 'medium',   // a BACKDROP should not claim the high-tier budget;
                        // the interface in front of it needs those frames
  ...rest
}) {
  return (
    <Stage
      className="absolute inset-0"
      fallback={<GradientFallback palette={palette} />}
      interactive={false}
      maxTier={maxTier}
      camera={{ position: [0, 0, 6], fov: 50 }}
      style={{ opacity: intensity }}
      {...rest}
    >
      <AuroraField color={palette.accent} accentDeep={palette.accentDeep} />
    </Stage>
  );
}
