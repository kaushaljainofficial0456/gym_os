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
import { Card, PageHeader, Kpi, Bar, ErrorState, PageSkeleton } from '../../components/UI.jsx';

function daysUntil(iso) {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

export default function EnterpriseDashboard() {
  const nav = useNavigate();
  const status = useFetch(() => api('/enterprise/status'));
  const account = useFetch(() => api('/enterprise/payment-account'));

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
  if (account.data && account.data.account?.status !== 'ACTIVE') alerts.push('Your payment account needs attention before you can receive settlements.');

  return (
    <div className="space-y-6" data-tour="trainer-enterprise">
      <PageHeader title="Enterprise" sub="Your SK OS subscription, capacity, and QR onboarding." />

      <div className="grid sm:grid-cols-3 gap-4">
        <Kpi label="Purchased capacity" value={d.purchasedCapacity} />
        <Kpi label="Active clients" value={d.activeClients} />
        <Kpi label="Available slots" value={d.availableCapacity} tone={d.availableCapacity === 0 ? 'text-bad' : undefined} />
      </div>

      <Card className="p-5">
        <Bar label="Capacity used" right={`${d.activeClients} / ${d.purchasedCapacity}`} value={d.activeClients} max={d.purchasedCapacity || 1} />
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="kicker">Subscription</div>
          <div className="font-grotesk font-bold">{d.subscription?.client_capacity ? `${d.subscription.client_capacity} clients / package` : '—'}</div>
          <div className="text-sm mt-1" style={{ color: 'var(--mute)' }}>
            Active{d.subscription?.end_date ? ` — expires ${new Date(d.subscription.end_date).toLocaleDateString()}` : ''}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--faint)' }}>{d.activeTrainers} active trainer{d.activeTrainers === 1 ? '' : 's'}</div>
        </Card>
        <Card className="p-5">
          <div className="kicker">Payment account</div>
          <div className="font-grotesk font-bold">{(account.data?.account?.status || 'NOT_CONNECTED').replace('_', ' ')}</div>
          <div className="text-sm mt-1" style={{ color: 'var(--mute)' }}>Provider: {account.data?.account?.provider || 'razorpay'}</div>
        </Card>
      </div>

      {alerts.length > 0 && (
        <Card className="p-5" style={{ borderColor: 'var(--gold, #E0B23A)' }}>
          <div className="kicker">Alerts</div>
          <ul className="space-y-1.5">
            {alerts.map((a, i) => <li key={i} className="text-sm" style={{ color: 'var(--ink)' }}>⚠ {a}</li>)}
          </ul>
        </Card>
      )}

      <Card className="p-5">
        <div className="kicker">Quick actions</div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => nav('/app/trainer/enterprise/qr')}>+ Onboard client</button>
          <button className="btn-primary" onClick={() => nav('/app/trainer/enterprise/qr')}>+ Onboard trainer</button>
          <button className="btn" onClick={() => nav('/app/trainer/enterprise/billing')}>Buy capacity</button>
          <button className="btn" onClick={() => nav('/app/trainer/enterprise/billing')}>Upgrade / renew package</button>
          <button className="btn" onClick={() => nav('/app/trainer/business')}>Manage memberships</button>
        </div>
      </Card>
    </div>
  );
}
