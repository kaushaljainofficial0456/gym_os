/**
 * RECEIPT PRINTER ANIMATION (Part 24)
 *
 * A thermal printer feeding a paper receipt: rollers turn, the print head
 * sweeps, paper feeds out, and each line lands in sequence before the
 * torn edge appears and the state settles.
 *
 * WHAT THIS COMPONENT WILL NOT DO — the important part:
 * it renders ONLY the receipt data it is handed. There is no placeholder
 * amount, no sample transaction id, no "₹1,999" baked in for the demo. If
 * a field is missing it is omitted from the receipt rather than filled
 * with something plausible-looking, because a financial document that
 * invents its own contents is worse than one that is briefly incomplete.
 * The animation is presentation only: `status` is passed in by whoever
 * owns the real payment state, and this component never infers success
 * from having finished animating.
 *
 * Zero dependencies — inline SVG for the printer, CSS keyframes (in
 * theme.css) for the motion. The app-wide `prefers-reduced-motion` rule
 * collapses every animation here to its final frame, and because each
 * keyframe uses `both` fill mode the collapsed result is the finished
 * receipt rather than an invisible one.
 *
 * States: 'printing' | 'complete' | 'error'.
 */
import { useEffect, useRef, useState } from 'react';

const currencySymbol = (c) => (c === 'INR' || !c ? '₹' : `${c} `);

