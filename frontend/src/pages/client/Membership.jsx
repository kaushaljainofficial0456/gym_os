// ============================================================
// CLIENT MEMBERSHIP — plan, status, dates, renew.
//
// The renewal flow now ends on the shared PaymentResult surface instead
// of a one-line green text box. Two things about that are deliberate:
//
//  1. Payment state and receipt state are tracked SEPARATELY (see
//     PaymentResult.jsx). If the receipt can't be produced, the headline
//     still says the payment succeeded, because it did.
//  2. The receipt is built ONLY from values this page can actually vouch
//     for — the order's own amount and currency, the gym name and plan
//     name it already fetched, and the provider payment id the gateway
//     returned. The invoice NUMBER is not among them: the verify route
//     issues an invoice server-side but doesn't return its number, so
//     that line is omitted rather than invented. A receipt that makes up
//     a document number is worse than one that is briefly incomplete.
// ============================================================
import { useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, PageHeader, ErrorState, Empty, Modal } from '../../components/UI.jsx';
import PaymentCheckout from '../../components/PaymentCheckout.jsx';
import PaymentResult from '../../components/PaymentResult.jsx';

/* Was a class-string map including `bg-white/5` for CANCELLED/REFUNDED —
   a 5% white wash, which is invisible on the light theme's near-white
   panel, so two of the six statuses had no chip background at all. */
const STATUS_BADGE = {
  ACTIVE: 'badge-good',
  PAUSED: 'badge-warn',
  SUSPENDED: 'badge-warn',
  EXPIRED: 'badge-bad',
  CANCELLED: 'badge-plain',
  REFUNDED: 'badge-plain',
};

const money = (amount, currency) =>
  `${currency === 'INR' || !currency ? '₹' : `${currency} `}${Number(amount).toLocaleString('en-IN')}`;

function MembershipSkeleton() {
  return (
    <div className="space-y-6 max-w-lg" aria-busy="true" aria-label="Loading your membership">
      <div>
        <div className="skeleton-title" style={{ width: '38%' }} />
        <div className="skeleton-text mt-2" style={{ width: '52%' }} />
      </div>
      <div className="skeleton" style={{ height: 148, borderRadius: 'var(--r-lg)' }} />
      <div className="skeleton" style={{ height: 40, width: 190, borderRadius: 'var(--r-pill)' }} />
    </div>
  );
}

