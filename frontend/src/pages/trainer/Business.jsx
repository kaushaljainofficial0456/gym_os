import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch, fmtK, fmt1 } from '../../utils.js';
import { Card, Kicker, Kpi, Spinner, ErrorState, Modal } from '../../components/UI.jsx';
import { TrendChart } from '../../components/charts.jsx';
import { status } from '../../design/tokens.js';

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

// Membership lifecycle actions -- backed by membershipLifecycle.js's
// explicit state graph on the server (an invalid jump like cancel ->
// resume is rejected there, not just hidden here). Dangerous actions
// (suspend/cancel) ask for confirmation, per spec.
const MEMBERSHIP_TONE = {
  ACTIVE: 'text-good border-good/40 bg-good/10', PAUSED: 'text-warn border-warn/40 bg-warn/10',
  SUSPENDED: 'text-warn border-warn/40 bg-warn/10', EXPIRED: 'text-bad border-bad/40 bg-bad/10',
  CANCELLED: 'text-mute border-line bg-white/5', REFUND_PENDING: 'text-warn border-warn/40 bg-warn/10',
  REFUNDED: 'text-mute border-line bg-white/5',
};
function MembershipActions({ member, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const act = async (action, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      await api(`/admin/members/${member.id}/membership/${action}`, { method: 'POST', body: JSON.stringify({}) });
      onChanged();
    } catch (e) { onError(e.data?.message || e.message); }
    finally { setBusy(false); }
  };
  const s = member.lifecycle_status;
  return (
    <div className="flex gap-1.5 justify-end">
      {s === 'ACTIVE' && <button className="btn-ghost !text-[11px] !px-2 !py-1" disabled={busy} onClick={() => act('suspend', `Suspend ${member.name}'s membership?`)}>Suspend</button>}
      {s === 'SUSPENDED' || s === 'PAUSED' ? <button className="btn-ghost !text-[11px] !px-2 !py-1" disabled={busy} onClick={() => act('resume')}>Resume</button> : null}
      {(s === 'ACTIVE' || s === 'SUSPENDED' || s === 'PAUSED') && (
        <button className="btn-ghost !text-[11px] !px-2 !py-1 text-bad" disabled={busy} onClick={() => act('cancel', `Cancel ${member.name}'s membership? This cannot be undone.`)}>Cancel</button>
      )}
    </div>
  );
}

