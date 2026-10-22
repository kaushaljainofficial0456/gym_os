// ============================================================
// ENTERPRISE ONBOARDING — the gym-owner setup: a few questions about the
// gym -> plan -> payment -> activation. Shown once, right after /setup-org
// (see SetupOrg.jsx's redirect), and again any time the owner's Barbell
// package isn't ACTIVE yet (a PAYMENT_PENDING gym that abandoned checkout
// resumes on the plan step without redoing the questions -- see the resume
// logic below). Once the gym is ACTIVE this is never shown again; the owner
// lives on EnterpriseDashboard.jsx instead.
//
// It is the last screen before an owner's dashboard, so it shares the
// sign-in screens' stage and is drawn over the workspace (a portal to
// <body>) rather than inside it: one question per screen, big targets,
// the gym's answers building up behind the step bar.
// ============================================================
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Check, CircleOff, CreditCard, Dumbbell, Fingerprint, Flame, Layers3, Minus, NotebookPen,
  Plus, QrCode, ScanFace, Sparkles, Trophy, UserRound,
} from 'lucide-react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState, Spinner } from '../../components/UI.jsx';
import PaymentCheckout from '../../components/PaymentCheckout.jsx';
import AuthShell from '../../components/auth/AuthShell.jsx';
import '../../components/auth/auth-flow.css';
import { AuthTitle, Cta, ErrorNote, Steps } from '../../components/auth/authKit.jsx';

const HEADLINE = [{ text: 'Your gym,' }, { text: 'live in minutes.', accent: true }];

const GYM_TYPES = [
  ['commercial', 'Commercial gym', Dumbbell], ['studio', 'Studio', Sparkles], ['crossfit', 'CrossFit box', Flame],
  ['personal_training', 'Personal training', UserRound], ['sports_academy', 'Sports academy', Trophy], ['other', 'Other', Layers3],
];
const CLIENT_RANGES = ['0-25', '26-50', '51-75', '76-100', '101-200', '201-500', '500+'];
const ACCESS_OPTIONS = [
  ['fingerprint', 'Fingerprint', Fingerprint], ['face', 'Face recognition', ScanFace], ['rfid', 'RFID card', CreditCard],
  ['qr', 'QR code', QrCode], ['manual', 'Manual register', NotebookPen], ['none', 'None yet', CircleOff],
];
const OFFERS = [['personalTraining', 'Personal training'], ['groupClasses', 'Group classes'], ['membershipPlans', 'Membership plans'], ['nutritionPlans', 'Nutrition plans'], ['workoutPlans', 'Workout plans']];
const BILLING_CYCLES = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['half_yearly', 'Half-yearly'], ['yearly', 'Yearly'], ['mixed', 'Mixed']];

// The questions, then the plan. Payment and "done" are not counted as steps.
const QUESTIONS = 4;
const PLAN = 4;
const STEP_COUNT = 5;

function Tile({ label, icon: I, on, onClick }) {
  return (
    <button type="button" className="auth-tile" aria-pressed={on} onClick={onClick}>
      <I size={22} strokeWidth={1.5} aria-hidden="true" />
      {label}
      <span className="auth-tile__check" aria-hidden="true"><Check size={12} strokeWidth={2.5} /></span>
    </button>
  );
}

function Chip({ label, on, onClick }) {
  return <button type="button" className="auth-chipx" aria-pressed={on} onClick={onClick}>{label}</button>;
}

