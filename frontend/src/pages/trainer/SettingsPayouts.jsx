/**
 * SETTINGS → GETTING PAID: the gym's payout account, so members can pay
 * online straight into the gym's bank (PayoutSetup; it used to sit on
 * Setup & billing, with a second way in from Payments).
 */
import PayoutSetup from '../../components/trainer/PayoutSetup.jsx';
import { SettingsBack } from './SettingsGym.jsx';

export default function SettingsPayouts() {
  return (
    <div className="space-y-6">
      <div>
        <SettingsBack />
        <h1 className="t-title">Getting paid</h1>
        <p className="t-sub mt-1.5">Members pay online and the money goes straight to your bank.</p>
      </div>
      <PayoutSetup />
    </div>
  );
}
