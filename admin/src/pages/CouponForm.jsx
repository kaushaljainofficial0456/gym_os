// ============================================================
// CREATE / EDIT / DUPLICATE A COUPON.
//   /coupons/new            create
//   /coupons/new?from=:id   duplicate (same settings, new code)
//   /coupons/:id/edit       edit
// Written for a founder, not an engineer: plain-language choices, a
// live preview of what a gym would actually pay, and every rule the
// server enforces explained next to the control it applies to. The
// server re-validates everything -- these checks are only for speed.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, moneyExact } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import { SkeletonBlock } from '../components/Skeleton.jsx';

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const twoDp = (s) => /^\d+(\.\d{1,2})?$/.test(String(s).trim());
const todayIst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const BLANK = {
  code: '', internalName: '', description: '',
  discountType: 'PERCENTAGE', discountValue: '', maxDiscountAmount: '', minimumPurchaseAmount: '',
  customerType: '', firstTimeOnly: false,
  kindsMode: 'ALL', applicableKinds: [], tiersMode: 'ALL', applicableTiers: [], durationsMode: 'ALL', applicableDurations: [],
  startsDate: todayIst(), startsTime: '00:00', expiresDate: '', expiresTime: '23:59', timezone: 'Asia/Kolkata',
  usageMode: 'UNLIMITED', maxRedemptions: '', perCustomerMode: 'LIMITED', maxRedemptionsPerCustomer: '1',
  allowStacking: false, enabled: true, founderNotes: '',
};

function fromCoupon(c, { duplicate = false } = {}) {
  return {
    code: duplicate ? '' : c.code,
    internalName: duplicate ? `${c.internal_name} (copy)` : c.internal_name,
    description: c.description || '',
    discountType: c.discount_type,
    discountValue: String(c.discount_value),
    maxDiscountAmount: c.max_discount_amount != null ? String(c.max_discount_amount) : '',
    minimumPurchaseAmount: c.minimum_purchase_amount != null ? String(c.minimum_purchase_amount) : '',
    customerType: c.customer_type,
    firstTimeOnly: !!c.first_time_only,
    kindsMode: c.applicable_kinds ? 'SELECTED' : 'ALL', applicableKinds: c.applicable_kinds || [],
    tiersMode: c.applicable_tiers ? 'SELECTED' : 'ALL', applicableTiers: c.applicable_tiers || [],
    durationsMode: c.applicable_durations ? 'SELECTED' : 'ALL', applicableDurations: (c.applicable_durations || []).map(String),
    startsDate: duplicate ? todayIst() : c.starts_local?.date, startsTime: duplicate ? '00:00' : c.starts_local?.time,
    expiresDate: c.expires_local?.date, expiresTime: c.expires_local?.time, timezone: c.timezone,
    usageMode: c.max_redemptions == null ? 'UNLIMITED' : c.max_redemptions === 1 ? 'ONCE' : 'LIMITED',
    maxRedemptions: c.max_redemptions != null && c.max_redemptions !== 1 ? String(c.max_redemptions) : '',
    perCustomerMode: c.max_redemptions_per_customer == null ? 'UNLIMITED' : 'LIMITED',
    maxRedemptionsPerCustomer: c.max_redemptions_per_customer != null ? String(c.max_redemptions_per_customer) : '1',
    allowStacking: !!c.allow_stacking, enabled: duplicate ? true : !!c.is_enabled, founderNotes: c.founder_notes || '',
  };
}

/** Avoids look-alike characters (O/0, I/1) so a code read aloud or off a
 *  poster can't be mistyped. */
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'BARBELL-' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** PREVIEW ONLY -- mirrors the server's rule (paise maths, cap, never
 *  below Rs 1) so the founder sees a realistic number. The amount a gym
 *  is charged is always recomputed by the server at checkout. */
function previewDiscount(form, price) {
  const v = Number(form.discountValue);
  if (!(v > 0) || !(price > 0)) return null;
  const p = Math.round(price * 100);
  let d = form.discountType === 'PERCENTAGE' ? Math.round((p * v) / 100) : Math.round(v * 100);
  if (form.discountType === 'PERCENTAGE' && Number(form.maxDiscountAmount) > 0) d = Math.min(d, Math.round(Number(form.maxDiscountAmount) * 100));
  d = Math.max(0, Math.min(d, p - 100));
  return { original: price, discount: d / 100, total: (p - d) / 100 };
}

