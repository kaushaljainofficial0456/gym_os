import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryAction } from '../../components/trainer/useQueryAction.js';
import { api, downloadFile } from '../../api.js';
import { useFetch, fmtK, localDateKey } from '../../utils.js';
import { Card, Kpi, ErrorState, Modal, PageSkeleton, useConfirm } from '../../components/UI.jsx';
import { MiniBars, monthAxis, money, moneyShort } from '../../components/trainer/GymPulse.jsx';
import MembersTable from '../../components/trainer/MembersTable.jsx';
import Select from '../../components/Select.jsx';


// Membership lifecycle actions -- backed by membershipLifecycle.js's
// explicit state graph on the server (an invalid jump like cancel ->
// resume is rejected there, not just hidden here). Dangerous actions
// (suspend/cancel) ask for confirmation, per spec.
// How a payment was made, in words: an online payment's method is the
// gateway's name ("razorpay"), which means nothing to the person reading it.
const METHOD_LABEL = { razorpay: 'Online', mock: 'Online', cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer', cheque: 'Cheque' };

function MembershipActions({ member, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const act = async (action, question) => {
    if (question && !(await confirm(question))) return;
    setBusy(true);
    try {
      await api(`/admin/members/${member.id}/membership/${action}`, { method: 'POST', body: JSON.stringify({}) });
      onChanged();
    } catch (e) { onError(e.message); }
    finally { setBusy(false); }
  };
  const s = member.lifecycle_status;
  return (
    <div className="flex gap-1.5 justify-end">
      {confirmDialog}
      {s === 'ACTIVE' && <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act('suspend', { title: `Suspend ${member.name}'s membership?`, body: 'You can resume it later.', confirmLabel: 'Suspend' })}>Suspend</button>}
      {s === 'SUSPENDED' || s === 'PAUSED' ? <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act('resume')}>Resume</button> : null}
      {(s === 'ACTIVE' || s === 'SUSPENDED' || s === 'PAUSED') && (
        <button className="btn-ghost btn-sm text-bad" disabled={busy} onClick={() => act('cancel', {
          title: `Cancel ${member.name}'s membership?`,
          body: 'This cannot be undone.',
          confirmLabel: 'Cancel membership',
          // Not "Cancel": beside "Cancel membership" that reads as the same action.
          cancelLabel: 'Keep membership',
        })}>Cancel</button>
      )}
    </div>
  );
}

/** Downloads one of the owner spreadsheets (members, payments). */
function ExportButton({ path, filename, label }) {
  const [state, setState] = useState('');
  const go = async () => {
    setState('busy');
    try { await downloadFile(path, filename); setState(''); }
    catch { setState('failed'); setTimeout(() => setState(''), 4000); }
  };
  return (
    <button type="button" className="btn btn-sm" onClick={go} disabled={state === 'busy'} aria-label={label} title={label}>
      {state === 'busy' ? 'Exporting…' : state === 'failed' ? 'Export failed — retry' : 'Export CSV'}
    </button>
  );
}

