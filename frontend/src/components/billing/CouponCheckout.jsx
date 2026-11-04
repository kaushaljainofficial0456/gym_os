// ============================================================
// COUPONS AT CHECKOUT -- shared by the first package purchase
// (EnterpriseOnboarding) and every later purchase (EnterpriseBilling).
//
// This component never computes a price. "Apply" asks the server for a
// fresh LOCKED quote with the code(s) attached (POST /enterprise/
// billing/quote { couponCodes }); the server validates the coupon,
// works out the discount and returns the quote that /payment/order will
// charge. What is shown here is exactly what the gateway will be asked
// for. Removing a coupon simply drops back to the coupon-free quote.
// ============================================================
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api.js';
import './coupon.css';

export const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', {
  minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2,
});

const offLabel = (c) => (c.discountType === 'PERCENTAGE'
  ? `${c.discountValue}% off${c.maxDiscountAmount ? ` (up to ${inr(c.maxDiscountAmount)})` : ''}`
  : `${inr(c.discountValue)} off`);

function validUntil(c) {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: c.timezone || 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(c.expiresAt));
  } catch { return null; }
}

/**
 * `request` is the purchase being priced: { kind, capacity?, addonId? }.
 * `applied` is the current coupon result ({ quote, pricing }) or null.
 * `onApplied(result|null)` hands the new locked quote up to the page,
 * which then pays with `applied.quote.id`.
 */
export function CouponField({ request, applied, onApplied, disabled = false }) {
  const inputId = useId();
  const [open, setOpen] = useState(!!applied);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const codes = applied?.pricing?.coupons?.map((c) => c.code) || [];

  useEffect(() => { if (open && !applied) inputRef.current?.focus(); }, [open, applied]);

  const requote = (nextCodes) => api('/enterprise/billing/quote', {
    method: 'POST', body: JSON.stringify({ ...request, couponCodes: nextCodes }),
  });

  const apply = async (e) => {
    e?.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) { setError('Enter a coupon code.'); return; }
    if (codes.includes(c)) { setError('This coupon is already applied.'); return; }
    setBusy(true); setError('');
    try {
      const res = await requote([...codes, c]);
      onApplied({ quote: res.quote, pricing: res.pricing });
      setCode('');
    } catch (err) {
      // The server's own reason, verbatim -- "This coupon has expired",
      // "only available for Enterprise gyms", ... (see couponEngine.js).
      setError(err.data?.message || err.message || 'This coupon could not be applied.');
    } finally { setBusy(false); }
  };

  const remove = async (c) => {
    const rest = codes.filter((x) => x !== c);
    setError('');
    if (!rest.length) { onApplied(null); return; }
    setBusy(true);
    try {
      const res = await requote(rest);
      onApplied({ quote: res.quote, pricing: res.pricing });
    } catch (err) {
      // The remaining coupons no longer fit together -- fall back to the
      // original price rather than leave a stale discount on screen.
      onApplied(null);
      setError(err.data?.message || err.message);
    } finally { setBusy(false); }
  };

  const appliedList = applied?.pricing?.coupons?.length > 0 && (
    <ul className="cpn-applied" aria-label="Applied coupons">
      {applied.pricing.coupons.map((c) => {
        const until = validUntil(c);
        return (
          <li key={c.code} className="cpn-chip">
            <div className="cpn-chip-main">
              <span className="cpn-code">{c.code}</span>
              <span className="cpn-off">{offLabel(c)}</span>
              <span className="cpn-save">−{inr(c.discountAmount)}</span>
            </div>
            <div className="cpn-meta">
              {c.description && <span>{c.description}</span>}
              <span>Applies to: {c.appliesTo}</span>
              {until && <span>Valid until {until}</span>}
            </div>
            <button type="button" className="cpn-remove" onClick={() => remove(c.code)} disabled={busy || disabled}
              aria-label={`Remove coupon ${c.code}`}>Remove</button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="cpn">
      {appliedList}
      {applied?.pricing?.message && <p className="cpn-success" role="status">{applied.pricing.message}</p>}
      {!open && !applied ? (
        <button type="button" className="cpn-toggle" onClick={() => setOpen(true)} disabled={disabled}>Have a coupon code?</button>
      ) : (
        <form className="cpn-form" onSubmit={apply} noValidate>
          <label htmlFor={inputId} className="cpn-label">{applied ? 'Add another coupon' : 'Coupon code'}</label>
          <div className="cpn-row">
            <input
              ref={inputRef} id={inputId} className="input cpn-input" value={code} maxLength={32}
              autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ENTER COUPON CODE"
              aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${inputId}-err` : undefined}
              disabled={disabled || busy} onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/\s/g, '')); setError(''); }}
            />
            <button type="submit" className="btn-primary cpn-apply" disabled={disabled || busy || !code.trim()}
              data-loading={busy ? 'true' : undefined}>{busy ? 'Checking…' : 'Apply'}</button>
          </div>
          {error && <div id={`${inputId}-err`} className="cpn-error" role="alert">{error}</div>}
        </form>
      )}
    </div>
  );
}

/**
 * The SUBSCRIPTION SUMMARY block. `original` is the plan price, `credit`
 * any upgrade credit, `pricing` the server's coupon pricing (or null).
 * The total shown is the server's total whenever a coupon is applied.
 */
export function PriceSummary({ planLabel, original, credit = 0, pricing, children }) {
  const discount = pricing?.discount || 0;
  const total = pricing ? pricing.total : Math.max(0, Math.round((Number(original) - Number(credit || 0)) * 100) / 100);
  return (
    <section className="cpn-summary" aria-label="Subscription summary">
      <div className="cpn-summary-kicker">Subscription summary</div>
      {planLabel && <div className="cpn-line"><span>Selected plan</span><span className="cpn-strong">{planLabel}</span></div>}
      <div className="cpn-line"><span>Original price</span><span className="cpn-num">{inr(original)}</span></div>
      {Number(credit) > 0 && <div className="cpn-line"><span>Credit for unused period</span><span className="cpn-num">−{inr(credit)}</span></div>}
      {children}
      {pricing?.coupons?.map((c) => (
        <div key={c.code} className="cpn-line is-discount">
          <span>Coupon {c.code} <span className="cpn-muted">({offLabel(c)})</span></span>
          <span className="cpn-num">−{inr(c.discountAmount)}</span>
        </div>
      ))}
      <div className="cpn-line is-total" aria-live="polite">
        <span>Total payable</span>
        <span className="cpn-num">{inr(total)}</span>
      </div>
      {discount > 0 && <div className="cpn-saved">You saved {inr(discount)}!</div>}
    </section>
  );
}