function tzShort(tz) {
  try {
    return new Intl.DateTimeFormat('en-IN', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value || tz;
  } catch { return tz; }
}
function prettyLocal(date, time, tz) {
  if (!date) return '—';
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  const day = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const [h, m] = (time || '00:00').split(':').map(Number);
  const t = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return `${day}, ${t} ${tzShort(tz)}`;
}

function validate(form, { locked }) {
  const e = {};
  const code = form.code.trim().toUpperCase();
  if (!locked.includes('code') && !CODE_RE.test(code)) e.code = '3–32 characters: letters, numbers, - or _, starting with a letter or number.';
  if (!form.internalName.trim()) e.internalName = 'Give it a name you will recognise later.';
  if (!twoDp(form.discountValue) || !(Number(form.discountValue) > 0)) e.discountValue = 'Enter a positive amount (up to 2 decimals).';
  else if (form.discountType === 'PERCENTAGE' && Number(form.discountValue) >= 100) e.discountValue = 'Must be less than 100% — coupons can never make a subscription free.';
  if (form.discountType === 'PERCENTAGE' && form.maxDiscountAmount !== '' && (!twoDp(form.maxDiscountAmount) || !(Number(form.maxDiscountAmount) > 0))) e.maxDiscountAmount = 'Enter a positive amount, or leave empty for no cap.';
  if (form.minimumPurchaseAmount !== '' && !twoDp(form.minimumPurchaseAmount)) e.minimumPurchaseAmount = 'Enter an amount, or leave empty for no minimum.';
  if (!form.customerType) e.customerType = 'Choose who can use this coupon.';
  if (form.kindsMode === 'SELECTED' && !form.applicableKinds.length) e.applicableKinds = 'Pick at least one purchase type.';
  if (form.tiersMode === 'SELECTED' && !form.applicableTiers.length) e.applicableTiers = 'Pick at least one capacity tier.';
  if (form.durationsMode === 'SELECTED' && !form.applicableDurations.length) e.applicableDurations = 'Pick at least one billing duration.';
  if (!form.startsDate || !form.startsTime) e.starts = 'Choose a start date and time.';
  if (!form.expiresDate || !form.expiresTime) e.expires = 'Choose an expiry date and time.';
  else if (form.startsDate && `${form.expiresDate}T${form.expiresTime}` <= `${form.startsDate}T${form.startsTime}`) e.expires = 'Expiry must be after the start.';
  if (form.usageMode === 'LIMITED' && !(Number.isInteger(Number(form.maxRedemptions)) && Number(form.maxRedemptions) >= 1)) e.maxRedemptions = 'Enter a whole number, 1 or more.';
  if (form.perCustomerMode === 'LIMITED') {
    const n = Number(form.maxRedemptionsPerCustomer);
    if (!(Number.isInteger(n) && n >= 1)) e.maxRedemptionsPerCustomer = 'Enter a whole number, 1 or more.';
    const total = form.usageMode === 'ONCE' ? 1 : form.usageMode === 'LIMITED' ? Number(form.maxRedemptions) : null;
    if (!e.maxRedemptionsPerCustomer && total && n > total) e.maxRedemptionsPerCustomer = 'Cannot be more than the total limit.';
  }
  return e;
}

function toBody(form) {
  const pct = form.discountType === 'PERCENTAGE';
  return {
    code: form.code.trim().toUpperCase(),
    internalName: form.internalName.trim(),
    description: form.description.trim() || null,
    discountType: form.discountType,
    discountValue: Number(form.discountValue),
    maxDiscountAmount: pct && form.maxDiscountAmount !== '' ? Number(form.maxDiscountAmount) : null,
    minimumPurchaseAmount: form.minimumPurchaseAmount !== '' ? Number(form.minimumPurchaseAmount) : null,
    customerType: form.customerType,
    applicableKinds: form.kindsMode === 'SELECTED' ? form.applicableKinds : null,
    applicableTiers: form.tiersMode === 'SELECTED' ? form.applicableTiers : null,
    applicableDurations: form.durationsMode === 'SELECTED' ? form.applicableDurations.map(Number) : null,
    startsDate: form.startsDate, startsTime: form.startsTime,
    expiresDate: form.expiresDate, expiresTime: form.expiresTime, timezone: form.timezone,
    maxRedemptions: form.usageMode === 'UNLIMITED' ? null : form.usageMode === 'ONCE' ? 1 : Number(form.maxRedemptions),
    maxRedemptionsPerCustomer: form.perCustomerMode === 'UNLIMITED' ? null : Number(form.maxRedemptionsPerCustomer),
    firstTimeOnly: form.firstTimeOnly,
    allowStacking: form.allowStacking,
    enabled: form.enabled,
    founderNotes: form.founderNotes.trim() || null,
  };
}

// Server error codes -> the field they belong to, so a refusal lands
// next to the control the founder has to change.
const SERVER_FIELD = {
  duplicate_code: 'code', invalid_code: 'code', invalid_discount: 'discountValue', invalid_discount_cap: 'maxDiscountAmount',
  invalid_minimum: 'minimumPurchaseAmount', invalid_customer_type: 'customerType', invalid_start: 'starts', invalid_expiry: 'expires',
  invalid_window: 'expires', invalid_timezone: 'expires', invalid_tier: 'applicableTiers', invalid_duration: 'applicableDurations',
  invalid_limits: 'maxRedemptions', invalid_kind: 'applicableKinds',
};

function Field({ id, label, hint, error, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <div className="field-error" id={`${id}-err`} role="alert">{error}</div>
        : hint ? <div className="field-hint" id={`${id}-hint`}>{hint}</div> : null}
    </div>
  );
}
const aria = (id, error, hint) => ({ id, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': error ? `${id}-err` : hint ? `${id}-hint` : undefined });

function Seg({ name, value, onChange, options, disabled }) {
  return (
    <div className="seg" role="radiogroup" aria-label={name}>
      {options.map(([v, l]) => (
        <label key={v}>
          <input type="radio" name={name} value={v} checked={value === v} disabled={disabled} onChange={() => onChange(v)} />
          <span>{l}</span>
        </label>
      ))}
    </div>
  );
}

function Toggle({ id, checked, onChange, title, description }) {
  return (
    <div className="toggle-row">
      <label className="switch" htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={`${id}-d`} />
        <span className="track" />
      </label>
      <div>
        <label htmlFor={id} className="t" style={{ cursor: 'pointer' }}>{title}</label>
        <div className="d" id={`${id}-d`}>{description}</div>
      </div>
    </div>
  );
}

function Pills({ legend, options, selected, onChange, error }) {
  const toggle = (v) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <fieldset style={{ border: 0, padding: 0, margin: '10px 0 0' }} aria-invalid={error ? 'true' : undefined}>
      <legend className="sr-only" style={{ position: 'absolute', left: -9999 }}>{legend}</legend>
      <div className="check-list">
        {options.map((o) => (
          <label key={o.value} className="check-pill">
            <input type="checkbox" checked={selected.includes(String(o.value))} onChange={() => toggle(String(o.value))} />
            {o.label}
          </label>
        ))}
      </div>
      {error && <div className="field-error" role="alert">{error}</div>}
    </fieldset>
  );
}

export default function CouponForm() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const fromId = params.get('from');
  const editing = !!id;
  const sourceId = id || fromId;
  const nav = useNavigate();
  const toast = useToast();

  const options = useFetch(() => api('/console/coupons/options'));
  const source = useFetch(() => (sourceId ? api(`/console/coupons/${sourceId}`) : Promise.resolve(null)), [sourceId]);
  const [form, setForm] = useState(BLANK);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewTier, setPreviewTier] = useState('');

  const coupon = source.data?.coupon || null;
  const locked = editing && coupon?.locked_fields ? coupon.locked_fields : [];
  const isLocked = (f) => locked.includes(f);

  useEffect(() => {
    if (coupon) setForm(fromCoupon(coupon, { duplicate: !editing }));
  }, [coupon, editing]);
  useEffect(() => {
    if (!previewTier && options.data?.tiers?.length) setPreviewTier(options.data.tiers[Math.min(1, options.data.tiers.length - 1)].value);
  }, [options.data, previewTier]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const tier = options.data?.tiers?.find((t) => t.value === previewTier);
  const preview = useMemo(() => previewDiscount(form, tier?.price), [form, tier]);
  const minNotMet = tier && form.minimumPurchaseAmount !== '' && Number(form.minimumPurchaseAmount) > tier.price;

  const submit = async (ev) => {
    ev.preventDefault();
    setFormError('');
    const e = validate(form, { locked });
    setErrors(e);
    if (Object.keys(e).length) {
      setFormError('Please fix the highlighted fields.');
      const first = document.querySelector('[aria-invalid="true"]');
      first?.focus?.();
      return;
    }
    setSaving(true);
    try {
      const body = toBody(form);
      const res = editing
        ? await api(`/console/coupons/${id}`, { method: 'POST', body: JSON.stringify(body) })
        : await api('/console/coupons', { method: 'POST', body: JSON.stringify(body) });
      toast.success(editing ? `${res.coupon.code} saved` : `${res.coupon.code} created`);
      nav(`/coupons/${res.coupon.id}`);
    } catch (err) {
      const field = SERVER_FIELD[err.data?.error];
      if (field) setErrors((x) => ({ ...x, [field]: err.data?.message || err.message }));
      setFormError(err.data?.message || err.message);
      toast.error(err.data?.message || err.message || 'Could not save the coupon');
    } finally { setSaving(false); }
  };

  if (options.loading || (sourceId && source.loading)) return <div><SkeletonBlock height={120} /><div style={{ height: 14 }} /><SkeletonBlock height={420} /></div>;
  if (options.error) return <div className="error-text">{options.error.message}</div>;
  if (sourceId && source.error) return <div className="error-text">{source.error.message}</div>;

  const o = options.data;
  const title = editing ? `Edit ${coupon?.code || 'coupon'}` : fromId ? `Duplicate ${coupon?.code || 'coupon'}` : 'Create coupon';
  const pct = form.discountType === 'PERCENTAGE';
  const indieSelected = form.customerType === 'INDEPENDENT' || form.customerType === 'BOTH';

  return (
    <div>
      <div className="page-header">
        <p style={{ marginBottom: 8 }}><Link to="/coupons">← Coupon Management</Link></p>
        <h1>{title}</h1>
        <p>{editing ? 'Changes apply to future checkouts only — purchases already made keep exactly what they paid.' : 'Gyms enter the code at checkout; the discount is calculated and charged by the server.'}</p>
      </div>

      {locked.length > 0 && (
        <div className="notice info" style={{ marginTop: 0, marginBottom: 18 }}>
          This coupon has already been used, so its code, discount and customer type are locked. You can still change its dates, limits, plans, notes and status — or duplicate it to make a different offer.
        </div>
      )}

      <form onSubmit={submit} noValidate>
        {formError && <div className="error-box" role="alert">{formError}</div>}
        <div className="coupon-layout">
          <div>
            <div className="card">
              <h2>Code &amp; discount</h2>
              <div className="form-grid-2">
                <Field id="cpn-code" label="Coupon code" error={errors.code} hint={isLocked('code') ? 'Locked — already used.' : 'What gyms type at checkout. Not case-sensitive.'}>
                  <div className="inline-row">
                    <input {...aria('cpn-code', errors.code, true)} className="input code-input" value={form.code} maxLength={32} disabled={isLocked('code')}
                      autoComplete="off" spellCheck={false} placeholder="BARBELL25" onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/\s/g, '') })} />
                    {!isLocked('code') && <button type="button" className="btn ghost sm" onClick={() => set({ code: generateCode() })}>Generate</button>}
                  </div>
                </Field>
                <Field id="cpn-name" label="Internal name" error={errors.internalName} hint="Only founders see this.">
                  <input {...aria('cpn-name', errors.internalName, true)} className="input" value={form.internalName} maxLength={120}
                    placeholder="Diwali 2026 launch" onChange={(e) => set({ internalName: e.target.value })} />
                </Field>
              </div>
              <Field id="cpn-desc" label="Description (shown to gyms)" hint="One line, shown next to the discount at checkout. Optional.">
                <input {...aria('cpn-desc', null, true)} className="input" value={form.description} maxLength={500}
                  placeholder="25% off your first year of Barbell" onChange={(e) => set({ description: e.target.value })} />
              </Field>

              <div className="field">
                <label id="cpn-type-lbl">Discount type</label>
                <Seg name="Discount type" value={form.discountType} disabled={isLocked('discount_type')}
                  onChange={(v) => set({ discountType: v })} options={[['PERCENTAGE', 'Percentage %'], ['FIXED', 'Fixed amount ₹']]} />
              </div>
              <div className="form-grid-2">
                <Field id="cpn-value" label={pct ? 'Discount (%)' : 'Discount (₹)'} error={errors.discountValue}
                  hint={isLocked('discount_value') ? 'Locked — already used.' : pct ? 'e.g. 10, 20, 25, 30' : 'e.g. 500 or 2000'}>
                  <div className={`input-affix ${pct ? 'suffix' : ''}`}>
                    <span className="affix" aria-hidden="true">{pct ? '%' : '₹'}</span>
                    <input {...aria('cpn-value', errors.discountValue, true)} className="input" inputMode="decimal" value={form.discountValue}
                      disabled={isLocked('discount_value')} onChange={(e) => set({ discountValue: e.target.value })} />
                  </div>
                </Field>
                {pct ? (
                  <Field id="cpn-cap" label="Maximum discount (₹)" error={errors.maxDiscountAmount} hint="Optional. e.g. 30% off, but never more than ₹3,000.">
                    <div className="input-affix">
                      <span className="affix" aria-hidden="true">₹</span>
                      <input {...aria('cpn-cap', errors.maxDiscountAmount, true)} className="input" inputMode="decimal" value={form.maxDiscountAmount}
                        disabled={isLocked('max_discount_amount')} placeholder="No cap" onChange={(e) => set({ maxDiscountAmount: e.target.value })} />
                    </div>
                  </Field>
                ) : <div />}
              </div>
              <Field id="cpn-min" label="Minimum purchase (₹)" error={errors.minimumPurchaseAmount} hint="Optional. The coupon only works when the purchase is at least this much.">
                <div className="input-affix" style={{ maxWidth: 260 }}>
                  <span className="affix" aria-hidden="true">₹</span>
                  <input {...aria('cpn-min', errors.minimumPurchaseAmount, true)} className="input" inputMode="decimal" value={form.minimumPurchaseAmount}
                    placeholder="No minimum" onChange={(e) => set({ minimumPurchaseAmount: e.target.value })} />
                </div>
              </Field>
            </div>

            <div className="card">
              <h2>Who can use it</h2>
              <p className="form-section-hint">Decided by the gym's account, never by anything typed at checkout. An Enterprise-only coupon never works for Independent clients.</p>
              <div className="choice-grid" role="radiogroup" aria-label="Customer type" aria-invalid={errors.customerType ? 'true' : undefined}>
                {o.customerTypes.map((ct) => (
                  <label key={ct.value} className="choice-card">
                    <input type="radio" name="customerType" value={ct.value} checked={form.customerType === ct.value}
                      disabled={isLocked('customer_type')} onChange={() => set({ customerType: ct.value })} />
                    <span className="t">{ct.label}</span>
                    <span className="d">{{
                      ENTERPRISE: 'Gyms buying a Barbell package for their business.',
                      INDEPENDENT: 'People using Barbell on their own, without a gym.',
                      BOTH: 'Anyone with a Barbell checkout.',
                    }[ct.value]}</span>
                  </label>
                ))}
              </div>
              {errors.customerType && <div className="field-error" role="alert">{errors.customerType}</div>}
              {indieSelected && (
                <div className="notice">
                  Heads up: coupons don't apply to the Independent clients' Barbell plan checkout yet, so Independent clients can't redeem them today. {form.customerType === 'BOTH' ? 'Enterprise gyms can use this one now.' : 'This coupon will only become usable once that checkout accepts coupons.'}
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <Toggle id="cpn-first" checked={form.firstTimeOnly} onChange={(v) => set({ firstTimeOnly: v })}
                  title="First-time customers only" description="Only gyms that have never paid for Barbell before — checked against their real payment history." />
              </div>
            </div>

            <div className="card">
              <h2>What it applies to</h2>
              <div className="field">
                <label>Purchase types</label>
                <Seg name="Purchase types" value={form.kindsMode} onChange={(v) => set({ kindsMode: v })} options={[['ALL', 'All purchases'], ['SELECTED', 'Selected']]} />
                {form.kindsMode === 'SELECTED' && <Pills legend="Purchase types" options={o.kinds} selected={form.applicableKinds} error={errors.applicableKinds} onChange={(v) => set({ applicableKinds: v })} />}
              </div>
              <div className="field">
                <label>Capacity tiers</label>
                <Seg name="Capacity tiers" value={form.tiersMode} onChange={(v) => set({ tiersMode: v })} options={[['ALL', 'All tiers'], ['SELECTED', 'Selected']]} />
                {form.tiersMode === 'SELECTED' && <Pills legend="Capacity tiers" options={o.tiers} selected={form.applicableTiers} error={errors.applicableTiers} onChange={(v) => set({ applicableTiers: v })} />}
                <div className="field-hint">A custom capacity belongs to the tier it is priced from (e.g. 80 clients is the 75 Clients tier). Add-ons follow the gym's current tier.</div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Billing durations</label>
                <Seg name="Billing durations" value={form.durationsMode} onChange={(v) => set({ durationsMode: v })} options={[['ALL', 'All durations'], ['SELECTED', 'Selected']]} />
                {form.durationsMode === 'SELECTED' && <Pills legend="Billing durations" options={o.durations} selected={form.applicableDurations} error={errors.applicableDurations} onChange={(v) => set({ applicableDurations: v })} />}
              </div>
            </div>

            <div className="card">
              <h2>When it works</h2>
              <p className="form-section-hint">The coupon switches itself on at the start and off at the expiry — no action needed. The expiry minute is included (11:59 PM means until 11:59:59 PM).</p>
              <div className="form-grid-4">
                <Field id="cpn-sd" label="Start date" error={errors.starts}>
                  <input {...aria('cpn-sd', errors.starts)} type="date" className="input" value={form.startsDate} onChange={(e) => set({ startsDate: e.target.value })} />
                </Field>
                <Field id="cpn-st" label="Start time">
                  <input id="cpn-st" type="time" className="input" value={form.startsTime} onChange={(e) => set({ startsTime: e.target.value })} />
                </Field>
                <Field id="cpn-ed" label="Expiry date" error={errors.expires}>
                  <input {...aria('cpn-ed', errors.expires)} type="date" className="input" value={form.expiresDate} min={form.startsDate || undefined} onChange={(e) => set({ expiresDate: e.target.value })} />
                </Field>
                <Field id="cpn-et" label="Expiry time">
                  <input id="cpn-et" type="time" className="input" value={form.expiresTime} onChange={(e) => set({ expiresTime: e.target.value })} />
                </Field>
              </div>
              <div className="form-grid-2">
                <Field id="cpn-tz" label="Timezone">
                  <select id="cpn-tz" className="input" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                    {[...new Set([form.timezone, ...o.timezones])].map((tz) => <option key={tz} value={tz}>{tz === 'Asia/Kolkata' ? 'India (IST) — Asia/Kolkata' : tz}</option>)}
                  </select>
                </Field>
                <div />
              </div>
              <div className="faint">
                Starts <strong>{prettyLocal(form.startsDate, form.startsTime, form.timezone)}</strong> · Expires <strong>{prettyLocal(form.expiresDate, form.expiresTime, form.timezone)}</strong>
              </div>
            </div>

            <div className="card">
              <h2>Limits</h2>
              <div className="field">
                <label>Total uses (all gyms together)</label>
                <Seg name="Total uses" value={form.usageMode} onChange={(v) => set({ usageMode: v })}
                  options={[['UNLIMITED', 'Unlimited'], ['ONCE', 'One-time use'], ['LIMITED', 'Limited to…']]} />
                {form.usageMode === 'LIMITED' && (
                  <div style={{ maxWidth: 200, marginTop: 10 }}>
                    <input {...aria('cpn-max', errors.maxRedemptions)} aria-label="Maximum total uses" className="input" inputMode="numeric" placeholder="e.g. 100"
                      value={form.maxRedemptions} onChange={(e) => set({ maxRedemptions: e.target.value.replace(/\D/g, '') })} />
                  </div>
                )}
                {errors.maxRedemptions && <div className="field-error" id="cpn-max-err" role="alert">{errors.maxRedemptions}</div>}
                <div className="field-hint">Once used up, the coupon shows as Exhausted and stops working. Only paid, verified purchases count.</div>
              </div>
              <div className="field">
                <label>Uses per gym</label>
                <Seg name="Uses per gym" value={form.perCustomerMode} onChange={(v) => set({ perCustomerMode: v })}
                  options={[['LIMITED', 'Limited to…'], ['UNLIMITED', 'Unlimited']]} />
                {form.perCustomerMode === 'LIMITED' && (
                  <div style={{ maxWidth: 200, marginTop: 10 }}>
                    <input {...aria('cpn-per', errors.maxRedemptionsPerCustomer)} aria-label="Maximum uses per gym" className="input" inputMode="numeric"
                      value={form.maxRedemptionsPerCustomer} onChange={(e) => set({ maxRedemptionsPerCustomer: e.target.value.replace(/\D/g, '') })} />
                  </div>
                )}
                {errors.maxRedemptionsPerCustomer && <div className="field-error" id="cpn-per-err" role="alert">{errors.maxRedemptionsPerCustomer}</div>}
              </div>
              <Toggle id="cpn-stack" checked={form.allowStacking} onChange={(v) => set({ allowStacking: v })}
                title="Allow stacking" description="Lets a gym combine this with other stackable coupons (up to 3) on one purchase. Each discount applies to what's left." />
            </div>

            <div className="card">
              <h2>Status &amp; notes</h2>
              <Toggle id="cpn-enabled" checked={form.enabled} onChange={(v) => set({ enabled: v })}
                title="Enabled" description="Turn off to stop the coupon working immediately, without deleting it." />
              <Field id="cpn-notes" label="Founder notes" hint="Private. Never shown to gyms.">
                <textarea id="cpn-notes" className="input" rows={3} maxLength={2000} value={form.founderNotes} onChange={(e) => set({ founderNotes: e.target.value })} />
              </Field>
              <div className="form-actions">
                <button className="btn" type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Create coupon'}</button>
                <button className="btn ghost" type="button" onClick={() => nav(editing ? `/coupons/${id}` : '/coupons')}>Cancel</button>
              </div>
            </div>
          </div>

          <aside className="sticky" aria-label="Preview">
            <div className="preview-card">
              <h2 style={{ marginBottom: 12 }}>Preview</h2>
              <div className="preview-ticket">
                <div className="code">{form.code.trim().toUpperCase() || 'YOURCODE'}</div>
                <div className="off">
                  {Number(form.discountValue) > 0 ? (pct ? `${form.discountValue}% off` : `${moneyExact(Number(form.discountValue))} off`) : '—'}
                </div>
                <div className="sub">
                  {pct && Number(form.maxDiscountAmount) > 0 ? `up to ${moneyExact(Number(form.maxDiscountAmount))} · ` : ''}
                  {{ ENTERPRISE: 'Enterprise gyms', INDEPENDENT: 'Independent clients', BOTH: 'Enterprise & Independent' }[form.customerType] || 'Choose who it is for'}
                </div>
              </div>
              {o.tiers.length > 0 && (
                <>
                  <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
                    <label htmlFor="cpn-prev-tier">Example purchase</label>
                    <select id="cpn-prev-tier" className="input" value={previewTier} onChange={(e) => setPreviewTier(e.target.value)}>
                      {o.tiers.map((t) => <option key={t.value} value={t.value}>{t.label} — {moneyExact(t.price)}</option>)}
                    </select>
                  </div>
                  {preview && !minNotMet ? (
                    <div className="preview-lines" aria-live="polite">
                      <div className="ln"><span>Original price</span><span className="v">{moneyExact(preview.original)}</span></div>
                      <div className="ln save"><span>Coupon discount</span><span className="v">−{moneyExact(preview.discount)}</span></div>
                      <div className="ln total"><span>Gym pays</span><span className="v">{moneyExact(preview.total)}</span></div>
                    </div>
                  ) : (
                    <p className="faint" style={{ marginTop: 12 }}>{minNotMet ? 'Below the minimum purchase — this coupon would not apply here.' : 'Enter a discount to see what a gym would pay.'}</p>
                  )}
                </>
              )}
              <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>Preview only. The final amount is always calculated by the server at checkout, and never goes below ₹1.</p>
            </div>
          </aside>
        </div>
      </form>
    </div>
  );
}