export default function Business() {
  const nav = useNavigate();
  const ov = useFetch(() => api('/admin/overview'));
  const members = useFetch(() => api('/admin/members'));
  const [toast, setToast] = useState('');
  const [pkgOpen, setPkgOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [pkgForm, setPkgForm] = useState({ name: '', amount: '', period_days: 30, features: '' });
  const [subForm, setSubForm] = useState({ client_id: '', package_id: '', start_date: '' });
  const [payOpen, setPayOpen] = useState(false);
  useQueryAction('record', () => setPayOpen(true));
  const blankPayment = () => ({ client_id: '', amount: '', method: 'cash', paid_on: localDateKey(), reference: '' });
  const [payForm, setPayForm] = useState(blankPayment);
  // Members pay the gym directly once its payout account is live; until
  // then this page is where their desk payments are recorded.
  const payout = useFetch(() => api('/enterprise/payment-account').catch(() => null));
  // The payment just recorded, so its receipt can be downloaded straight away.
  const [justPaid, setJustPaid] = useState(null);
  const [receiptBusy, setReceiptBusy] = useState(null);
  const downloadReceipt = async (paymentId, number) => {
    setReceiptBusy(paymentId);
    try {
      await downloadFile(`/receipts/payments/${paymentId}/pdf`, `${number || 'receipt'}.pdf`);
    } catch (e) {
      setToast(e.message || 'Could not download the receipt');
    } finally {
      setReceiptBusy(null);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(h);
  }, [toast]);

  if (ov.loading || members.loading) return <PageSkeleton variant="dashboard" label="Loading business overview" />;
  if (ov.error) return <ErrorState error={ov.error} onRetry={ov.reload} />;

  const d = ov.data;

  const addPackage = async () => {
    try {
      await api('/admin/packages', { method: 'POST', body: JSON.stringify({
        name: pkgForm.name, amount: Number(pkgForm.amount), period_days: Number(pkgForm.period_days), features: pkgForm.features
      }) });
      setPkgOpen(false); setPkgForm({ name: '', amount: '', period_days: 30, features: '' });
      // silent: true -- this page gates its ENTIRE render on
      // `ov.loading || members.loading` (above); a bare reload() would
      // unmount the whole dashboard (including whatever modal/toast is
      // currently open) for the duration of the background refetch, same
      // class of bug already fixed for Nutrition.jsx (see useFetch's own
      // comment on why).
      setToast('Package added'); ov.reload({ silent: true });
    } catch (e) { setToast(e.message); }
  };

  const addSub = async () => {
    try {
      const r = await api('/admin/subscriptions', { method: 'POST', body: JSON.stringify({ ...subForm, start_date: subForm.start_date || undefined }) });
      setSubOpen(false); setSubForm({ client_id: '', package_id: '', start_date: '' });
      ov.reload({ silent: true }); members.reload({ silent: true });
      // Selling a membership at the desk records its payment, which has a receipt.
      if (r?.paymentId) setJustPaid({ paymentId: r.paymentId, number: null });
      else setToast('Subscription created');
    } catch (e) { setToast(e.message); }
  };

  const addPayment = async () => {
    try {
      const r = await api('/admin/payments', {
        method: 'POST',
        body: JSON.stringify({
          client_id: payForm.client_id, amount: Number(payForm.amount), method: payForm.method,
          paid_on: payForm.paid_on || undefined, reference: payForm.reference.trim() || undefined,
        }),
      });
      setPayOpen(false); setPayForm(blankPayment());
      setJustPaid({ paymentId: r.paymentId, number: r.receipt?.number || null });
      ov.reload({ silent: true });
    } catch (e) { setToast(e.message); }
  };

  return (
    <div className="space-y-6" data-tour="trainer-business">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="t-title">Payments</h1>
          <p className="t-sub mt-1.5">Memberships, plans and payments.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button className="btn" onClick={() => setSubOpen(true)}>+ New membership</button>
          <button className="btn-primary" onClick={() => setPayOpen(true)}>+ Record payment</button>
        </div>
      </div>

      {payout.data?.account && payout.data.account.status !== 'ACTIVE' && (
        <Card className="p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>Online payments are off</div>
              <p className="text-[13.5px] mt-0.5" style={{ color: 'var(--mute)' }}>Set up payouts so members can pay you online. Until then, record desk payments here.</p>
            </div>
            <button type="button" className="btn btn-sm shrink-0" onClick={() => nav('/app/trainer/enterprise')}>Set up payouts</button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Collected this month" value={d.monthlyRevenue} prefix="₹" dec={0} sub="from recorded payments" />
        <Kpi label="Active members" value={d.activeMembers} sub={`${d.totalMembers} total`} />
        <Kpi label="Renewals due" value={d.renewalsThisMonth} sub="next 30 days" dot={d.renewalsThisMonth ? 'bg-bad' : undefined} />
        <Kpi label="Overdue" value={d.overdue} sub="memberships" dot={d.overdue ? 'bg-bad' : undefined} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
        {/* Bars, one per month with its amount: the line chart this replaced
            drew equal months as a flat line along the top gridline and
            empty months along the axis, and read as an empty chart. */}
        <Card className="lg:col-span-2 p-5">
          <h2 className="ws-section-title mb-4">Revenue by month</h2>
          <MiniBars
            points={monthAxis((d.revenueTrend || []).map((t) => ({ month: t.month, value: t.total })), localDateKey())}
            label="Revenue by month" color="var(--m-body)"
            format={(v) => money(v)} short={moneyShort}
            empty="No payments recorded yet."
          />
        </Card>

        <Card className="lg:col-span-3 p-5">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h2 className="ws-section-title">Plans</h2>
            <button className="btn btn-sm" onClick={() => setPkgOpen(true)}>+ Add plan</button>
          </div>
          {(d.packages || []).length ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {d.packages.map((p) => (
                <div key={p.id} className="rounded-2xl p-4" style={{ border: '1px solid var(--line)', background: 'rgb(var(--tint-rgb) / .03)' }}>
                  <div className="text-[16px] font-extrabold truncate" style={{ color: 'var(--ink)' }}>{p.name}</div>
                  <div className="text-[22px] font-extrabold tabular-nums mt-1" style={{ color: 'var(--accent)' }}>₹{fmtK(p.amount)}</div>
                  <div className="text-[13px] mt-0.5" style={{ color: 'var(--mute)' }}>{p.period_days} days</div>
                  {p.features && <div className="text-[13px] mt-2 leading-relaxed" style={{ color: 'var(--mute)' }}>{p.features}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[15px] py-4" style={{ color: 'var(--mute)' }}>No plans yet. Add one to start selling memberships.</div>
          )}
        </Card>
      </div>

      {/* payments */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="ws-section-title">Payments</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <ExportButton path="/admin/export/payments.csv" filename="payments.csv" label="Export all payments as a spreadsheet" />
            <button className="btn btn-sm" onClick={() => setPayOpen(true)}>+ Record payment</button>
          </div>
        </div>
        {(d.recentPayments || []).length > 0 ? (
          <div className="overflow-x-auto mt-2 relative">
            {/* relative: the sr-only "Receipt" header is absolutely positioned and, without a
                positioned ancestor here, escaped this scroller and widened the whole page at 320px. */}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-mute font-grotesk border-b border-line">
                  <th className="py-2 pr-3 font-semibold">Date</th>
                  <th className="py-2 pr-3 font-semibold">Member</th>
                  <th className="py-2 pr-3 font-semibold">Amount</th>
                  <th className="py-2 pr-3 font-semibold">Method</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 font-semibold"><span className="sr-only">Receipt</span></th>
                </tr>
              </thead>
              <tbody>
                {/* WHO paid is the first thing an owner wants from this
                    list and it was not here at all -- the table showed a
                    date, a figure, and a green PAID chip hard-coded onto
                    every row, so a failed or pending payment was
                    indistinguishable from a settled one. The status is
                    now read from the row. */}
                {d.recentPayments.map((p) => {
                  const status = String(p.status || 'paid').toLowerCase();
                  const tone = status === 'paid' ? 'var(--good)'
                    : status === 'failed' ? 'var(--bad)' : 'var(--warn)';
                  return (
                    <tr key={p.id || `${p.paid_at}-${p.amount}`} className="border-b border-line/50 last:border-0">
                      <td className="py-2 pr-3 text-xs tabular-nums whitespace-nowrap" style={{ color: 'var(--mute)' }}>
                        {p.paid_at ? new Date(p.paid_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}
                      </td>
                      <td className="py-2 pr-3 text-xs" style={{ color: 'var(--ink)' }}>
                        {p.client_name || <span style={{ color: 'var(--faint)' }}>Unknown member</span>}
                      </td>
                      <td className="py-2 pr-3 font-grotesk font-bold tabular-nums whitespace-nowrap">₹{fmtK(p.amount)}</td>
                      <td className="py-2 pr-3 text-xs whitespace-nowrap" style={{ color: 'var(--mute)' }}>
                        {METHOD_LABEL[String(p.method || '').toLowerCase()] || p.method || '—'}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="inline-block rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold"
                          style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}>
                          {status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {p.id && status !== 'failed' && (
                          <button type="button" className="btn btn-sm whitespace-nowrap" disabled={receiptBusy === p.id}
                            aria-label={`Download receipt for ${p.client_name || 'this payment'}`} onClick={() => downloadReceipt(p.id)}>
                            {receiptBusy === p.id ? '…' : 'Receipt'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className="text-sm text-mute py-4 text-center">No payments recorded yet.</div>}
      </Card>

      {/* members */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="ws-section-title">Members</h2>
          <ExportButton path="/admin/export/members.csv" filename="members.csv" label="Export the member list as a spreadsheet" />
        </div>
        {/* A roster that failed to load is not "No members yet". */}
        {members.error ? <ErrorState error={members.error} onRetry={members.reload} /> : (
          <MembersTable
            members={members.data?.members || []}
            renderActions={(m) => (m.subscription_id ? (
              <MembershipActions
                member={m}
                onChanged={() => { members.reload({ silent: true }); setToast('Updated'); }}
                onError={(msg) => setToast(msg)}
              />
            ) : null)}
          />
        )}
      </Card>

      <Modal open={pkgOpen} onClose={() => setPkgOpen(false)} title="New plan">
        <div className="space-y-4">
          <label className="block"><span className="field-label block mb-1.5">Name</span>
            <input className="input" placeholder="e.g. Transformation" value={pkgForm.name} onChange={(e) => setPkgForm((f) => ({ ...f, name: e.target.value }))} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="field-label block mb-1.5">Price (₹)</span>
              <input className="input" type="number" inputMode="numeric" placeholder="1999" value={pkgForm.amount} onChange={(e) => setPkgForm((f) => ({ ...f, amount: e.target.value }))} />
            </label>
            <label className="block"><span className="field-label block mb-1.5">Length (days)</span>
              <input className="input" type="number" inputMode="numeric" placeholder="30" value={pkgForm.period_days} onChange={(e) => setPkgForm((f) => ({ ...f, period_days: e.target.value }))} />
            </label>
          </div>
          <label className="block"><span className="field-label block mb-1.5">What's included (optional)</span>
            <input className="input" placeholder="Gym floor, 2 PT sessions, diet plan" value={pkgForm.features} onChange={(e) => setPkgForm((f) => ({ ...f, features: e.target.value }))} />
          </label>
          <button className="btn-primary w-full" onClick={addPackage}>Create plan</button>
        </div>
      </Modal>

      <Modal open={subOpen} onClose={() => setSubOpen(false)} title="New membership">
        <div className="space-y-4">
          <div><span className="field-label block mb-1.5">Member</span>
          <Select aria-label="Member" value={subForm.client_id} onChange={(v) => setSubForm((f) => ({ ...f, client_id: v }))}
            placeholder="Choose a member" options={(members.data?.members || []).map((m) => ({ value: m.id, label: m.name }))} />
          </div>
          <div><span className="field-label block mb-1.5">Plan</span>
          <Select aria-label="Package" value={subForm.package_id} onChange={(v) => setSubForm((f) => ({ ...f, package_id: v }))}
            placeholder="Choose a plan" options={(d.packages || []).map((p) => ({ value: p.id, label: p.name, hint: `₹${fmtK(p.amount)} · ${p.period_days} days` }))} />
          </div>
          {/* A bare date field gave no hint what the date was for. */}
          <div className="field">
            <label htmlFor="sub-start-date" className="field-label">Start date</label>
            <input id="sub-start-date" type="date" className="input mt-1.5" value={subForm.start_date} onChange={(e) => setSubForm((f) => ({ ...f, start_date: e.target.value }))} />
          </div>
          <button className="btn-primary w-full" onClick={addSub}>Create membership</button>
        </div>
      </Modal>

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="Record payment">
        <div className="space-y-4">
          <div><span className="field-label block mb-1.5">Member</span>
            <Select aria-label="Member" value={payForm.client_id} onChange={(v) => setPayForm((f) => ({ ...f, client_id: v }))}
              placeholder="Choose a member" options={(members.data?.members || []).map((m) => ({ value: m.id, label: m.name }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="field-label block mb-1.5">Amount (₹)</span>
              <input className="input" type="number" inputMode="numeric" aria-label="Amount in rupees" placeholder="1999" value={payForm.amount} onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))} />
            </label>
            <div><span className="field-label block mb-1.5">Method</span>
              <Select aria-label="Payment method" value={payForm.method} onChange={(v) => setPayForm((f) => ({ ...f, method: v }))}
                options={[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['cheque', 'Cheque']].map(([value, label]) => ({ value, label }))} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="field-label block mb-1.5">Paid on</span>
              <input className="input" type="date" aria-label="Date paid" max={localDateKey()} value={payForm.paid_on} onChange={(e) => setPayForm((f) => ({ ...f, paid_on: e.target.value }))} />
            </label>
            <label className="block">
              <span className="field-label block mb-1.5">Reference (optional)</span>
              <input className="input" aria-label="Payment reference" maxLength={60} placeholder="UPI ref, cheque no." value={payForm.reference} onChange={(e) => setPayForm((f) => ({ ...f, reference: e.target.value }))} />
            </label>
          </div>
          <p className="text-[11px] text-mute">A receipt is issued for this payment. You and the member can both download it.</p>
          <button className="btn-primary w-full" disabled={!payForm.client_id || !(Number(payForm.amount) > 0)} onClick={addPayment}>Record payment</button>
        </div>
      </Modal>

      <Modal open={!!justPaid} onClose={() => setJustPaid(null)} title="Payment recorded">
        <div className="space-y-3">
          <p className="text-sm text-mute">
            {justPaid?.number ? `Receipt ${justPaid.number} is ready. The member can also download it from their Membership page.` : 'The member can download the receipt from their Membership page.'}
          </p>
          <button className="btn-primary w-full" disabled={receiptBusy === justPaid?.paymentId} onClick={() => downloadReceipt(justPaid.paymentId, justPaid.number)}>
            {receiptBusy === justPaid?.paymentId ? 'Preparing…' : 'Download receipt (PDF)'}
          </button>
          <button className="btn w-full" onClick={() => setJustPaid(null)}>Done</button>
        </div>
      </Modal>

      {toast && <div className="toast anim-toast">{toast}</div>}
    </div>
  );
}
