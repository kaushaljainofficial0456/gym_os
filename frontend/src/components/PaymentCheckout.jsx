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

/** Razorpay's widget takes a literal hex, not a CSS variable, so the live
 *  token value is read off the document at call time. Falls back to the
 *  dark-mode accent if the variable can't be resolved (SSR/edge cases). */
function readAccentHex() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw;
  } catch { /* fall through to the default below */ }
  return '#E07A63';
}

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
        /* Was '#14C4BC' — a teal from a palette two repaints ago, which
           meant the ONE screen a paying customer sees rendered the gateway
           in a colour the product no longer uses anywhere. Read from the
           live accent token so it can never drift again. */
        theme: { color: readAccentHex() },
      });
      rp.on('payment.failed', (resp) => { setErr(resp?.error?.description || 'Payment failed'); setBusy(false); });
      rp.open();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  if (!provider) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="skeleton-text" style={{ width: '45%' }} />
        <div className="skeleton" style={{ height: 48, borderRadius: 'var(--r-md)' }} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* The amount is the single most important thing on a checkout —
          it gets the metric treatment, not a body-text weight. */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="t-micro">Amount due</span>
        <span className="font-grotesk tabular-nums" style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-.03em', color: 'var(--ink)' }}>
          {order.currency === 'INR' ? '₹' : `${order.currency} `}{order.amount.toLocaleString('en-IN')}
        </span>
      </div>

      {provider === 'mock' ? (
        <div style={{ borderRadius: 'var(--r-md)', border: '1px solid rgb(var(--warn-rgb) / .35)', background: 'rgb(var(--warn-rgb) / .08)', padding: 14 }}>
          <div className="badge badge-warn mb-2">Test mode</div>
          <p className="t-sub" style={{ fontSize: '.75rem' }}>
            No real payment gateway is configured, so this simulates a checkout — no money moves, but the same
            server-side signature verification runs.
          </p>
          <div className="flex gap-2 mt-3">
            <button className="btn-primary flex-1" data-loading={busy ? 'true' : undefined} disabled={busy} onClick={() => runMock('success')}>
              Simulate success
            </button>
            <button className="btn flex-1" disabled={busy} onClick={() => runMock('failure')}>Simulate failure</button>
          </div>
        </div>
      ) : (
        <button className="btn-primary btn-lg btn-block" data-loading={busy ? 'true' : undefined} disabled={busy} onClick={runRazorpay}>
          Pay {order.currency === 'INR' ? '₹' : `${order.currency} `}{order.amount.toLocaleString('en-IN')}
        </button>
      )}

      {err && (
        <div className="field-error" role="alert" style={{ marginTop: 0 }}>{err}</div>
      )}
      {onCancel && <button className="btn-ghost btn-block" onClick={onCancel} disabled={busy}>Cancel</button>}

      {/* Trust cue: people abandon checkouts that don't say who is handling
          the money. One quiet line, not a badge farm. */}
      <p className="t-sub text-center" style={{ fontSize: '.6875rem' }}>
        Payments are verified server-side. SK OS never stores your card details.
      </p>
    </div>
  );
}
