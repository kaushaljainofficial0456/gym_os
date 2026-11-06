// ============================================================
// ENTERPRISE DASHBOARD — the owner's SK OS billing home: package,
// capacity (purchased / active / available, kept explicitly separate
// per the spec -- never "N QR codes remaining"), subscription expiry,
// payment account status, quick actions, and a few computed alerts.
// Distinct from Business.jsx (this gym billing ITS OWN clients).
// ============================================================
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, Bar, ErrorState, PageSkeleton } from '../../components/UI.jsx';
import GymSettingsCard from '../../components/trainer/GymSettingsCard.jsx';
import PayoutSetup from '../../components/trainer/PayoutSetup.jsx';

function daysUntil(iso) {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

export default function EnterpriseDashboard() {
  const nav = useNavigate();
  const status = useFetch(() => api('/enterprise/status'));

  if (status.loading) return <PageSkeleton variant="detail" label="Loading your gym's billing status" />;
  if (status.error) return <ErrorState error={status.error} onRetry={status.reload} />;
  const d = status.data;

  if (d.billingStatus !== 'ACTIVE') {
    return (
      <Card className="p-8 text-center max-w-lg mx-auto">
        <div className="font-grotesk font-bold text-lg mb-1">
          {d.billingStatus === 'SETUP' ? "Let's get your gym set up" : 'Finish setting up your package'}
        </div>
        <p className="text-sm mb-5" style={{ color: 'var(--mute)' }}>
          {d.billingStatus === 'PAYMENT_PENDING'
            ? 'Your last payment didn’t complete — resume checkout to activate your gym.'
            : 'A quick onboarding wizard and a plan, then you’re live.'}
        </p>
        <button className="btn-primary" onClick={() => nav('/app/trainer/enterprise/onboarding')}>
          {d.billingStatus === 'PAYMENT_PENDING' ? 'Resume checkout' : 'Start setup'}
        </button>
      </Card>
    );
  }

  const expiryDays = daysUntil(d.subscription?.end_date);
  const alerts = [];
  if (expiryDays != null && expiryDays <= 14) alerts.push(`Your package expires in ${Math.max(0, expiryDays)} day${expiryDays === 1 ? '' : 's'}.`);
  if (d.purchasedCapacity > 0 && d.availableCapacity <= Math.max(1, Math.round(d.purchasedCapacity * 0.1))) {
    alerts.push(`Only ${d.availableCapacity} client slot${d.availableCapacity === 1 ? '' : 's'} left — consider buying more capacity.`);
  }

  return (
    <div className="space-y-6" data-tour="trainer-enterprise">
      <div>
        <h1 className="t-title">Setup & billing</h1>
        <p className="t-sub mt-1.5">Your Barbell plan, getting paid, join codes and gym settings.</p>
      </div>

      {alerts.length > 0 && (
        <Card className="p-4 sm:p-5" style={{ borderColor: 'rgb(var(--warn-rgb) / .5)', background: 'rgb(var(--warn-rgb) / .07)' }}>
          <ul className="space-y-1">
            {alerts.map((a, i) => <li key={i} className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>{a}</li>)}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5 sm:p-6">
          <h2 className="ws-section-title">Your Barbell plan</h2>
          <div className="text-[15px] mt-1" style={{ color: 'var(--mute)' }}>
            {d.subscription?.client_capacity ? `${d.subscription.client_capacity} clients` : 'Active'}
            {d.subscription?.end_date ? ` · renews ${new Date(d.subscription.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
            {` · ${d.activeTrainers} trainer${d.activeTrainers === 1 ? '' : 's'}`}
          </div>
          <div className="grid grid-cols-3 gap-3 mt-5">
            {[['Capacity', d.purchasedCapacity], ['In use', d.activeClients], ['Free', d.availableCapacity]].map(([l, v]) => (
              <div key={l}>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--mute)' }}>{l}</div>
                <div className="text-[26px] font-extrabold tabular-nums" style={{ color: l === 'Free' && v === 0 ? 'var(--bad)' : 'var(--ink)' }}>{v}</div>
              </div>
            ))}
          </div>
          <div className="mt-3"><Bar label="" right="" value={d.activeClients} max={d.purchasedCapacity || 1} /></div>
          <div className="flex flex-wrap gap-2 mt-5">
            <button className="btn-primary" onClick={() => nav('/app/trainer/enterprise/billing')}>Buy capacity</button>
            <button className="btn" onClick={() => nav('/app/trainer/enterprise/billing')}>Renew or upgrade</button>
          </div>
        </Card>
        <PayoutSetup />
      </div>

      <Card className="p-5 sm:p-6">
        <h2 className="ws-section-title">Join QR codes</h2>
        <p className="text-[15px] mt-1" style={{ color: 'var(--mute)' }}>New clients and trainers scan one to join your gym.</p>
        <div className="flex flex-wrap gap-2 mt-4">
          <button className="btn-primary" onClick={() => nav('/app/trainer/enterprise/qr')}>Client QR code</button>
          {/* Opened the Client tab, so "Onboard trainer" made a client code. */}
          <button className="btn" onClick={() => nav('/app/trainer/enterprise/qr?for=trainer')}>Trainer QR code</button>
        </div>
      </Card>

      <GymSettingsCard />
    </div>
  );
}
