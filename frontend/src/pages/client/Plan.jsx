/**
 * THE BARBELL PLAN -- for independent clients, who have no gym paying for
 * them. Everything is free for 14 days; after that, ₹59 a month or ₹590 a
 * year keeps it going. Also what a locked account sees in place of any
 * other screen (ClientLayout), so there is always a way back in.
 *
 * Choosing a plan opens a short checkout: the price, an optional coupon
 * code (founder-issued, see docs/COUPONS.md), then the payment. This page
 * never works out a price: the coupon is priced by /plan/quote, and
 * /plan/order prices it again on the server and charges exactly that.
 *
 * Gym members never get here: their gym covers Barbell, and the server
 * says so (`applies: false`).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadFile } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, PageHeader, Modal, PageSkeleton, ErrorState } from '../../components/UI.jsx';
import PaymentCheckout from '../../components/PaymentCheckout.jsx';
import { CouponField, PriceSummary, inr } from '../../components/billing/CouponCheckout.jsx';

const money = inr;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export default function Plan({ locked = false }) {
  const status = useFetch(() => api('/plan/status'));
  // { plan, applied, order } | null while no checkout is open.
  //   plan     the plan being bought (from /plan/status)
  //   applied  { pricing } once a coupon is applied, else null
  //   order    the gateway order, once payment has started
  const [checkout, setCheckout] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  if (status.loading) return <PageSkeleton />;
  if (status.error) return <ErrorState error={status.error} onRetry={status.reload} />;
  const s = status.data;
  if (!s?.applies) {
    return (
      <div className="space-y-4">
        <PageHeader title="Barbell plan" />
        <Card className="p-4"><p className="t-sub">Your gym membership covers Barbell. There is nothing to pay here.</p></Card>
      </div>
    );
  }

  const choose = (plan) => { setErr(''); setDone(''); setCheckout({ plan, applied: null, order: null }); };

  // Leaving before paying gives the coupon back straight away, so trying
  // again is not refused as "already used" while the hold runs out.
  const close = () => {
    const open = checkout?.order;
    if (open) api(`/plan/order/${open.id}/cancel`, { method: 'POST', body: '{}' }).catch(() => {});
    setCheckout(null);
  };

  const pay = async () => {
    const { plan, applied } = checkout;
    const couponCodes = applied?.pricing?.coupons?.map((c) => c.code) || [];
    setBusy(true); setErr('');
    try {
      const r = await api('/plan/order', {
        method: 'POST', body: JSON.stringify(couponCodes.length ? { plan: plan.id, couponCodes } : { plan: plan.id }),
      });
      setCheckout((c) => ({ ...c, order: r.order }));
    } catch (e) {
      // The coupon was valid at Apply but not any more (switched off,
      // expired, used up): say why, and fall back to the full price
      // rather than charge something the client did not agree to.
      if (e.data?.error === 'coupon_unavailable' || e.data?.error === 'coupon_invalid') {
        setCheckout((c) => ({ ...c, applied: null }));
      }
      setErr(e.data?.message || e.message || 'Could not start the payment. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onPaid = async (providerPaymentId, signature) => {
    const paid = checkout.order;
    setCheckout(null);
    try {
      const r = await api('/plan/verify', { method: 'POST', body: JSON.stringify({ orderId: paid.id, providerPaymentId, signature }) });
      setDone(`Paid. Barbell is yours until ${day(r.status.paidUntil)}.`);
      status.reload({ silent: true });
      window.dispatchEvent(new CustomEvent('barbell:plan-paid', { detail: { paidUntil: r.status.paidUntil } }));
    } catch (e) {
      if (e.data?.error === 'payment_held_for_review') {
        // Paid, but the coupon ran out before the payment confirmed: the
        // server held it for a founder to refund or honour (its own words).
        setErr(e.data.message);
        return;
      }
      // The gateway took the money; our confirmation is what failed. Paying
      // again would charge twice, so say what actually happened.
      setErr(`Your bank approved the payment, but we couldn't confirm it (${e.message}). Don't pay again; refresh in a minute, or contact support.`);
    }
  };

  const download = async (r) => {
    try { await downloadFile(`/plan/receipts/${r.id}/pdf`, `${r.number}.pdf`); }
    catch (e) { setErr(e.message || 'Could not download the receipt.'); }
  };

  const headline = s.access === 'active'
    ? `Your plan runs until ${day(s.paidUntil)}`
    : s.access === 'trial'
      ? `${s.trialDaysLeft} ${s.trialDaysLeft === 1 ? 'day' : 'days'} left in your free trial`
      : 'Your free trial has ended';
  const sub = s.access === 'locked'
    ? 'Choose a plan to keep your workouts, meals and progress going. Everything you logged is still here.'
    : s.access === 'trial'
      ? `Everything is free until ${day(s.trialEndsAt)}. After that, a plan keeps it going.`
      : 'Paying early adds to the time you already have; you never lose days.';

  const plan = checkout?.plan;
  const total = checkout?.applied?.pricing?.total ?? plan?.amount;

  return (
    <div className="space-y-4">
      <PageHeader title={locked ? 'Keep training with Barbell' : 'Barbell plan'} sub={headline} />
      <Card className="p-4">
        <p className="t-sub">{sub}</p>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {s.plans.map((p) => (
          <Card key={p.id} className="p-4 flex flex-col">
            <div className="kicker">{p.name}</div>
            <div className="font-grotesk font-black text-3xl tabular-nums" style={{ color: 'var(--ink)' }}>
              {money(p.amount)}<span className="text-sm font-semibold text-mute"> / {p.id === 'yearly' ? 'year' : 'month'}</span>
            </div>
            <p className="text-sm mt-1" style={{ color: p.id === 'yearly' ? 'var(--good)' : 'var(--mute)' }}>{p.line}</p>
            <button type="button" className={`${p.id === 'yearly' ? 'btn-primary' : 'btn'} w-full mt-4`} disabled={!!checkout} onClick={() => choose(p)}>
              {`Choose ${p.name.toLowerCase()}`}
            </button>
          </Card>
        ))}
      </div>

      {done && <div className="row" role="status" style={{ background: 'rgb(var(--good-rgb) / .10)' }}><span className="t-sub" style={{ color: 'var(--ink)' }}>{done}</span></div>}
      {err && !checkout && <div className="field-error" role="alert">{err}</div>}

      {s.receipts.length > 0 && (
        <Card className="p-4">
          <div className="t-micro mb-2.5">Receipts</div>
          <div className="space-y-2">
            {s.receipts.map((r) => (
              <div key={r.id} className="rounded-xl px-3 py-2.5 flex items-center justify-between gap-3" style={{ border: '1px solid var(--line)' }}>
                <div className="min-w-0">
                  <div className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{money(r.amount)} · {r.plan === 'yearly' ? 'Yearly' : 'Monthly'}</div>
                  {r.coupons?.length > 0 && (
                    <div className="text-[11px] tabular-nums" style={{ color: 'var(--mute)' }}>
                      {money(r.originalAmount)}{r.coupons.map((c) => ` − ${c.code} ${money(c.discountAmount)}`).join('')}
                    </div>
                  )}
                  <div className="text-[10.5px]" style={{ color: 'var(--faint)' }}>{day(r.periodStart)} to {day(r.periodEnd)} · {r.number}</div>
                </div>
                <button type="button" className="btn btn-sm shrink-0" onClick={() => download(r)}>Receipt</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {locked && (
        <p className="text-xs text-center" style={{ color: 'var(--faint)' }}>
          Training at a gym? Join it with its QR code and your gym covers Barbell. <Link to="/app/client/settings" className="underline">Account settings</Link> (export or delete your data) stay open.
        </p>
      )}

      <Modal open={!!checkout} onClose={close} title={checkout?.order ? 'Confirm payment' : 'Barbell plan'}
        sub={plan ? `${plan.name} · ${money(checkout?.order ? checkout.order.amount : total)}` : ''}>
        {checkout?.order ? (
          <PaymentCheckout order={checkout.order} orgName="Barbell" onComplete={onPaid} onCancel={close} />
        ) : plan ? (
          <div>
            <PriceSummary planLabel={`${plan.name} · ${plan.line}`} original={plan.amount} pricing={checkout.applied?.pricing} />
            <CouponField endpoint="/plan/quote" request={{ plan: plan.id }} applied={checkout.applied} disabled={busy}
              onApplied={(applied) => { setErr(''); setCheckout((c) => ({ ...c, applied })); }} />
            {err && <div className="field-error mt-3" role="alert">{err}</div>}
            <button type="button" className="btn-primary w-full mt-5" disabled={busy} data-loading={busy ? 'true' : undefined} onClick={pay}>
              {busy ? 'Preparing payment…' : `Pay ${money(total)}`}
            </button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
