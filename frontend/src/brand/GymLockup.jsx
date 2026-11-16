/**
 * "<Gym> × Barbell" -- the header of a gym's own app.
 *
 * The gym's name leads; Barbell is the quiet "powered by" after it. Two
 * shapes:
 *   inline  one line, for the member app's centred header
 *   stack   name over "× Barbell", for the workspace sidebar and top bar
 * A long gym name truncates; "× Barbell" never does.
 */
import GymMark from './GymMark.jsx';
import './brand.css';

export default function GymLockup({ brand, variant = 'inline', markSize, className = '' }) {
  if (variant === 'stack') {
    return (
      <span className={`gym-lockup gym-lockup--stack ${className}`}>
        <GymMark brand={brand} size={markSize || 36} />
        <span className="gym-lockup__text">
          <span className="gym-lockup__name">{brand.gymName}</span>
          <span className="gym-lockup__by"><i aria-hidden="true">×</i> Barbell</span>
        </span>
      </span>
    );
  }
  // Longer names step the type down before they resort to truncating:
  // the gym's name is the point of the header.
  const len = String(brand.gymName || '').length;
  return (
    <span className={`gym-lockup gym-lockup--inline ${className}`} data-len={len > 22 ? 'xl' : len > 13 ? 'l' : undefined}>
      <GymMark brand={brand} size={markSize || 28} />
      <span className="gym-lockup__name">{brand.gymName}</span>
      <span className="gym-lockup__by"><i aria-hidden="true">×</i> Barbell</span>
    </span>
  );
}
