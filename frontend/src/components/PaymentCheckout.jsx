/**
 * PAYMENT CHECKOUT — the ONE place any screen in this app collects a
 * payment confirmation, shared by both the gym-owner (Enterprise
 * billing) and client (membership) flows so there's exactly one
 * implementation of "what does completing a checkout look like",
 * never two drifting copies.
 *
 * Two branches, chosen by GET /api/payments/provider (server-side
 * source of truth -- this component never guesses):
 *  - 'mock' (default everywhere until real Razorpay keys are
 *    configured): a visible "Test Mode" panel with Success/Fail
 *    buttons that call POST /api/payments/mock/complete -- the actual
 *    signature is computed server-side (see paymentsDev.js), this
 *    component only relays it to `onPaymentId`/`onSignature`.
 *  - 'razorpay': loads checkout.js and opens the REAL widget. Never
 *    exercised without live keys, so this path is honestly labeled
 *    NOT YET LIVE-TESTED (matches paymentProvider.js's own comment on
 *    razorpayCreateOrder) -- it follows Razorpay's documented
 *    integration shape but has not been run against a real account.
 *
 * Either branch ends the same way: the caller's onComplete(paymentId,
 * signature) fires, and the CALLER is the one that POSTs to its own
 * verify route (/enterprise/payment/verify or
 * /enrollment/client/payment/verify) -- this component never verifies
 * anything itself, it only collects what a gateway's widget would.
 */
import { useEffect, useState } from 'react';
import { api } from '../api.js';

let razorpayScriptPromise = null;
function loadRazorpayScript() {
  if (razorpayScriptPromise) return razorpayScriptPromise;
  razorpayScriptPromise = new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve(window.Razorpay);
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(window.Razorpay);
    script.onerror = () => reject(new Error('Could not load the payment gateway'));
    document.body.appendChild(script);
  });
  return razorpayScriptPromise;
}

/**
 * `order` is a payment_orders row (has provider_order_id, amount,
 * currency). `onComplete(providerPaymentId, signature)` fires once a
 * checkout attempt (real or simulated) has produced a result to verify.
 * `razorpayKeyId` is only needed for the live branch (public key, safe
 * to ship to the browser -- never the secret).
 */
export default function PaymentCheckout({ order, orgName, onComplete, onCancel, razorpayKeyId = import.meta.env.VITE_RAZORPAY_KEY_ID }) {
  const [provider, setProvider] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api('/payments/provider').then((r) => setProvider(r.provider)).catch(() => setProvider('mock'));
  }, []);

  const runMock = async (outcome) => {
    setBusy(true); setErr('');
    try {
      const result = await api('/payments/mock/complete', { method: 'POST', body: JSON.stringify({ providerOrderId: order.provider_order_id, outcome }) });
      if (result.failed) { setErr('Payment failed (simulated).'); setBusy(false); return; }
      onComplete(result.paymentId, result.signature);
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  const runRazorpay = async () => {
    setBusy(true); setErr('');
    try {
      const Razorpay = await loadRazorpayScript();
      const rp = new Razorpay({
        key: razorpayKeyId,
        amount: Math.round(order.amount * 100),
        currency: order.currency,
        name: 'SK OS',
        description: orgName ? `${orgName} — payment` : 'Payment',
        order_id: order.provider_order_id,
        handler: (response) => {
          onComplete(response.razorpay_payment_id, response.razorpay_signature);
        },
        modal: { ondismiss: () => setBusy(false) },
        theme: { color: '#14C4BC' },
      });
      rp.on('payment.failed', (resp) => { setErr(resp?.error?.description || 'Payment failed'); setBusy(false); });
      rp.open();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  if (!provider) return <div className="text-xs" style={{ color: 'var(--mute)' }}>Preparing checkout…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs" style={{ color: 'var(--mute)' }}>Amount due</span>
        <span className="font-grotesk font-bold text-xl" style={{ color: 'var(--ink)' }}>
          {order.currency === 'INR' ? '₹' : order.currency + ' '}{order.amount.toLocaleString('en-IN')}
        </span>
      </div>

      {provider === 'mock' ? (
        <div className="rounded-xl border p-3" style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}>
          <div className="text-[10px] uppercase tracking-[.16em] font-grotesk font-semibold mb-2" style={{ color: 'var(--accent)' }}>
            Test mode — no real payment gateway configured
          </div>
          <p className="text-[11px] mb-3" style={{ color: 'var(--mute)' }}>
            SK OS is running on the built-in mock payment provider. This simulates what a real checkout would do —
            no money moves, but the same server-side signature verification runs.
          </p>
          <div className="flex gap-2">
            <button className="btn-primary flex-1 !py-2.5" disabled={busy} onClick={() => runMock('success')}>
              {busy ? 'Processing…' : 'Simulate successful payment'}
            </button>
            <button className="btn flex-1 !py-2.5" disabled={busy} onClick={() => runMock('failure')}>Simulate failure</button>
          </div>
        </div>
      ) : (
        <button className="btn-primary w-full !py-3" disabled={busy} onClick={runRazorpay}>
          {busy ? 'Opening secure checkout…' : 'Pay now'}
        </button>
      )}

      {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5">{err}</div>}
      {onCancel && <button className="btn-ghost w-full" onClick={onCancel} disabled={busy}>Cancel</button>}
    </div>
  );
}
