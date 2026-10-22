/**
 * The 3D half of MarkStage. Loaded only through MarkStage's React.lazy --
 * importing this statically would pull three.js into the sign-in bundle.
 */
import Stage from '../../design/three/Stage.jsx';
import BarbellMark, { CAMERA } from '../../design/three/scenes/BarbellMark.jsx';

export default function MarkStageImpl({ slotRef, startAt, accent, onReady }) {
  return (
    <Stage className="absolute inset-0" interactive={false} maxTier="high" camera={CAMERA}>
      <BarbellMark slotRef={slotRef} startAt={startAt} accent={accent} onReady={onReady} />
    </Stage>
  );
}
