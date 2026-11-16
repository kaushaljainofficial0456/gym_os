/**
 * "Joining Iron Forge ✓" under a gym code the server has recognised.
 * Lazy, like the gym's stage, because the sign-up form is part of the
 * app's first download and most people sign up without a gym code.
 */
import { Check } from 'lucide-react';
import GymMark from './GymMark.jsx';
import './gym-stage.css';

export default function GymFound({ id, gym }) {
  return (
    <span id={id} className="auth-gym-found" role="status">
      <GymMark brand={gym} size={26} />
      <span>Joining <strong>{gym.gymName}</strong></span>
      <Check size={16} strokeWidth={2.4} aria-hidden="true" />
    </span>
  );
}
