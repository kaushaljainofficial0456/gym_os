/**
 * CONNECTED DEVICES — the SK OS Health Intelligence Engine's real
 * connection UI (spec §44/§84/§86). Every state on this page is REAL,
 * read from GET /api/health/devices -- there is no fake "connected"
 * placeholder anywhere here.
 *
 * Three distinct availability states per provider, always shown
 * honestly rather than collapsed into one generic "Connect" button:
 *   - available: a real WHOOP/Oura-style web OAuth flow exists. Tapping
 *     Connect either redirects to the real provider authorize screen
 *     (if this deployment has credentials configured) or shows a clear
 *     "not configured yet" message (spec §86: never claim connected
 *     while silently failing).
 *   - requires_native_app: Apple Health / Health Connect / Samsung
 *     Health -- these have NO web connection flow at all (spec §106).
 *     Shown as a disabled state with an explanation, never a fake button.
 *   - architected_only: Garmin/Fitbit/Polar/COROS/Ultrahuman -- the
 *     architecture supports them but no adapter has been built yet.
 *
 * A user with zero connected devices gets a complete, honest empty
 * state (spec §87: the core app must never depend on a wearable).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { PageHeader, PageSkeleton, ErrorState, Card } from '../../components/UI.jsx';
import { PROVIDER_LABEL } from '../../healthProviderLabels.js';

const CAPABILITY_LABEL = {
  workouts: 'Workouts', autoDetectedWorkouts: 'Auto-detected workouts', activeEnergy: 'Active energy',
  totalEnergy: 'Total energy', restingEnergy: 'Resting energy', heartRate: 'Heart rate', steps: 'Steps',
  distance: 'Distance', sleep: 'Sleep', recovery: 'Recovery', hrv: 'HRV', restingHeartRate: 'Resting heart rate',
  respiratoryRate: 'Respiratory rate', spo2: 'SpO2', bodyTemperature: 'Body temperature', bodyMetrics: 'Body metrics',
  vo2max: 'VO2 max', routes: 'Routes',
};

function timeAgo(iso) {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function HealthDevices() {
  const nav = useNavigate();
  const devices = useFetch(() => api('/health/devices'), []);
  const [busyProvider, setBusyProvider] = useState(null);
  const [notice, setNotice] = useState('');

  if (devices.loading) return <PageSkeleton variant="list" label="Loading your connected devices" />;
  if (devices.error) return <ErrorState error={devices.error} onRetry={devices.reload} />;

  const list = devices.data?.devices || [];
  const connected = list.filter((d) => d.status === 'connected');
  const others = list.filter((d) => d.status !== 'connected');

  const connect = async (provider) => {
    setBusyProvider(provider); setNotice('');
    try {
      const res = await api(`/health/providers/${provider}/connect`, { method: 'POST' });
      if (res.authorizeUrl) window.location.href = res.authorizeUrl;
    } catch (e) {
      setNotice(e.message || `Could not start connecting ${PROVIDER_LABEL[provider] || provider}.`);
    }
    setBusyProvider(null);
  };

  const disconnect = async (provider) => {
    setBusyProvider(provider);
    try {
      await api(`/health/providers/${provider}/disconnect`, { method: 'POST' });
      devices.reload({ silent: true });
    } catch (e) { setNotice(e.message || 'Could not disconnect.'); }
    setBusyProvider(null);
  };

  const syncNow = async () => {
    setBusyProvider('__sync__'); setNotice('');
    try {
      const res = await api('/health/sync', { method: 'POST' });
      const failed = (res.results || []).filter((r) => !r.ok);
      setNotice(failed.length ? `${failed.length} provider(s) failed to sync.` : 'Synced.');
      devices.reload({ silent: true });
    } catch (e) { setNotice(e.message || 'Sync failed.'); }
    setBusyProvider(null);
  };

  const renderDevice = (d) => {
    const label = PROVIDER_LABEL[d.provider] || d.provider;
    const caps = Object.entries(d.capabilities || {}).filter(([, v]) => v).map(([k]) => CAPABILITY_LABEL[k] || k);
    return (
      <Card key={d.provider} className="!p-4 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="font-grotesk font-bold text-sm truncate" style={{ color: 'var(--ink)' }}>{label}</div>
            {d.status === 'connected' && (
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--good)' }}>
                ✓ Connected{d.lastSyncedAt ? ` · Synced ${timeAgo(d.lastSyncedAt)}` : ' · Not yet synced'}
              </div>
            )}
            {d.status !== 'connected' && d.availability === 'requires_native_app' && (
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>Requires the Barbell {d.platform} app</div>
            )}
            {d.status !== 'connected' && d.availability === 'architected_only' && (
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>Not yet available</div>
            )}
            {d.status !== 'connected' && d.status !== 'revoked' && d.availability === 'available' && (
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>Not connected</div>
            )}
            {/* 'revoked' means the provider grant itself died (an expired or
                rotated-away refresh token). It is not a transient sync error
                and retrying achieves nothing -- the one useful action is
                reconnecting, so say exactly that. */}
            {d.status === 'revoked' && (
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--warn)' }}>
                Connection expired — reconnect to resume syncing
              </div>
            )}
            {d.status === 'error' && d.syncError && (
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--bad)' }}>{d.syncError}</div>
            )}
          </div>
          {d.status === 'connected' ? (
            <button className="btn btn-sm" disabled={busyProvider === d.provider} onClick={() => disconnect(d.provider)}>
              {busyProvider === d.provider ? '…' : 'Disconnect'}
            </button>
          ) : d.availability === 'available' ? (
            <button className="btn-primary btn-sm" disabled={busyProvider === d.provider} onClick={() => connect(d.provider)}>
              {busyProvider === d.provider ? '…' : (d.status === 'revoked' ? 'Reconnect' : 'Connect')}
            </button>
          ) : (
            <button className="btn btn-sm opacity-40 cursor-not-allowed" disabled aria-disabled="true">Connect</button>
          )}
        </div>
        {caps.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {caps.slice(0, 6).map((c) => (
              <span key={c} className="chip !px-1.5 !py-0 text-[9px]" style={{ borderColor: 'var(--line)', color: 'var(--mute)' }}>{c}</span>
            ))}
            {caps.length > 6 && <span className="text-[9px]" style={{ color: 'var(--faint)' }}>+{caps.length - 6} more</span>}
          </div>
        )}
      </Card>
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Health Intelligence"
        title="Connected devices"
        sub="Barbell combines your wearable data with your logged workouts for a more complete picture — no wearable is required."
        onBack={() => nav(-1)}
        right={connected.length > 0 && (
          <button className="btn btn-sm" disabled={busyProvider === '__sync__'} onClick={syncNow}>
            {busyProvider === '__sync__' ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      />

      {notice && (
        <div className="text-[11px] px-3 py-2 rounded-xl" style={{ background: 'var(--tint)', color: 'var(--mute)' }}>{notice}</div>
      )}

      {connected.length > 0 && (
        <div className="space-y-2.5">
          <div className="t-micro">Connected</div>
          <div className="space-y-2">{connected.map(renderDevice)}</div>
        </div>
      )}

      <div className="space-y-2.5">
        <div className="t-micro">{connected.length ? 'Other devices' : 'Available devices'}</div>
        <div className="space-y-2">{others.map(renderDevice)}</div>
      </div>

      <div className="text-[10px] leading-relaxed px-1" style={{ color: 'var(--faint)' }}>
        Barbell never guesses missing data or double-counts energy across sources — your workout estimate always works even without a connected device.
      </div>
    </div>
  );
}
