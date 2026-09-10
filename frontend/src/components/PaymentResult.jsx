/**
 * PAYMENT RESULT (Parts 25–27)
 *
 * The screen shown after a checkout attempt resolves. Two pieces of state,
 * deliberately kept SEPARATE:
 *
 *   payment  — 'processing' | 'success' | 'failed' | 'cancelled'
 *              | 'verifying' | 'refund_pending' | 'refunded'
 *   receipt  — 'generating' | 'ready' | 'error'   (optional)
 *
 * Why separate: Part 26's hard rule is that a receipt problem must never
 * be reported as a payment problem. If the provider confirmed the money
 * and only the PDF generation failed, this shows "Payment successful ✓"
 * with a quiet "still generating your receipt" note and a retry for the
 * receipt alone — the payment headline never flips to failed because a
 * downstream document job did. A single merged status enum is exactly how
 * that bug gets written, so the type here makes it impossible to express.
 *
 * This component renders state; it never derives it. It does not decide
 * that a payment succeeded, does not poll, and does not treat the receipt
 * animation finishing as confirmation of anything.
 */
import ReceiptPrinterAnimation from './ReceiptPrinterAnimation.jsx';
import { Button } from './UI.jsx';

const PAYMENT_META = {
  processing: {
    tone: 'accent', title: 'Processing payment',
    body: 'Hold on while we confirm this with your bank. Don’t close this screen.',
  },
  verifying: {
    tone: 'accent', title: 'Verifying payment',
    body: 'Your bank approved this. We’re confirming it on our side before activating your plan.',
  },
  success: {
    tone: 'good', title: 'Payment successful',
    body: null,
  },
  failed: {
    tone: 'bad', title: 'Payment failed',
    body: 'No money was taken. You can try again, or use a different payment method.',
  },
  cancelled: {
    tone: 'mute', title: 'Payment cancelled',
    body: 'You closed the checkout before it finished. Nothing was charged.',
  },
  refund_pending: {
    tone: 'warn', title: 'Refund in progress',
    body: 'Your refund has been requested. Banks usually take 5–7 working days to complete it.',
  },
  refunded: {
    tone: 'good', title: 'Refunded',
    body: 'This payment has been refunded in full.',
  },
};

const TONE_COLOR = {
  accent: 'var(--accent)',
  good: 'rgb(var(--good-rgb))',
  warn: 'rgb(var(--warn-rgb))',
  bad: 'rgb(var(--bad-rgb))',
  mute: 'var(--mute)',
};

