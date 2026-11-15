/**
 * Today's muscles, on the 3D body (BodyPreview3DImpl), front and back.
 *
 * The flat figures (BodyFocus) are drawn first, in the same box, so there
 * is never an empty space or a jump: the 3D body fades in over them once
 * its first frame is on screen. With the model already fetched in the
 * background (prefetchBody), that is a moment after the page appears.
 */
import { lazy, Suspense, useState } from 'react';
import BodyFocus from './BodyFocus.jsx';
import { hasWebGL } from '../../design/three/webgl.js';
import { useMuscleMap } from '../anatomy/MuscleBody3D.jsx';

const Impl = lazy(() => import('../anatomy/BodyPreview3DImpl.jsx'));

export default function BodyFocus3D({ muscles = [] }) {
  const [ready, setReady] = useState(false);
  const [use3D] = useState(() => hasWebGL());
  const map = useMuscleMap();
  return (
    <div className={`wk-body3d${ready ? ' is-ready' : ''}`} aria-hidden="true">
      <div className="wk-body3d__flat"><BodyFocus muscles={muscles} /></div>
      {use3D && map && (
        <Suspense fallback={null}>
          <Impl map={map} muscles={muscles} onReady={() => setReady(true)} />
        </Suspense>
      )}
    </div>
  );
}
