// ============================================================
// ENTERPRISE QR — generate + manage single-use client/trainer
// enrollment QR codes. The QR payload itself carries no sensitive
// data (see enrollmentToken.js) -- just an opaque, short-lived,
// signed reference the server resolves everything from.
// ============================================================
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, PageHeader, Seg, Spinner, ErrorState, Empty, Toast } from '../../components/UI.jsx';

function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m left` : `${Math.floor(m / 60)}h ${m % 60}m left`;
}

const STATUS_TONE = { AVAILABLE: 'text-good border-good/40 bg-good/10', CONSUMED: 'text-mute border-line bg-tint/5', EXPIRED: 'text-warn border-warn/40 bg-warn/10', REVOKED: 'text-bad border-bad/40 bg-bad/10' };

export default function EnterpriseQR() {
  const [purpose, setPurpose] = useState('CLIENT');
  const plans = useFetch(() => api('/admin/packages'));
  const list = useFetch(() => api(`/enrollment/qr?purpose=${purpose}`), [purpose]);
  const status = useFetch(() => api('/enterprise/status'));
  const [planId, setPlanId] = useState('');
  const [issued, setIssued] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const generate = async () => {
    setBusy(true);
    try {
      const res = purpose === 'CLIENT'
        ? await api('/enrollment/qr/client', { method: 'POST', body: JSON.stringify({ membershipPlanId: planId }) })
        : await api('/enrollment/qr/trainer', { method: 'POST' });
      setIssued(res);
      // silent: true -- this section renders `list.loading ? <Spinner/>
      // : ...` inline (below); a bare reload() would flash it to a
      // spinner and back, same class of bug already fixed for
      // Nutrition.jsx.
      list.reload({ silent: true });
    } catch (e) { setToast(e.message); }
    finally { setBusy(false); }
  };

  const revoke = async (id) => {
    try {
      await api(`/enrollment/qr/${id}/revoke`, { method: 'POST' });
      setToast('QR revoked'); list.reload({ silent: true });
      if (issued?.id === id) setIssued(null);
    } catch (e) { setToast(e.message); }
  };

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setToast('Copied'); } catch { setToast('Could not copy'); }
  };

  // null (not 0) while /enterprise/status is still loading -- "we don't
  // know yet" and "capacity is confirmed zero" must never collapse into
  // the same value. They used to (both fell back to 0), so on a slower
  // connection/cold start a client with plenty of room would briefly see
  // "No client capacity remaining" and a disabled button before the real
  // fetch resolved -- caught live against the deployed Vercel/Postgres
  // backend, where a serverless cold start makes this window long enough
  // to actually notice and click during.
  const availableCapacity = status.data ? status.data.availableCapacity : null;
  const capacityKnownZero = availableCapacity === 0;
  // Loaded (not just "empty while still fetching") AND actually zero rows --
  // without a plan to attach the QR to, generation is impossible, and the
  // dropdown alone (just "Select a plan…" with no options) gave no hint why
  // the button would never enable. Reported live as "QR generation still
  // not working" -- the previous fix (bigint/capacity bug, see git log) was
  // real but didn't cover this: a gym owner who hasn't created a membership
  // plan yet hits this dead end regardless of capacity.
  const noPackages = purpose === 'CLIENT' && plans.data && !(plans.data.packages || []).length;

  return (
    <div className="space-y-6">
      <Toast message={toast} tone={toast?.toLowerCase().includes('revoked') || toast === 'Copied' ? 'success' : 'error'} />
      <PageHeader title="QR onboarding" sub="Generate a one-time code for a new client or trainer to scan." />

      <Seg value={purpose} onChange={(v) => { setPurpose(v); setIssued(null); }} options={[{ value: 'CLIENT', label: 'Client' }, { value: 'TRAINER', label: 'Trainer' }]} />

      <Card className="p-5 space-y-4">
        {purpose === 'CLIENT' && (
          <div>
            <div className="field-label mb-1.5">Membership plan</div>
            {noPackages ? (
              <div className="text-sm" style={{ color: 'var(--mute)' }}>
                You haven't added any membership plans yet — <Link to="/app/trainer/business" className="text-gold hover:underline">add one in Business</Link> to start generating client QR codes.
              </div>
            ) : (
              <>
                <select className="input" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  <option value="">Select a plan…</option>
                  {(plans.data?.packages || []).map((p) => <option key={p.id} value={p.id}>{p.name} — ₹{p.amount}/{p.period_days}d</option>)}
                </select>
                {capacityKnownZero && <div className="text-xs text-bad mt-2">No client capacity remaining — buy more from Billing before generating a client QR.</div>}
              </>
            )}
          </div>
        )}
        {!noPackages && (
          <button className="btn-primary" disabled={busy || status.loading || (purpose === 'CLIENT' && (!planId || capacityKnownZero))} onClick={generate}>
            {busy ? 'Generating…' : status.loading ? 'Checking capacity…' : `Generate ${purpose === 'CLIENT' ? 'client' : 'trainer'} QR`}
          </button>
        )}

        {issued && (
          <div className="rounded-xl border p-5 flex flex-col items-center gap-3" style={{ borderColor: 'var(--accent)' }}>
            <QRCodeSVG value={issued.payload} size={200} bgColor="transparent" fgColor="var(--ink)" />
            <div className="text-xs" style={{ color: 'var(--mute)' }}>{timeLeft(issued.expiresAt)}</div>
            <button className="btn" onClick={() => copy(issued.payload)}>Copy code</button>
          </div>
        )}
      </Card>

      <div>
        <div className="kicker">Recent {purpose === 'CLIENT' ? 'client' : 'trainer'} QR codes</div>
        {list.loading ? <Spinner /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data?.tokens?.length ? (
          <Empty title="No QR codes yet" hint="Generate one above to onboard your first person this way." />
        ) : (
          <div className="space-y-2">
            {list.data.tokens.map((t) => (
              <Card key={t.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-grotesk font-semibold truncate">{t.membership_plan_name || (purpose === 'TRAINER' ? 'Trainer' : 'No plan')}</div>
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
                    {t.status === 'CONSUMED' ? `Joined by ${t.consumed_by_name || 'someone'}` : t.status === 'AVAILABLE' ? timeLeft(t.expires_at) : t.status}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`chip border ${STATUS_TONE[t.status] || ''}`}>{t.status}</span>
                  {t.status === 'AVAILABLE' && <button className="btn-ghost" onClick={() => revoke(t.id)}>Revoke</button>}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