export default function Membership() {
  const membership = useFetch(() => api('/enrollment/client/membership'));
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // `result` holds a finished attempt: { payment, receipt, receiptData, … }.
  // Kept as one object so the payment status and the receipt status are
  // always read from the same snapshot of the same attempt.
  const [result, setResult] = useState(null);

  const startRenew = async () => {
    setBusy(true); setErr('');
    try {
      const res = await api('/enrollment/client/renew', { method: 'POST' });
      setOrder(res.order);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const onPaid = async (paymentId, signature) => {
    setBusy(true); setErr('');
    const paidOrder = order;
    const m = membership.data?.membership;
    const gymName = membership.data?.gym?.name;
    try {
      await api('/enrollment/client/payment/verify', {
        method: 'POST',
        body: JSON.stringify({ orderId: paidOrder.id, providerPaymentId: paymentId, signature }),
      });
      setOrder(null);
      setResult({
        payment: 'success',
        // The server issues the invoice but doesn't hand its number back,
        // so the receipt renders from the transaction itself and simply
        // has no "Receipt no." line. `ready` because everything shown IS
        // available — this is not a pending state pretending to resolve.
        receipt: 'ready',
        amountLabel: money(paidOrder.amount, paidOrder.currency),
        purchase: m?.plan_name,
        transactionId: paymentId,
        receiptData: {
          gymName,
          date: new Date().toLocaleDateString(),
          currency: paidOrder.currency,
          items: m?.plan_name ? [{ label: m.plan_name, amount: paidOrder.amount }] : [],
          total: paidOrder.amount,
          transactionId: paymentId,
        },
      });
      // silent: true -- a bare reload() here would flip membership.loading
      // back to true and this page's own gate (below) would swap the
      // whole page to a skeleton right as the result screen is trying to
      // render. Same class of bug already fixed for Nutrition.jsx.
      membership.reload({ silent: true });
    } catch (e) {
      /* The gateway confirmed the charge; OUR verification call is what
         failed. Reporting that as "Payment failed" would be a lie that
         sends the user to pay a second time — so the payment stays in
         `verifying` and the error explains the actual situation. */
      setOrder(null);
      setResult({
        payment: 'verifying',
        amountLabel: money(paidOrder.amount, paidOrder.currency),
        purchase: m?.plan_name,
        transactionId: paymentId,
        verifyError: e.message,
      });
    } finally { setBusy(false); }
  };

  if (membership.loading) return <MembershipSkeleton />;
  if (membership.error) return <ErrorState error={membership.error} onRetry={membership.reload} />;
  const m = membership.data?.membership;

  if (!m) return <Empty title="No membership yet" hint="Once you join a gym, your plan and renewal will show up here." />;

  const daysLeft = Math.ceil((Date.parse(m.end_date) - Date.now()) / 86_400_000);
  const canRenew = ['ACTIVE', 'EXPIRED'].includes(m.lifecycle_status || 'ACTIVE');
  const status = m.lifecycle_status || 'ACTIVE';

  return (
    <div className="space-y-5 max-w-lg">
      <PageHeader title="Membership" sub={membership.data.gym?.name} />

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="t-card">{m.plan_name}</div>
          <span className={`badge ${STATUS_BADGE[status] || 'badge-good'} shrink-0`}>
            {status.charAt(0) + status.slice(1).toLowerCase()}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-4">
          <div>
            <div className="t-micro">Started</div>
            <div className="font-grotesk text-sm font-semibold mt-1 tabular-nums" style={{ color: 'var(--ink)' }}>
              {new Date(m.start_date).toLocaleDateString()}
            </div>
          </div>
          <div>
            <div className="t-micro">{daysLeft >= 0 ? 'Expires' : 'Expired'}</div>
            <div className="font-grotesk text-sm font-semibold mt-1 tabular-nums" style={{ color: 'var(--ink)' }}>
              {new Date(m.end_date).toLocaleDateString()}
            </div>
          </div>
        </div>

        {daysLeft >= 0 && daysLeft <= 7 && (
          <div className="row mt-4" style={{ background: 'rgb(var(--warn-rgb) / .10)', borderColor: 'rgb(var(--warn-rgb) / .3)' }}>
            <span className="t-sub" style={{ color: 'var(--ink)' }}>
              Expires in {daysLeft} day{daysLeft === 1 ? '' : 's'}. Renew below to keep your access.
            </span>
          </div>
        )}
        {daysLeft < 0 && (
          <div className="row mt-4" style={{ background: 'rgb(var(--bad-rgb) / .10)', borderColor: 'rgb(var(--bad-rgb) / .3)' }}>
            <span className="t-sub" style={{ color: 'var(--ink)' }}>This membership has expired.</span>
          </div>
        )}
      </Card>

      {err && <div className="field-error" role="alert" style={{ marginTop: 0 }}>{err}</div>}

      {canRenew && (
        <button className="btn-primary" data-loading={busy ? 'true' : undefined} disabled={busy} onClick={startRenew}>
          Renew membership
        </button>
      )}

      <Modal open={!!order} onClose={() => setOrder(null)} title="Renew membership"
        sub={membership.data.gym?.name}>
        {order && <PaymentCheckout order={order} orgName={membership.data.gym?.name}
          onComplete={onPaid} onCancel={() => setOrder(null)} />}
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
              onDone={() => setResult(null)}
            />
            {result.verifyError && (
              <p className="t-sub text-center mt-4 mx-auto" style={{ maxWidth: '36ch' }}>
                Your bank approved the payment, but we couldn&rsquo;t confirm it on our side
                ({result.verifyError}). Don&rsquo;t pay again — refresh in a minute, or contact
                your gym with the transaction ID above.
              </p>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
