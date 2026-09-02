// ============================================================
// ENTERPRISE BILLING — current package, upgrade/downgrade (server-
// computed prorated quote, never a client-side guess), buy additional
// capacity, and invoice history.
// ============================================================
import { useState } from 'react';
import { api, downloadFile } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, PageHeader, Spinner, ErrorState, Modal, Empty, Toast } from '../../components/UI.jsx';
import PaymentCheckout from '../../components/PaymentCheckout.jsx';

function QuoteFlow({ open, onClose, quote, order, onPay, onDone, freeChange }) {
  return (
    <Modal open={open} onClose={onClose} title={freeChange ? 'Change confirmed' : 'Confirm payment'}>
      {freeChange ? (
        <div className="text-center py-4">
          <div className="text-2xl mb-2">✓</div>
          <p className="text-sm" style={{ color: 'var(--mute)' }}>Fully covered by your unused credit — no charge, no gateway needed.</p>
          <button className="btn-primary mt-4 w-full" onClick={onDone}>Done</button>
        </div>
      ) : order ? (
        <div className="space-y-3">
          {quote?.credit > 0 && (
            <div className="text-xs rounded-lg px-3 py-2" style={{ background: 'var(--bg2)', color: 'var(--mute)' }}>
              Rs {quote.base_price?.toLocaleString('en-IN')} new price − Rs {quote.credit.toLocaleString('en-IN')} credit for your unused period
            </div>
          )}
          <PaymentCheckout order={order} onComplete={onPay} onCancel={onClose} />
        </div>
      ) : <Spinner />}
    </Modal>
  );
}