function money(amount, currency) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  return `${currencySymbol(currency)}${Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** Perforated top/bottom edge, drawn as a zig-zag so the paper reads as
 *  torn from a roll rather than as a rectangle with rounded corners. */
function TornEdge({ flip }) {
  return (
    <svg viewBox="0 0 240 8" preserveAspectRatio="none" aria-hidden="true"
      style={{ display: 'block', width: '100%', height: 7, transform: flip ? 'scaleY(-1)' : undefined }}>
      <path d="M0 0 L10 8 L20 0 L30 8 L40 0 L50 8 L60 0 L70 8 L80 0 L90 8 L100 0 L110 8 L120 0 L130 8 L140 0 L150 8 L160 0 L170 8 L180 0 L190 8 L200 0 L210 8 L220 0 L230 8 L240 0 L240 0 L0 0 Z"
        fill="var(--panel)" />
    </svg>
  );
}

function Printer({ active, status }) {
  const stroke = status === 'error' ? 'rgb(var(--bad-rgb))' : 'var(--accent)';
  return (
    <svg viewBox="0 0 240 74" aria-hidden="true" style={{ display: 'block', width: '100%', maxWidth: 260, margin: '0 auto' }}>
      {/* body */}
      <rect x="18" y="10" width="204" height="46" rx="10" fill="var(--panel2)" stroke="var(--line)" strokeWidth="1.5" />
      {/* vent lines */}
      <g stroke="var(--line)" strokeWidth="2" strokeLinecap="round" opacity=".8">
        <path d="M34 22h26M34 28h26M34 34h18" />
      </g>
      {/* status lamp — colour AND motion, so it still reads without colour */}
      <circle cx="200" cy="24" r="4" fill={stroke} className={active ? 'anim-breathe' : undefined} />
      {/* paper slot */}
      <rect x="52" y="52" width="136" height="7" rx="3.5" fill="var(--bg)" stroke="var(--line)" strokeWidth="1" />
      {/* rollers, visible through the slot while feeding */}
      <g opacity={active ? 0.9 : 0.35}>
        <g className={active ? 'anim-rollerSpin' : undefined} style={{ transformOrigin: '70px 46px' }}>
          <circle cx="70" cy="46" r="5" fill="none" stroke="var(--line)" strokeWidth="1.5" />
          <path d="M70 41v10M65 46h10" stroke="var(--line)" strokeWidth="1.5" strokeLinecap="round" />
        </g>
        <g className={active ? 'anim-rollerSpin' : undefined} style={{ transformOrigin: '170px 46px' }}>
          <circle cx="170" cy="46" r="5" fill="none" stroke="var(--line)" strokeWidth="1.5" />
          <path d="M170 41v10M165 46h10" stroke="var(--line)" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      </g>
      {/* print head sweep */}
      {active && (
        <rect x="54" y="50" width="26" height="3" rx="1.5" fill={stroke} className="anim-printHead" style={{ transformBox: 'fill-box' }} />
      )}
    </svg>
  );
}

export default function ReceiptPrinterAnimation({
  status = 'printing',
  receipt,
  onDone,
  compact = false,
}) {
  const r = receipt || {};
  const lines = [];

  // Only real, supplied values reach the paper.
  if (r.gymName) lines.push(['header', r.gymName]);
  if (r.number) lines.push(['meta', 'Receipt', r.number]);
  if (r.date) lines.push(['meta', 'Date', r.date]);
  if (Array.isArray(r.items)) {
    for (const item of r.items) {
      if (!item?.label) continue;
      lines.push(['item', item.label, money(item.amount, r.currency)]);
    }
  }
  if (r.method) lines.push(['meta', 'Paid with', r.method]);
  if (r.transactionId) lines.push(['meta', 'Txn', r.transactionId]);

  const total = money(r.total, r.currency);
  const printing = status === 'printing';

  // onDone fires when the paper has finished feeding — purely a UI cue for
  // the caller (e.g. to enable the "View receipt" button). It is never a
  // signal that the payment itself succeeded.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const [fed, setFed] = useState(!printing);
  useEffect(() => {
    if (!printing) { setFed(true); return undefined; }
    setFed(false);
    const totalMs = 900 + lines.length * 90 + 250;
    const h = setTimeout(() => { setFed(true); doneRef.current?.(); }, totalMs);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printing, lines.length]);

  return (
    <div className="flex flex-col items-center" role="status" aria-live="polite"
      aria-label={printing ? 'Printing receipt' : status === 'error' ? 'Receipt could not be generated' : 'Receipt ready'}>
      {!compact && <Printer active={printing} status={status} />}

      {/* Paper. Negative margin tucks the top edge behind the printer's
          paper slot so it genuinely emerges from the machine. */}
      <div
        className={printing ? 'anim-receiptFeed' : undefined}
        style={{
          width: '100%', maxWidth: 260,
          marginTop: compact ? 0 : -4,
          filter: 'drop-shadow(0 10px 22px rgb(0 0 0 / .18))',
        }}>
        <TornEdge />
        <div style={{ background: 'var(--panel)', padding: '2px 18px 10px' }}>
          {lines.map(([kind, a, b], i) => {
            const delay = printing ? `${180 + i * 90}ms` : '0ms';
            const common = { className: 'anim-receiptLine', style: { animationDelay: delay } };
            if (kind === 'header') {
              return (
                <div key={i} {...common} style={{ ...common.style, textAlign: 'center', padding: '8px 0 6px' }}>
                  <div className="font-grotesk" style={{ fontSize: '.8125rem', fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink)' }}>{a}</div>
                  <div className="t-micro" style={{ marginTop: 4 }}>Payment receipt</div>
                  <div style={{ borderBottom: '1px dashed var(--line)', margin: '8px 0 2px' }} />
                </div>
              );
            }
            return (
              <div key={i} {...common}
                className={`${common.className} flex items-baseline justify-between gap-3`}
                style={{ ...common.style, padding: '3px 0' }}>
                <span className="font-grotesk truncate" style={{ fontSize: '.6875rem', color: kind === 'item' ? 'var(--ink)' : 'var(--mute)', fontWeight: kind === 'item' ? 550 : 400 }}>{a}</span>
                {b && <span className="font-grotesk tabular-nums shrink-0" style={{ fontSize: '.6875rem', fontWeight: kind === 'item' ? 650 : 500, color: kind === 'item' ? 'var(--ink)' : 'var(--mute)' }}>{b}</span>}
              </div>
            );
          })}

          {total && (
            <div className="anim-receiptLine" style={{ animationDelay: printing ? `${180 + lines.length * 90}ms` : '0ms' }}>
              <div style={{ borderTop: '1px dashed var(--line)', margin: '8px 0 6px' }} />
              <div className="flex items-baseline justify-between">
                <span className="font-grotesk" style={{ fontSize: '.75rem', fontWeight: 700, color: 'var(--ink)' }}>Total</span>
                <span className="font-grotesk tabular-nums" style={{ fontSize: '.9375rem', fontWeight: 800, letterSpacing: '-.02em', color: 'var(--ink)' }}>{total}</span>
              </div>
            </div>
          )}

          {/* Terminal state, printed as the last line on the paper itself. */}
          {fed && status === 'complete' && (
            <div className="anim-receiptLine flex items-center justify-center gap-1.5" style={{ paddingTop: 10 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--good-rgb))" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              <span className="font-grotesk" style={{ fontSize: '.625rem', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgb(var(--good-rgb))' }}>Paid</span>
            </div>
          )}
          {status === 'error' && (
            <div className="flex items-center justify-center gap-1.5" style={{ paddingTop: 10 }}>
              <span className="font-grotesk" style={{ fontSize: '.625rem', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgb(var(--bad-rgb))' }}>Receipt unavailable</span>
            </div>
          )}
        </div>
        <TornEdge flip />
      </div>
    </div>
  );
}
