// ============================================================
// ENTERPRISE BILLING — current package, upgrade/downgrade (server-
// computed prorated quote, never a client-side guess), buy additional
// capacity, and invoice history.
// ============================================================
import { useState } from 'react';
import { api, downloadFile } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch } from '../../utils.js';
import { Card, PageHeader, Spinner, ErrorState, Modal, Toast, CheckIcon } from '../../components/UI.jsx';
import PaymentCheckout from '../../components/PaymentCheckout.jsx';
import PaymentResult from '../../components/PaymentResult.jsx';

function QuoteFlow({ open, onClose, quote, order, onPay, onDone, freeChange }) {
  return (
    <Modal open={open} onClose={onClose} title={freeChange ? 'Change confirmed' : 'Confirm payment'}>
      {freeChange ? (
        <div className="text-center py-4">
          <div className="text-2xl mb-2"><CheckIcon /></div>
          <p className="text-sm" style={{ color: 'var(--mute)' }}>Fully covered by your unused credit — no charge, no gateway needed.</p>
          <button className="btn-primary mt-4 w-full" onClick={onDone}>Done</button>
        </div>
      ) : order ? (
        <div className="space-y-3">
          {quote?.credit > 0 && (
            <div className="text-xs rounded-lg px-3 py-2" style={{ background: 'var(--bg2)', color: 'var(--mute)' }}>
              ₹{quote.base_price?.toLocaleString('en-IN')} new price − ₹{quote.credit.toLocaleString('en-IN')} credit for your unused period
            </div>
          )}
          <PaymentCheckout order={order} onComplete={onPay} onCancel={onClose} />
        </div>
      ) : <Spinner />}
    </Modal>
  );
}