function Stepper({ label, value, min, onChange }) {
  return (
    <div className="auth-stepper">
      <span className="auth-label" id={`st-${label}`}>{label}</span>
      <div className="auth-stepper__ctl" role="group" aria-labelledby={`st-${label}`}>
        <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
          <Minus size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <output aria-live="polite">{value}</output>
        <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => onChange(value + 1)}>
          <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

export default function EnterpriseOnboarding() {
  const nav = useNavigate();
  const status = useFetch(() => api('/enterprise/status'));
  const [step, setStep] = useState(0);              // 0..3 questions, 4 plan, 'checkout', 'done'
  const [dir, setDir] = useState('fwd');
  const [form, setForm] = useState({
    gymType: 'commercial', clientCountRange: '26-50', trainerCount: 2, branchCount: 1,
    access: {}, wantsAccessIntegration: false, billingCycle: 'yearly',
    offers: { personalTraining: false, groupClasses: false, membershipPlans: true, nutritionPlans: false, workoutPlans: false },
    usesOtherSoftware: false, otherSoftwareName: '', improvementNotes: '',
    activeClientsEstimate: '', avgMembershipPrice: '', expectedSkOsUsers: '', preferredContactMethod: 'email',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const packages = useFetch(() => api('/enterprise/packages'));
  const [capacity, setCapacity] = useState(75);
  const [priced, setPriced] = useState(null);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [quote, setQuote] = useState(null);
  const [order, setOrder] = useState(null);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const go = (s) => { setErr(''); setDir(typeof s === 'number' && typeof step === 'number' && s < step ? 'back' : 'fwd'); setStep(s); };

  // Resume mid-flow: an already-completed onboarding + an existing
  // PENDING_PAYMENT order means the owner abandoned checkout earlier --
  // land them straight on the plan step instead of re-asking.
  useEffect(() => {
    if (status.data?.onboardingCompleted && step === 0) setStep(PLAN);
    if (status.data?.billingStatus === 'ACTIVE') nav('/app/trainer/enterprise', { replace: true });
  }, [status.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== PLAN || !capacity) return undefined;
    let cancelled = false;
    setPricingBusy(true);
    api('/enterprise/packages/calculate', { method: 'POST', body: JSON.stringify({ capacity: Number(capacity) }) })
      .then((r) => { if (!cancelled) setPriced(r); })
      .catch((e) => { if (!cancelled) setPriced({ error: e.message }); })
      .finally(() => { if (!cancelled) setPricingBusy(false); });
    return () => { cancelled = true; };
  }, [capacity, step]);

  const submitWizard = async () => {
    setSaving(true); setErr('');
    try {
      // These three fields are optional numbers on the server (Zod
      // z.number().optional()) -- an empty string fails that, so they must
      // be OMITTED when blank, not sent as ''. JSON.stringify drops
      // `undefined` keys, which is exactly what .optional() expects.
      const payload = {
        ...form, complete: true,
        activeClientsEstimate: form.activeClientsEstimate === '' ? undefined : Number(form.activeClientsEstimate),
        avgMembershipPrice: form.avgMembershipPrice === '' ? undefined : Number(form.avgMembershipPrice),
        expectedSkOsUsers: form.expectedSkOsUsers === '' ? undefined : Number(form.expectedSkOsUsers),
      };
      await api('/enterprise/onboarding', { method: 'POST', body: JSON.stringify(payload) });
      go(PLAN);
    } catch (ex) { setErr(ex.message); }
    finally { setSaving(false); }
  };

  const proceedToCheckout = async () => {
    setErr(''); setSaving(true);
    try {
      const q = await api('/enterprise/billing/quote', { method: 'POST', body: JSON.stringify({ kind: 'ORG_PACKAGE', capacity: Number(capacity) }) });
      setQuote(q.quote);
      const o = await api('/enterprise/payment/order', { method: 'POST', body: JSON.stringify({ quoteId: q.quote.id }) });
      setOrder(o.order);
      go('checkout');
    } catch (ex) { setErr(ex.message); }
    finally { setSaving(false); }
  };

  const onPaid = async (paymentId, signature) => {
    setSaving(true); setErr('');
    try {
      await api('/enterprise/payment/verify', { method: 'POST', body: JSON.stringify({ orderId: order.id, providerPaymentId: paymentId, signature }) });
      go('done');
      // Signal TrainerLayout to start the guided app tour on next render.
      // Consumed once by TrainerLayout and cleared immediately.
      localStorage.setItem('sk-os-start-tour-next', '1');
      setTimeout(() => nav('/app/trainer/enterprise', { replace: true }), 1600);
    } catch (ex) { setErr(ex.message); }
    finally { setSaving(false); }
  };

  const back = typeof step === 'number' && step > 0 && !(step === PLAN && status.data?.onboardingCompleted)
    ? () => go(step - 1)
    : step === 'checkout' ? () => go(PLAN) : undefined;

  let body;
  if (status.loading) {
    body = <div className="py-20 grid place-items-center"><Spinner /></div>;
  } else if (status.error) {
    body = <ErrorState error={status.error} onRetry={status.reload} />;
  } else if (step === 'done') {
    body = (
      <div className="auth-view text-center">
        <svg className="auth-done" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="29" pathLength="1" />
          <path d="M20 33.5 28.5 42 45 24" pathLength="1" />
        </svg>
        <h1 className="auth-title">Your gym is live.</h1>
        <p className="auth-sub">Taking you to your dashboard…</p>
      </div>
    );
  } else if (step === 'checkout' && order) {
    body = (
      <>
        <AuthTitle eyebrow="Payment" title="Confirm your plan" sub={`${quote?.capacity} clients, held at this price for 10 minutes.`} onBack={back} />
        <PaymentCheckout order={order} onComplete={onPaid} onCancel={() => go(PLAN)} />
        {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}
      </>
    );
  } else {
    const s = step;
    body = (
      <>
        <Steps count={STEP_COUNT} at={s} />
        {s === 0 && (
          <>
            <AuthTitle eyebrow={`Step 1 of ${STEP_COUNT}`} title="What kind of gym is it?" />
            <div className="auth-tiles">
              {GYM_TYPES.map(([v, l, I]) => <Tile key={v} label={l} icon={I} on={form.gymType === v} onClick={() => set({ gymType: v })} />)}
            </div>
            <Cta onClick={() => go(1)}>Continue</Cta>
          </>
        )}
        {s === 1 && (
          <>
            <AuthTitle eyebrow={`Step 2 of ${STEP_COUNT}`} title="How big is it?" onBack={back} />
            <div className="auth-label mb-3">Clients</div>
            <div className="auth-chips">
              {CLIENT_RANGES.map((r) => <Chip key={r} label={r} on={form.clientCountRange === r} onClick={() => set({ clientCountRange: r })} />)}
            </div>
            <div className="mt-5 border-t" style={{ borderColor: 'var(--line)' }}>
              <Stepper label="Trainers" value={form.trainerCount} min={0} onChange={(v) => set({ trainerCount: v })} />
              <Stepper label="Branches" value={form.branchCount} min={1} onChange={(v) => set({ branchCount: v })} />
            </div>
            <Cta onClick={() => go(2)}>Continue</Cta>
          </>
        )}
        {s === 2 && (
          <>
            <AuthTitle eyebrow={`Step 3 of ${STEP_COUNT}`} title="How do members check in today?" sub="Pick all that apply." onBack={back} />
            <div className="auth-tiles">
              {ACCESS_OPTIONS.map(([k, l, I]) => (
                <Tile key={k} label={l} icon={I} on={!!form.access[k]}
                  onClick={() => setForm((f) => ({ ...f, access: { ...f.access, [k]: !f.access[k] } }))} />
              ))}
            </div>
            <Cta onClick={() => go(3)}>Continue</Cta>
          </>
        )}
        {s === 3 && (
          <>
            <AuthTitle eyebrow={`Step 4 of ${STEP_COUNT}`} title="What do you offer?" onBack={back} />
            <div className="auth-chips">
              {OFFERS.map(([k, l]) => (
                <Chip key={k} label={l} on={!!form.offers[k]}
                  onClick={() => setForm((f) => ({ ...f, offers: { ...f.offers, [k]: !f.offers[k] } }))} />
              ))}
            </div>
            <div className="auth-label mt-7 mb-3">Members usually pay</div>
            <div className="auth-chips">
              {BILLING_CYCLES.map(([v, l]) => <Chip key={v} label={l} on={form.billingCycle === v} onClick={() => set({ billingCycle: v })} />)}
            </div>
            <div className="mt-6"><ErrorNote>{err}</ErrorNote></div>
            <Cta busy={saving} onClick={submitWizard}>Continue to plans</Cta>
          </>
        )}
        {s === PLAN && (
          <>
            <AuthTitle eyebrow={`Step 5 of ${STEP_COUNT}`} title="Choose your plan" sub="Priced by how many clients you coach." onBack={back} />
            {packages.loading ? <div className="py-10 grid place-items-center"><Spinner /></div> : packages.error ? (
              // Without this the plan list simply rendered empty, leaving an
              // owner mid-setup with nothing to choose and no reason why.
              <ErrorState error={packages.error} onRetry={packages.reload} />
            ) : (
              <>
                <div className="auth-plans">
                  {(packages.data?.packages || []).map((p) => (
                    <button key={p.id} type="button" className="auth-plan" aria-pressed={Number(capacity) === p.client_capacity}
                      onClick={() => setCapacity(p.client_capacity)}>
                      <span className="auth-plan__cap">{p.client_capacity} clients</span>
                      <span className="auth-plan__price">{inr(p.price)}<small>/{p.duration_days}d</small></span>
                    </button>
                  ))}
                </div>
                <label className="auth-custom">
                  <span className="auth-label">Or a custom capacity</span>
                  <input type="number" min={1} inputMode="numeric" className="input auth-input" value={capacity}
                    onChange={(e) => setCapacity(e.target.value)} />
                </label>
                <div className="auth-total" aria-live="polite">
                  {pricingBusy ? <Spinner label="Calculating…" /> : priced?.error ? (
                    <span className="text-[13px]" style={{ color: 'rgb(var(--bad-rgb))' }}>{priced.error}</span>
                  ) : priced ? (
                    <>
                      <span>
                        <span className="auth-label block">Total</span>
                        {priced.breakdown?.additionalClients > 0 && (
                          <span className="text-[12px]" style={{ color: 'var(--mute)' }}>
                            {inr(priced.breakdown.base)} + {priced.breakdown.additionalClients} × {inr(priced.breakdown.rate)}
                          </span>
                        )}
                      </span>
                      <strong>{inr(priced.price)}</strong>
                    </>
                  ) : null}
                </div>
                <ErrorNote>{err}</ErrorNote>
                <Cta busy={saving} disabled={!priced?.ok} onClick={proceedToCheckout}>Continue to payment</Cta>
              </>
            )}
          </>
        )}
      </>
    );
  }

  return createPortal(
    <div className="auth-overlay">
      <AuthShell variant="compact" headline={HEADLINE} showcase="owner">
        <div key={String(step)} className="auth-view" data-dir={dir}>{body}</div>
      </AuthShell>
    </div>,
    document.body,
  );
}
