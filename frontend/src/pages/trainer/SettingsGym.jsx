/**
 * SETTINGS → GYM & MEMBER APP: the gym's name and sign-up code, capacity,
 * the live-crowd switch, what members may change in their workouts, and
 * the community. The form itself is GymSettingsCard (it used to sit on
 * Setup & billing).
 */
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import GymSettingsCard from '../../components/trainer/GymSettingsCard.jsx';

export function SettingsBack() {
  return (
    <Link to="/app/trainer/settings" className="ws-back">
      <ChevronLeft size={20} strokeWidth={2.2} aria-hidden="true" />Settings
    </Link>
  );
}

export default function SettingsGym() {
  return (
    <div className="space-y-6">
      <div>
        <SettingsBack />
        <h1 className="t-title">Gym & member app</h1>
        <p className="t-sub mt-1.5">Your gym’s details, and what members can change in their own app.</p>
      </div>
      <GymSettingsCard heading={false} />
    </div>
  );
}