export default function EnterpriseBilling() {
  const { user } = useAuth();
  const status = useFetch(() => api('/enterprise/status'));
  const packages = useFetch(() => api('/enterprise/packages'));
  const invoices = useFetch(() => api('/enterprise/invoices'));
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState(null); // { quote, order, freeChange } | null
  const [busy, setBusy] = useState(false);
  const [customCapacity, setCustomCapacity] = useState('');
  const [addonId, setAddonId] = useState('');
  const [invoiceBusyId, setInvoiceBusyId] = useState(null);
  const [result, setResult] = useState(null);   // finished payment attempt
  const [viewing, setViewing] = useState(null); // an invoice opened from the history

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
      // api.js's own .message already prefers a response's `message`
      // over its `error` code (see that file's comment) -- covers this
      // route's own no_recipient/email_send_failed responses.
      setToast(e.message);
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
      // api.js's own .message already prefers this response's `message`
      // over its `error` code (see that file's comment) -- e.data?.message
      // was this call site's own one-off workaround for the same gap,
      // now redundant.
      setToast(e.message);
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

  /**
   * Ends on the shared PaymentResult surface rather than a toast.
   *
   * The receipt state here is genuinely two-phase and is reported as such:
   * the server issues the invoice as part of verification, so at the moment
   * verify returns we have a real payment but not yet a real invoice
   * NUMBER. The result opens with `receipt: 'generating'` (true), then the
   * invoice refetch below promotes it to `ready` with the actual invoice
   * number attached. Nothing is invented in either phase.
   */
  const onPay = async (paymentId, signature) => {
    const paidOrder = modal.order;
    const paidQuote = modal.quote;
    const knownInvoiceIds = new Set((invoices.data?.invoices || []).map((i) => i.id));
    try {
      await api('/enterprise/payment/verify', { method: 'POST', body: JSON.stringify({ orderId: paidOrder.id, providerPaymentId: paymentId, signature }) });
      setModal(null);
      setResult({
        payment: 'success',
        receipt: 'generating',
        amountLabel: `₹${Number(paidOrder.amount).toLocaleString('en-IN')}`,
        purchase: paidQuote?.description || 'SK OS subscription',
        transactionId: paymentId,
        receiptData: {
          /* `status.data?.org?.name` used to sit here and read as though it
             resolved — /enterprise/status returns no org field at all, so it
             was permanently undefined. The session is the only place the gym
             name is available on this page, and even there it can be missing
             for accounts created through paths that never captured one. When
             it is, ReceiptPrinterAnimation omits the header line rather than
             printing a placeholder, which is the correct behaviour for a
             financial document. */
          gymName: user?.orgName,
          date: new Date().toLocaleDateString(),
          currency: paidOrder.currency,
          items: [{ label: paidQuote?.description || 'SK OS subscription', amount: paidOrder.amount }],
          total: paidOrder.amount,
          transactionId: paymentId,
        },
      });
      status.reload({ silent: true });

      const fresh = await api('/enterprise/invoices').catch(() => null);
      const issued = (fresh?.invoices || []).find((i) => !knownInvoiceIds.has(i.id));
      invoices.reload({ silent: true });
      setResult((r) => (r ? {
        ...r,
        // No new invoice came back, so the receipt is genuinely not
        // available — say so, rather than leaving a spinner that never
        // resolves or inventing a document number to fill the line.
        receipt: issued ? 'ready' : 'error',
        invoice: issued || null,
        receiptData: issued ? { ...r.receiptData, number: issued.invoice_number } : r.receiptData,
      } : r));
    } catch (e) {
      /* The gateway took the money; OUR verify call failed. Calling that
         "Payment failed" would push an owner to pay twice. */
      setModal(null);
      setResult({
        payment: 'verifying',
        amountLabel: `₹${Number(paidOrder.amount).toLocaleString('en-IN')}`,
        purchase: paidQuote?.description || 'SK OS subscription',
        transactionId: paymentId,
        verifyError: e.message,
      });
    }
  };

  if (status.loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading billing">
        <div>
          <div className="skeleton-title" style={{ width: '22%' }} />
          <div className="skeleton-text mt-2" style={{ width: '58%' }} />
        </div>
        {[132, 190, 150].map((h, i) => (
          <div key={i} className="skeleton" style={{ height: h, borderRadius: 'var(--r-lg)' }} />
        ))}
      </div>
    );
  }
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
            <label className="field-label" htmlFor="custom-capacity">Custom capacity</label>
            <input id="custom-capacity" type="number" min={1} className="input mt-1.5" value={customCapacity} onChange={(e) => setCustomCapacity(e.target.value)} placeholder="e.g. 80" />
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

      {/* RECEIPT HISTORY (Part 27).
          Reachable from the payment result screen ("View receipt" scrolls
          here) and standing on its own as the record of what this gym has
          paid. Each row opens the same receipt surface a fresh payment
          shows, so "the receipt" looks identical whether you see it thirty
          seconds or thirty days after paying — rendered from the stored
          invoice row, never recomputed. */}
      <div id="receipt-history" style={{ scrollMarginTop: 80 }}>
        <div className="section-head">
          <span className="kicker !mb-0">Receipts &amp; invoices</span>
          {!!invoices.data?.invoices?.length && (
            <span className="t-sub" style={{ fontSize: '.6875rem' }}>
              {invoices.data.invoices.length} on record
            </span>
          )}
        </div>

        {invoices.loading ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton-row" />)}
          </div>
        ) : !invoices.data?.invoices?.length ? (
          <Card>
            <div className="empty-state">
              <div className="empty-state-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 3h16v18l-2.7-1.6L14.6 21 12 19.4 9.4 21l-2.7-1.6L4 21Z" /><path d="M8 8h8M8 12h8M8 16h5" />
                </svg>
              </div>
              <div className="empty-state-title">No receipts yet</div>
              <p className="empty-state-body">
                Every payment for your SK OS subscription is receipted here automatically —
                downloadable as a PDF and emailable to your accountant.
              </p>
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {invoices.data.invoices.map((inv) => (
              <div key={inv.id} className="row" style={{ flexWrap: 'wrap' }}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-grotesk text-sm font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
                      {inv.invoice_number}
                    </span>
                    {inv.emailed_at && <span className="badge badge-plain">Emailed</span>}
                  </div>
                  <div className="t-sub mt-0.5" style={{ fontSize: '.6875rem' }}>
                    {new Date(inv.issued_at).toLocaleDateString()} · {inv.subject_type.replace(/_/g, ' ').toLowerCase()}
                  </div>
                </div>
                <div className="font-grotesk font-bold tabular-nums shrink-0" style={{ color: 'var(--ink)' }}>
                  ₹{inv.amount.toLocaleString('en-IN')}
                </div>
                {/* Actions sit on their own row below 420px rather than
                    squeezing three controls and an amount onto one line. */}
                <div className="flex items-center gap-1.5 shrink-0 basis-full sm:basis-auto">
                  <button className="btn-ghost btn-sm" disabled={invoiceBusyId === inv.id}
                    onClick={() => setViewing(inv)}>View</button>
                  <button className="btn-ghost btn-sm" data-loading={invoiceBusyId === inv.id ? 'true' : undefined}
                    disabled={invoiceBusyId === inv.id} onClick={() => downloadInvoice(inv)}>PDF</button>
                  <button className="btn-ghost btn-sm" data-loading={invoiceBusyId === inv.id ? 'true' : undefined}
                    disabled={invoiceBusyId === inv.id} onClick={() => emailInvoice(inv)}>Email</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <QuoteFlow open={!!modal} onClose={() => setModal(null)} quote={modal?.quote} order={modal?.order} freeChange={modal?.freeChange}
        onPay={onPay} onDone={() => { setModal(null); status.reload({ silent: true }); }} />

      {/* Opening a stored receipt shows the SAME surface a fresh payment
          does — built from the invoice row, not recomputed. `payment` is
          hardcoded 'success' here because an issued invoice IS a completed
          payment; there is no state where this list can contain an unpaid
          one. */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title="Receipt"
        sub={viewing?.invoice_number}>
        {viewing && (
          <PaymentResult
            payment="success"
            receipt="ready"
            amountLabel={`₹${Number(viewing.amount).toLocaleString('en-IN')}`}
            purchase={viewing.subject_type.replace(/_/g, ' ').toLowerCase()}
            receiptData={{
              gymName: user?.orgName,   // see the note in onPay
              number: viewing.invoice_number,
              date: new Date(viewing.issued_at).toLocaleDateString(),
              currency: viewing.currency || 'INR',
              items: [{ label: viewing.subject_type.replace(/_/g, ' ').toLowerCase(), amount: viewing.amount }],
              total: viewing.amount,
            }}
            onDownloadReceipt={() => downloadInvoice(viewing)}
            onShareReceipt={() => emailInvoice(viewing)}
            onDone={() => setViewing(null)}
          />
        )}
      </Modal>

      <Modal open={!!result} onClose={() => setResult(null)} title="">
        {result && (
          <>
            <PaymentResult
              payment={result.payment}
              receipt={result.receipt}
              amountLabel={result.amountLabel}
              purchase={result.purchase}
              transactionId={result.transactionId}
              receiptData={result.receiptData}
              onDownloadReceipt={result.invoice ? () => downloadInvoice(result.invoice) : undefined}
              onViewReceipt={result.invoice ? () => {
                setResult(null);
                document.getElementById('receipt-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              } : undefined}
              onDone={() => setResult(null)}
            />
            {result.verifyError && (
              <p className="t-sub text-center mt-4 mx-auto" style={{ maxWidth: '38ch' }}>
                Your bank approved the payment, but we couldn&rsquo;t confirm it on our side
                ({result.verifyError}). Don&rsquo;t pay again — reload in a minute, or contact
                support with the transaction ID above.
              </p>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