export default function Business() {
  const { user } = useAuth();
  const ov = useFetch(() => api('/admin/overview'));
  const members = useFetch(() => api('/admin/members'));
  const settings = useFetch(() => api('/admin/settings'));
  const crowd = useFetch(() => api('/admin/crowd'));
  const [toast, setToast] = useState('');
  const [setForm, setSetForm] = useState(null);
  const [savingSet, setSavingSet] = useState(false);

  useEffect(() => {
    if (settings.data?.settings) setSetForm((f) => f || settings.data.settings);
  }, [settings.data]);
  const [pkgOpen, setPkgOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [pkgForm, setPkgForm] = useState({ name: '', amount: '', period_days: 30, features: '' });
  const [subForm, setSubForm] = useState({ client_id: '', package_id: '', start_date: '' });
  const [payOpen, setPayOpen] = useState(false);
  const [payForm, setPayForm] = useState({ client_id: '', amount: '', method: 'cash' });
  const [attDate, setAttDate] = useState(new Date().toISOString().slice(0, 10));
  const [attList, setAttList] = useState(null);
  const [loadingAtt, setLoadingAtt] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(h);
  }, [toast]);

  if (ov.loading || members.loading) return <Spinner label="Loading business overview…" />;
  if (ov.error) return <ErrorState error={ov.error} onRetry={ov.reload} />;

  const d = ov.data;
  const trendRows = (d.revenueTrend || []).map((t) => ({ label: t.month.slice(5), value: t.total }));

  const addPackage = async () => {
    try {
      await api('/admin/packages', { method: 'POST', body: JSON.stringify({
        name: pkgForm.name, amount: Number(pkgForm.amount), period_days: Number(pkgForm.period_days), features: pkgForm.features
      }) });
      setPkgOpen(false); setPkgForm({ name: '', amount: '', period_days: 30, features: '' });
      setToast('Package added'); ov.reload();
    } catch (e) { setToast(e.message); }
  };

  const addSub = async () => {
    try {
      await api('/admin/subscriptions', { method: 'POST', body: JSON.stringify({ ...subForm, start_date: subForm.start_date || undefined }) });
      setSubOpen(false); setSubForm({ client_id: '', package_id: '', start_date: '' });
      setToast('Subscription created'); ov.reload(); members.reload();
    } catch (e) { setToast(e.message); }
  };

  const addPayment = async () => {
    try {
      await api('/admin/payments', { method: 'POST', body: JSON.stringify({ client_id: payForm.client_id, amount: Number(payForm.amount), method: payForm.method }) });
      setPayOpen(false); setPayForm({ client_id: '', amount: '', method: 'cash' });
      setToast('Payment recorded'); ov.reload();
    } catch (e) { setToast(e.message); }
  };

  const loadAttendance = async (date) => {
    setLoadingAtt(true);
    try {
      const r = await api(`/admin/attendance?date=${date || attDate}`);
      setAttList(r.attendance || []);
    } catch { setAttList([]); }
    setLoadingAtt(false);
  };

  const toggleAtt = async (clientId, present) => {
    try {
      await api('/admin/attendance', { method: 'POST', body: JSON.stringify({ client_id: clientId, present }) });
      loadAttendance();
    } catch (e) { setToast(e.message); }
  };

  return (
    <div className="space-y-6" data-tour="trainer-business">
      <div className="flex items-end justify-between flex-wrap gap-3 anim-fadeUp">
        <div>
          <div className="text-[11px] text-mute uppercase tracking-[.18em] font-grotesk">{todayLabel}</div>
          {/* font-brand (Satoshi), not font-grotesk: this is a hero, and
              trainer scope repoints font-grotesk to DM Sans for small
              supporting text -- a hero staying on the punchier headline
              face is the whole point of having two. Gradient-clipped name
              removed to match the fix already made on Dashboard.jsx's
              hero: gradient text on a warm ground reads washed-out, not
              premium, and it spent the page's loudest moment on the
              owner's own name rather than on information. */}
          <h1 className="font-brand font-black text-3xl tracking-tight mt-1" style={{ color: 'var(--ink)' }}>
            {greeting()}, {user?.name?.split(' ')[0] || 'Owner'}
          </h1>
          <p className="text-mute text-sm mt-1">Members, plans, payments and renewals — the pulse of your gym.</p>
        </div>
        <button className="btn-primary" onClick={() => setSubOpen(true)}>+ New subscription</button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label="Active members" value={d.activeMembers} sub={`${d.totalMembers} total`} />
        <Kpi label="Monthly revenue" value={d.monthlyRevenue} dec={0} sub="this month" />
        <Kpi label="Renewals due" value={d.renewalsThisMonth} sub="next 30 days" dot="bg-bad" />
        <Kpi label="Overdue" value={d.overdue} sub="payments" dot="bg-bad" />
        <Kpi label="Attendance today" value={d.attendanceToday} sub="marked present" />
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* revenue trend */}
        <Card className="lg:col-span-2">
          <Kicker>Revenue · 6 months</Kicker>
          {trendRows.some((t) => t.value > 0) ? <TrendChart data={trendRows} color={status.good} /> : <div className="text-sm text-mute py-10 text-center">No revenue recorded yet.</div>}
          <div className="text-[11px] text-faint mt-2">From recorded payments · ₹{fmtK(d.monthlyRevenue)} this month</div>
        </Card>

        {/* packages */}
        <Card className="lg:col-span-3">
          <div className="flex items-center justify-between">
            <Kicker>Packages</Kicker>
            <button className="btn !py-1.5 !px-3 !text-[11px]" onClick={() => setPkgOpen(true)}>+ Add package</button>
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            {(d.packages || []).map((p) => (
              <div key={p.id} className="rounded-2xl border border-line bg-white/[.03] p-4">
                <div className="text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">{p.period_days}-day plan</div>
                <div className="font-grotesk font-bold text-lg">{p.name}</div>
                <div className="font-grotesk text-xl font-bold text-gold mt-1">₹{fmtK(p.amount)}</div>
                {p.features && <div className="text-[11px] text-mute mt-2 leading-relaxed">{p.features}</div>}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* gym settings — branding, crowd, default client permissions */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Kicker>Gym settings</Kicker>
          {crowd.data?.enabled && (
            <span className="chip border-cyanx/30 text-cyanx bg-cyanx/5">
              Live crowd: {crowd.data.current}/{crowd.data.capacity} · {crowd.data.status?.replace('_', ' ')}
            </span>
          )}
        </div>

        {/* Gym code -- what a client types into /signup's "Gym code" field
            (POST /auth/register resolves it to this org). orgSlug comes
            from /auth/login's response right after signing in; org_slug is
            the same value from /auth/me on a page refresh -- the API isn't
            consistently camelCased across endpoints, so both are read here
            rather than silently showing nothing after a refresh. */}
        {(user?.orgSlug || user?.org_slug) && (
          <div className="mt-3 rounded-2xl border border-line bg-white/[.03] p-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider mb-1">Client sign-up code</div>
              <div className="font-grotesk font-bold text-lg tracking-tight" style={{ color: 'var(--ink)' }}>{user.orgSlug || user.org_slug}</div>
              <div className="text-[11px] text-mute mt-1">Share this with clients — they enter it at sign-up to join your gym automatically.</div>
            </div>
            <button className="btn !py-1.5 !px-3 !text-[11px]" onClick={() => {
              navigator.clipboard?.writeText(user.orgSlug || user.org_slug);
              setToast('Gym code copied');
            }}>Copy code</button>
          </div>
        )}

        {setForm && (
          <div className="grid md:grid-cols-2 gap-4 mt-3">
            <div className="space-y-2.5">
              <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider">BRANDING</div>
              <input className="input" placeholder="Gym name" value={setForm.brand_name} onChange={(e) => setSetForm((f) => ({ ...f, brand_name: e.target.value }))} />
              <input className="input" placeholder="e.g. Train hard, recover smarter" value={setForm.tagline || ''} onChange={(e) => setSetForm((f) => ({ ...f, tagline: e.target.value }))} />
              <div className="grid grid-cols-2 gap-2">
                <input className="input" type="number" placeholder="Crowd capacity (e.g. 60)" value={setForm.crowd_capacity} onChange={(e) => setSetForm((f) => ({ ...f, crowd_capacity: e.target.value }))} />
                <label className="flex items-center gap-2 text-xs text-mute">
                  <input type="checkbox" className="accent-cyanx" checked={!!setForm.crowd_enabled} onChange={(e) => setSetForm((f) => ({ ...f, crowd_enabled: e.target.checked ? 1 : 0 }))} />
                  Show live crowd
                </label>
              </div>
            </div>
            <div className="space-y-2.5">
              <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider">DEFAULT CLIENT PERMISSIONS</div>
              <select className="input" value={setForm.workout_mode_default} onChange={(e) => setSetForm((f) => ({ ...f, workout_mode_default: e.target.value }))}>
                <option value="hybrid">Hybrid — trainer prescribes, client can personalize</option>
                <option value="prescribed">Prescribed — trainer controls workouts</option>
                <option value="custom">Custom — clients build their own workouts</option>
              </select>
              {[
                ['allow_substitute', 'Clients may substitute exercises'],
                ['allow_add_exercise', 'Clients may add exercises'],
                ['allow_edit_targets', 'Clients may edit sets / reps / weight']
              ].map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-xs text-mute">
                  <input type="checkbox" className="accent-ember" checked={!!setForm[k]} onChange={(e) => setSetForm((f) => ({ ...f, [k]: e.target.checked ? 1 : 0 }))} />
                  {label}
                </label>
              ))}
              <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider mt-3">COMMUNITY</div>
              <label className="flex items-center gap-2 text-xs text-mute">
                <input type="checkbox" className="accent-gold" checked={!!setForm.community_enabled} onChange={(e) => setSetForm((f) => ({ ...f, community_enabled: e.target.checked ? 1 : 0 }))} />
                Enable gym community
              </label>
              <label className="flex items-center gap-2 text-xs text-mute">
                <input type="checkbox" className="accent-gold" checked={!!setForm.community_leaderboard_enabled} onChange={(e) => setSetForm((f) => ({ ...f, community_leaderboard_enabled: e.target.checked ? 1 : 0 }))} />
                Enable leaderboards
              </label>
              <button className="btn-primary w-full" disabled={savingSet} onClick={async () => {
                setSavingSet(true);
                try {
                  await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ ...setForm, crowd_capacity: Number(setForm.crowd_capacity) || 150 }) });
                  setToast('Gym settings saved'); settings.reload(); crowd.reload();
                } catch (e) { setToast(e.message); }
                setSavingSet(false);
              }}>{savingSet ? 'Saving…' : 'Save gym settings'}</button>
            </div>
          </div>
        )}
      </Card>

      {/* attendance */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Kicker>Attendance</Kicker>
          <div className="flex items-center gap-2">
            <input type="date" className="input !py-1.5 !text-[11px]" value={attDate} onChange={(e) => { setAttDate(e.target.value); loadAttendance(e.target.value); }} />
            {!attList && <button className="btn !py-1.5 !px-3 !text-[11px]" onClick={() => loadAttendance()}>Load</button>}
          </div>
        </div>
        {attList && (
          <div className="space-y-1.5 mt-3">
            {loadingAtt && <div className="text-xs text-mute py-4 text-center">Loading…</div>}
            {!loadingAtt && !attList.length && <div className="text-xs text-mute py-4 text-center">No attendance records for this date.</div>}
            {attList.map((a) => (
              <div key={a.client_id} className="flex items-center justify-between rounded-xl border border-line bg-white/[.03] px-3 py-2">
                <span className="font-grotesk text-sm font-semibold">{a.client_name}</span>
                <button className={`chip text-[10px] ${a.present ? 'border-good/40 text-good bg-good/10' : 'border-bad/40 text-bad bg-bad/10'}`} onClick={() => toggleAtt(a.client_id, !a.present)}>
                  {a.present ? 'Present ✓' : 'Absent ✕'}
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* payments */}
      <Card>
        <div className="flex items-center justify-between">
          <Kicker>Payments</Kicker>
          <button className="btn !py-1.5 !px-3 !text-[11px]" onClick={() => setPayOpen(true)}>+ Record payment</button>
        </div>
        {(d.recentPayments || []).length > 0 ? (
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-mute font-grotesk border-b border-line">
                  <th className="py-2 pr-3 font-semibold">Date</th>
                  <th className="py-2 pr-3 font-semibold">Amount</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {d.recentPayments.map((p, i) => (
                  <tr key={i} className="border-b border-line/50 last:border-0">
                    <td className="py-2 pr-3 text-xs text-mute">{p.paid_at?.slice(0, 10) || '—'}</td>
                    <td className="py-2 pr-3 font-grotesk font-bold">₹{fmtK(p.amount)}</td>
                    <td className="py-2 pr-3"><span className="chip text-[10px] text-good border-good/40 bg-good/10">PAID</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="text-sm text-mute py-4 text-center">No payments recorded yet.</div>}
      </Card>

      {/* members */}
      <Card>
        <Kicker>Members</Kicker>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-mute font-grotesk border-b border-line">
                <th className="py-2.5 pr-3 font-semibold">Member</th>
                <th className="py-2.5 pr-3 font-semibold">Goal</th>
                <th className="py-2.5 pr-3 font-semibold">Weight</th>
                <th className="py-2.5 pr-3 font-semibold">Plan</th>
                <th className="py-2.5 pr-3 font-semibold">Renews</th>
                <th className="py-2.5 pr-3 font-semibold">Status</th>
                <th className="py-2.5 pr-3 font-semibold">Membership</th>
                <th className="py-2.5 pr-3 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {(members.data?.members || []).map((m) => (
                <tr key={m.id} className="border-b border-line/50 last:border-0">
                  <td className="py-2.5 pr-3 font-grotesk font-semibold">{m.name}</td>
                  <td className="py-2.5 pr-3 text-xs text-mute">{m.goal}</td>
                  <td className="py-2.5 pr-3 text-xs">{m.current_weight ? `${m.current_weight} kg` : '—'}</td>
                  <td className="py-2.5 pr-3 text-xs">{m.plan_name || '—'}</td>
                  <td className="py-2.5 pr-3 text-xs text-mute">{m.end_date ? m.end_date.slice(5) : '—'}</td>
                  <td className="py-2.5 pr-3">
                    <span className={`chip border ${m.payment_status === 'paid' ? 'text-good border-good/40 bg-good/10' : m.payment_status === 'overdue' ? 'text-bad border-bad/40 bg-bad/10' : 'text-mute border-line bg-white/5'}`}>
                      {(m.payment_status || '—').toUpperCase()}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">
                    {m.lifecycle_status && (
                      <span className={`chip border ${MEMBERSHIP_TONE[m.lifecycle_status] || 'text-mute border-line bg-white/5'}`}>{m.lifecycle_status}</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    {m.subscription_id && <MembershipActions member={m} onChanged={() => { members.reload(); setToast('Updated'); }} onError={(msg) => setToast(msg)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={pkgOpen} onClose={() => setPkgOpen(false)} title="New package">
        <div className="space-y-3">
          <input className="input" placeholder="Package name (e.g. Transformation)" value={pkgForm.name} onChange={(e) => setPkgForm((f) => ({ ...f, name: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <input className="input" type="number" placeholder="Amount ₹" value={pkgForm.amount} onChange={(e) => setPkgForm((f) => ({ ...f, amount: e.target.value }))} />
            <input className="input" type="number" placeholder="Days (30)" value={pkgForm.period_days} onChange={(e) => setPkgForm((f) => ({ ...f, period_days: e.target.value }))} />
          </div>
          <input className="input" placeholder="Features (comma separated)" value={pkgForm.features} onChange={(e) => setPkgForm((f) => ({ ...f, features: e.target.value }))} />
          <button className="btn-primary w-full" onClick={addPackage}>Create package</button>
        </div>
      </Modal>

      <Modal open={subOpen} onClose={() => setSubOpen(false)} title="New subscription">
        <div className="space-y-3">
          <select className="input" value={subForm.client_id} onChange={(e) => setSubForm((f) => ({ ...f, client_id: e.target.value }))}>
            <option value="">Choose member…</option>
            {(members.data?.members || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select className="input" value={subForm.package_id} onChange={(e) => setSubForm((f) => ({ ...f, package_id: e.target.value }))}>
            <option value="">Choose package…</option>
            {(d.packages || []).map((p) => <option key={p.id} value={p.id}>{p.name} · ₹{fmtK(p.amount)}</option>)}
          </select>
          <input type="date" className="input" value={subForm.start_date} onChange={(e) => setSubForm((f) => ({ ...f, start_date: e.target.value }))} />
          <button className="btn-primary w-full" onClick={addSub}>Create subscription</button>
        </div>
      </Modal>

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="Record payment">
        <div className="space-y-3">
          <select className="input" value={payForm.client_id} onChange={(e) => setPayForm((f) => ({ ...f, client_id: e.target.value }))}>
            <option value="">Choose member…</option>
            {(members.data?.members || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <input className="input" type="number" placeholder="Amount ₹" value={payForm.amount} onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))} />
            <select className="input" value={payForm.method} onChange={(e) => setPayForm((f) => ({ ...f, method: e.target.value }))}>
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
              <option value="bank_transfer">Bank transfer</option>
            </select>
          </div>
          <button className="btn-primary w-full" onClick={addPayment}>Record payment</button>
        </div>
      </Modal>

      {toast && <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
    </div>
  );
}