function StatusMark({ tone, spinning }) {
  const color = TONE_COLOR[tone] || 'var(--accent)';
  const path = tone === 'good' ? 'M20 6 9 17l-5-5'
    : tone === 'bad' ? 'M18 6 6 18M6 6l12 12'
      : tone === 'warn' ? 'M12 8v5M12 17h.01'
        : 'M12 6v6l4 2';
  return (
    <div className="grid place-items-center mx-auto shrink-0"
      style={{ width: 60, height: 60, borderRadius: '50%', background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>
      {spinning
        ? <span style={{ width: 22, height: 22, borderRadius: '50%', border: `2.5px solid color-mix(in srgb, ${color} 25%, transparent)`, borderTopColor: color, animation: 'so-spin .7s linear infinite' }} />
        : (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
            className={tone === 'good' ? 'anim-checkBounce' : undefined}>
            <path d={path} />
          </svg>
        )}
    </div>
  );
}

function DetailRow({ label, value, mono }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-2" style={{ borderBottom: '1px solid var(--line)' }}>
      <span className="font-grotesk shrink-0" style={{ fontSize: '.75rem', color: 'var(--mute)' }}>{label}</span>
      <span className={`font-grotesk text-right ${mono ? 'tabular-nums' : ''}`}
        style={{ fontSize: '.8125rem', fontWeight: 600, color: 'var(--ink)', wordBreak: mono ? 'break-all' : 'normal' }}>{value}</span>
    </div>
  );
}

export default function PaymentResult({
  payment = 'processing',
  receipt,                 // 'generating' | 'ready' | 'error' | undefined
  amountLabel,             // e.g. "₹12,000" — formatted by the caller, which owns the real number
  purchase,                // "Pro plan — 50 clients"
  method,                  // "UPI · ****4821"
  transactionId,
  receiptData,             // shape consumed by ReceiptPrinterAnimation
  onViewReceipt, onDownloadReceipt, onShareReceipt,
  onRetryPayment, onRetryReceipt, onDone,
}) {
  const meta = PAYMENT_META[payment] || PAYMENT_META.processing;
  const paid = payment === 'success' || payment === 'refund_pending' || payment === 'refunded';
  const inFlight = payment === 'processing' || payment === 'verifying';

  return (
    <div className="text-center">
      <StatusMark tone={meta.tone} spinning={inFlight} />

      <h2 className="t-section mt-4">{meta.title}</h2>
      {amountLabel && paid && (
        <div className="t-metric mt-1.5" style={{ fontSize: '2rem' }}>{amountLabel}</div>
      )}
      {meta.body && <p className="t-sub mt-2 mx-auto" style={{ maxWidth: '34ch' }}>{meta.body}</p>}

      {/* Receipt status is reported on its own line, never folded into the
          payment headline above (Part 26). */}
      {paid && receipt === 'generating' && (
        <p className="t-sub mt-2 mx-auto" style={{ maxWidth: '34ch' }}>We’re still generating your receipt.</p>
      )}
      {paid && receipt === 'error' && (
        <div className="mt-3 mx-auto text-left" style={{ maxWidth: 320 }}>
          <div className="row" style={{ background: 'rgb(var(--warn-rgb) / .10)', borderColor: 'rgb(var(--warn-rgb) / .28)' }}>
            <div className="min-w-0 flex-1">
              <div className="font-grotesk" style={{ fontSize: '.8125rem', fontWeight: 650, color: 'var(--ink)' }}>Receipt not ready</div>
              <div className="t-sub" style={{ fontSize: '.75rem' }}>Your payment went through. Only the receipt failed to generate.</div>
            </div>
            {onRetryReceipt && <Button variant="secondary" size="sm" onClick={onRetryReceipt}>Retry</Button>}
          </div>
        </div>
      )}

      {(purchase || method || transactionId) && (
        <div className="mt-5 text-left mx-auto" style={{ maxWidth: 340 }}>
          <DetailRow label="For" value={purchase} />
          <DetailRow label="Paid with" value={method} />
          <DetailRow label="Transaction" value={transactionId} mono />
        </div>
      )}

      {paid && receiptData && receipt !== 'error' && (
        <div className="mt-6">
          <ReceiptPrinterAnimation
            status={receipt === 'generating' ? 'printing' : 'complete'}
            receipt={receiptData}
          />
        </div>
      )}

      <div className="mt-6 flex flex-col gap-2 mx-auto" style={{ maxWidth: 340 }}>
        {paid && receipt === 'ready' && onViewReceipt && (
          <Button variant="primary" onClick={onViewReceipt}>View receipt</Button>
        )}
        {paid && receipt === 'ready' && (onDownloadReceipt || onShareReceipt) && (
          <div className="flex gap-2">
            {onDownloadReceipt && <Button variant="default" className="flex-1" onClick={onDownloadReceipt}>Download PDF</Button>}
            {onShareReceipt && <Button variant="default" className="flex-1" onClick={onShareReceipt}>Share</Button>}
          </div>
        )}
        {(payment === 'failed' || payment === 'cancelled') && onRetryPayment && (
          <Button variant="primary" onClick={onRetryPayment}>Try again</Button>
        )}
        {onDone && !inFlight && (
          <Button variant="ghost" onClick={onDone}>Done</Button>
        )}
      </div>
    </div>
  );
}
