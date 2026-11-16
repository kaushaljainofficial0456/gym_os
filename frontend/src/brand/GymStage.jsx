/**
 * The sign-in stage's brand when a gym is being shown: the gym's mark and
 * name, "× Barbell" beneath. Its own lazy chunk with its own stylesheet
 * (gym-stage.css), so the default sign-in screen downloads none of it.
 */
import GymMark from './GymMark.jsx';
import './gym-stage.css';

export default function GymStage({ brand }) {
  return (
    <div className="auth-brand auth-brand--gym">
      <div className="auth-mark-slot">
        <GymMark brand={brand} size={null} className="auth-gym-mark" />
      </div>
      <p className="auth-gym-name">
        <span className="auth-gym-name__gym">{brand.gymName}</span>
        <span className="auth-gym-name__by"><i aria-hidden="true">×</i> Barbell</span>
      </p>
    </div>
  );
}