export default function EnterpriseBilling() {
  const status = useFetch(() => api('/enterprise/status'));
  const packages = useFetch(() => api('/enterprise/packages'));
  const invoices = useFetch(() => api('/enterprise/invoices'));
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState(null); // { quote, order, freeChange } | null
  const [busy, setBusy] = useState(false);
  const [customCapacity, setCustomCapacity] = useState('');
  const [addonId, setAddonId] = useState('');
  const [invoiceBusyId, setInvoiceBusyId] = useState(null);

  const downloadInvoice = async (inv) => {
    setInvoiceBusyId(inv.id); setToast('');
    try {
      await downloadFile(`/enterprise/invoices/${inv.id}/pdf`, `${inv.invoice_number}.pdf`);
    } catch (e) {
      setToast(e.message);
    } finally {
      setInvoiceBusyId(null);
    }
  };

  const emailInvoice = async (inv) => {
    setInvoiceBusyId(inv.id); setToast('');
    try {
      const res = await api(`/enterprise/invoices/${inv.id}/email`, { method: 'POST', body: JSON.stringify({}) });
      setToast(`Invoice sent to ${res.to}`);
      invoices.reload({ silent: true });
    } catch (e) {
      setToast(e.data?.message || e.message);
    } finally {
      setInvoiceBusyId(null);
    }
  };

  const currentCapacity = status.data?.purchasedCapacity || 0;

  const startUpgrade = async (targetCapacity) => {
    setBusy(true); setToast('');
    try {
      const q = await api('/enterprise/billing/quote', { method: 'POST', body: JSON.stringify({ kind: 'ORG_UPGRADE', capacity: Number(targetCapacity) }) });
      if (q.quote.total <= 0) {
        await api('/enterprise/payment/order', { method: 'POST', body: JSON.stringify({ quoteId: q.quote.id }) });
        setModal({ quote: q.quote, freeChange: true });
        // silent: true -- this page gates its whole render on
        // `status.loading` (below); a bare reload() would unmount
        // everything (including the just-opened modal) for the
        // duration of the refetch, same class of bug already fixed for
        // Nutrition.jsx.
        status.reload({ silent: true });
      } else {
        const o = await api('/enterprise/payment/order', { method: 'POST', body: JSON.stringify({ quoteId: q.quote.id }) });
        setModal({ quote: q.quote, order: o.order });
      }
    } catch (e) {
      // The downgrade-blocked response carries its own precise, human-
      // readable message (spec's own worked example) -- prefer that
      // over the generic error-code string api.js's own .message falls
      // back to for this route.
      setToast(e.data?.message || e.message);
    } finally { setBusy(false); }
  };

  const startAddon = async () => {
    if (!addonId) return;
    setBusy(true); setToast('');
    try {
      const q = await api('/enterprise/billing/quote', { method: 'POST', body: JSON.stringify({ kind: 'ORG_CAPACITY_ADDON', addonId }) });
      const o = await api('/enterprise/payment/order', { method: 'POST', body: JSON.stringify({ quoteId: q.quote.id }) });
      setModal({ quote: q.quote, order: o.order });
    } catch (e) { setToast(e.message); }
    finally { setBusy(false); }
  };

  const onPay = async (paymentId, signature) => {
    try {
      await api('/enterprise/payment/verify', { method: 'POST', body: JSON.stringify({ orderId: modal.order.id, providerPaymentId: paymentId, signature }) });
      setToast('Payment complete');
      setModal(null);
      status.reload({ silent: true }); invoices.reload({ silent: true });
    } catch (e) { setToast(e.message); }
  };

  if (status.loading) return <Spinner label="Loading billing…" />;
  if (status.error) return <ErrorState error={status.error} onRetry={status.reload} />;

  return (
    <div className="space-y-6">
      <Toast message={toast} tone={toast.toLowerCase?.().includes('complete') ? 'success' : 'error'} />
      <PageHeader title="Billing" sub="Package, capacity, and invoices for your own SK OS subscription." />

      <Card className="p-5">
        <div className="kicker">Current package</div>
        <div className="font-grotesk font-bold text-xl">{currentCapacity} clients</div>
        <div className="text-sm mt-1" style={{ color: 'var(--mute)' }}>
          {status.data.activeClients} active · {status.data.availableCapacity} available
          {status.data.subscription?.end_date && ` · expires ${new Date(status.data.subscription.end_date).toLocaleDateString()}`}
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="kicker">Upgrade / renew package</div>
        <div className="grid sm:grid-cols-3 gap-2">
          {(packages.data?.packages || []).filter((p) => p.client_capacity !== currentCapacity).map((p) => (
            <button key={p.id} className="btn" disabled={busy} onClick={() => startUpgrade(p.client_capacity)}>
              {p.client_capacity > currentCapacity ? 'Upgrade' : 'Downgrade'} to {p.client_capacity} — ₹{p.price.toLocaleString('en-IN')}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-wider font-grotesk mb-1" style={{ color: 'var(--mute)' }}>Custom capacity</div>
            <input type="number" min={1} className="input" value={customCapacity} onChange={(e) => setCustomCapacity(e.target.value)} placeholder="e.g. 80" />
          </div>
          <button className="btn-primary" disabled={busy || !customCapacity} onClick={() => startUpgrade(customCapacity)}>Get quote</button>
        </div>
        <button className="btn" disabled={busy} onClick={() => startUpgrade(currentCapacity)}>Renew current plan (same capacity)</button>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="kicker">Buy additional capacity</div>
        <div className="flex gap-2">
          <select className="input flex-1" value={addonId} onChange={(e) => setAddonId(e.target.value)}>
            <option value="">Select add-on…</option>
            {(packages.data?.capacityAddons || []).map((a) => <option key={a.id} value={a.id}>+{a.increment} clients — ₹{a.price.toLocaleString('en-IN')}</option>)}
          </select>
          <button className="btn-primary" disabled={busy || !addonId} onClick={startAddon}>Buy</button>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--faint)' }}>Billed for the remaining period of your current package — not prorated.</div>
      </Card>

      <div>
        <div className="kicker">Invoices</div>
        {invoices.loading ? <Spinner /> : !invoices.data?.invoices?.length ? (
          <Empty title="No invoices yet" />
        ) : (
          <div className="space-y-2">
            {invoices.data.invoices.map((inv) => (
              <Card key={inv.id} className="p-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="text-sm font-grotesk font-semibold">{inv.invoice_number}</div>
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
                    {new Date(inv.issued_at).toLocaleDateString()} · {inv.subject_type.replace('_', ' ')}
                    {inv.emailed_at && <> · emailed {new Date(inv.emailed_at).toLocaleDateString()}</>}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button className="btn-ghost text-xs" disabled={invoiceBusyId === inv.id} onClick={() => downloadInvoice(inv)}>Download</button>
                  <button className="btn-ghost text-xs" disabled={invoiceBusyId === inv.id} onClick={() => emailInvoice(inv)}>Email</button>
                  <div className="font-grotesk font-bold">₹{inv.amount.toLocaleString('en-IN')}</div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <QuoteFlow open={!!modal} onClose={() => setModal(null)} quote={modal?.quote} order={modal?.order} freeChange={modal?.freeChange}
        onPay={onPay} onDone={() => { setModal(null); status.reload({ silent: true }); }} />
    </div>
  );
}
