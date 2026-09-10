// ============================================================
// ENTERPRISE ONBOARDING — the gym-owner wizard: onboarding questions ->
// package selection -> billing quote -> payment -> activation. Shown
// once, right after /setup-org (see SetupOrg.jsx's redirect), and
// again any time the owner's SK OS package isn't ACTIVE yet (a
// PAYMENT_PENDING gym that abandoned checkout can resume here without
// redoing the wizard -- see the resume logic below). Once the gym is
// ACTIVE, this screen is never shown again; the owner lives on
// EnterpriseDashboard.jsx instead.
// ============================================================
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, PageHeader, Spinner, ErrorState, CheckIcon, PageSkeleton } from '../../components/UI.jsx';
import PaymentCheckout from '../../components/PaymentCheckout.jsx';

const GYM_TYPES = [
  ['commercial', 'Commercial gym'], ['studio', 'Studio'], ['crossfit', 'CrossFit box'],
  ['personal_training', 'Personal training'], ['sports_academy', 'Sports academy'], ['other', 'Other'],
];
const CLIENT_RANGES = ['0-25', '26-50', '51-75', '76-100', '101-200', '201-500', '500+'];
const ACCESS_OPTIONS = [
  ['fingerprint', 'Fingerprint'], ['face', 'Face recognition'], ['rfid', 'RFID card'], ['qr', 'QR code'], ['manual', 'Manual register'], ['none', 'None yet'],
];
const BILLING_CYCLES = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['half_yearly', 'Half-yearly'], ['yearly', 'Yearly'], ['mixed', 'Mixed']];

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export default function EnterpriseOnboarding() {
  const nav = useNavigate();
  const status = useFetch(() => api('/enterprise/status'));
  const [step, setStep] = useState('wizard'); // wizard -> package -> checkout -> done
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

  // Resume mid-flow: an already-completed onboarding + an existing
  // PENDING_PAYMENT order means the owner abandoned checkout earlier --
  // land them straight on the package step instead of re-asking the wizard.
  useEffect(() => {
    if (status.data?.onboardingCompleted && step === 'wizard') setStep('package');
    if (status.data?.billingStatus === 'ACTIVE') nav('/app/trainer/enterprise', { replace: true });
  }, [status.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== 'package' || !capacity) return;
    let cancelled = false;
    setPricingBusy(true);
    api('/enterprise/packages/calculate', { method: 'POST', body: JSON.stringify({ capacity: Number(capacity) }) })
      .then((r) => { if (!cancelled) setPriced(r); })
      .catch((e) => { if (!cancelled) setPriced({ error: e.message }); })
      .finally(() => { if (!cancelled) setPricingBusy(false); });
    return () => { cancelled = true; };
  }, [capacity, step]);

  const submitWizard = async (e) => {
    e.preventDefault();
    setSaving(true); setErr('');
    try {
      // These three fields are optional numbers on the server (Zod
      // z.number().optional()) -- an empty string from an untouched
      // <input type="number"> fails that (a string, even "", is never
      // coerced to a number by Zod), so they must be OMITTED entirely
      // when blank, not sent as ''. JSON.stringify drops `undefined`
      // keys, which is exactly what .optional() expects.
      const payload = {
        ...form, complete: true,
        activeClientsEstimate: form.activeClientsEstimate === '' ? undefined : Number(form.activeClientsEstimate),
        avgMembershipPrice: form.avgMembershipPrice === '' ? undefined : Number(form.avgMembershipPrice),
        expectedSkOsUsers: form.expectedSkOsUsers === '' ? undefined : Number(form.expectedSkOsUsers),
      };
      await api('/enterprise/onboarding', { method: 'POST', body: JSON.stringify(payload) });
      setStep('package');
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
      setStep('checkout');
    } catch (ex) { setErr(ex.message); }
    finally { setSaving(false); }
  };

  const onPaid = async (paymentId, signature) => {
    setSaving(true); setErr('');
    try {
      await api('/enterprise/payment/verify', { method: 'POST', body: JSON.stringify({ orderId: order.id, providerPaymentId: paymentId, signature }) });
      setStep('done');
      // Signal TrainerLayout to start the guided app tour on next render.
      // Consumed once by TrainerLayout and cleared immediately.
      localStorage.setItem('sk-os-start-tour-next', '1');
      setTimeout(() => nav('/app/trainer/enterprise', { replace: true }), 1400);
    } catch (ex) { setErr(ex.message); }
    finally { setSaving(false); }
  };

  if (status.loading) return <PageSkeleton variant="form" label="Loading onboarding" />;
  if (status.error) return <ErrorState error={status.error} onRetry={status.reload} />;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <PageHeader title="Set up your gym on SK OS" sub="A few questions, then pick a plan — you'll only see this once." />

      <div className="flex gap-2">
        {['wizard', 'package', 'checkout'].map((s, i) => (
          <div key={s} className="flex-1 h-1.5 rounded-full" style={{ background: (['wizard', 'package', 'checkout'].indexOf(step) >= i) ? 'var(--accent-grad)' : 'var(--line)' }} />
        ))}
      </div>

      {step === 'wizard' && (
        <Card className="p-6">
          <form onSubmit={submitWizard} className="space-y-4">
            <Field label="What kind of gym is this?">
              <select className="input" value={form.gymType} onChange={(e) => setForm((f) => ({ ...f, gymType: e.target.value }))}>
                {GYM_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Roughly how many clients?">
                <select className="input" value={form.clientCountRange} onChange={(e) => setForm((f) => ({ ...f, clientCountRange: e.target.value }))}>
                  {CLIENT_RANGES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <Field label="How many trainers?">
                <input type="number" min={0} className="input" value={form.trainerCount}
                  onChange={(e) => setForm((f) => ({ ...f, trainerCount: Number(e.target.value) }))} />
              </Field>
            </div>
            <Field label="How many branches / locations?">
              <input type="number" min={1} className="input" value={form.branchCount}
                onChange={(e) => setForm((f) => ({ ...f, branchCount: Number(e.target.value) }))} />
            </Field>
            <Field label="How do members currently check in?">
              <div className="flex flex-wrap gap-2">
                {ACCESS_OPTIONS.map(([k, l]) => (
                  <button type="button" key={k}
                    className={form.access[k] ? 'chip-active' : 'chip'}
                    onClick={() => setForm((f) => ({ ...f, access: { ...f.access, [k]: !f.access[k] } }))}>
                    {l}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Billing cycle you usually offer members">
              <select className="input" value={form.billingCycle} onChange={(e) => setForm((f) => ({ ...f, billingCycle: e.target.value }))}>
                {BILLING_CYCLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="What do you offer?">
              <div className="flex flex-wrap gap-2">
                {[['personalTraining', 'Personal training'], ['groupClasses', 'Group classes'], ['membershipPlans', 'Membership plans'], ['nutritionPlans', 'Nutrition plans'], ['workoutPlans', 'Workout plans']].map(([k, l]) => (
                  <button type="button" key={k}
                    className={form.offers[k] ? 'chip-active' : 'chip'}
                    onClick={() => setForm((f) => ({ ...f, offers: { ...f.offers, [k]: !f.offers[k] } }))}>
                    {l}
                  </button>
                ))}
              </div>
            </Field>
            {err && <div role="alert" className="field-error ">{err}</div>}
            <button className="btn-primary btn-lg btn-block" disabled={saving}>{saving ? 'Saving…' : 'Continue to plans'}</button>
          </form>
        </Card>
      )}

      {step === 'package' && (
        <Card className="p-6 space-y-5">
          {packages.loading ? <Spinner /> : (
            <>
              <div className="grid sm:grid-cols-3 gap-3">
                {(packages.data?.packages || []).map((p) => (
                  <button key={p.id} type="button" onClick={() => setCapacity(p.client_capacity)}
                    className="card p-4 text-left transition-all"
                    style={{ borderColor: Number(capacity) === p.client_capacity ? 'var(--accent)' : 'var(--line)', boxShadow: Number(capacity) === p.client_capacity ? 'var(--accent-grad-shadow)' : undefined }}>
                    <div className="font-grotesk font-bold text-lg">{p.client_capacity} clients</div>
                    <div className="text-2xl font-display font-bold mt-1">₹{p.price.toLocaleString('en-IN')}<span className="text-xs font-normal" style={{ color: 'var(--mute)' }}>/{p.duration_days}d</span></div>
                  </button>
                ))}
              </div>
              <Field label="Or enter a custom client capacity">
                <input type="number" min={1} className="input" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
              </Field>
              <div className="rounded-xl border p-4" style={{ borderColor: 'var(--line)' }}>
                {pricingBusy ? <Spinner label="Calculating…" /> : priced?.error ? (
                  <div className="text-xs text-bad">{priced.error}</div>
                ) : priced ? (
                  <>
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm" style={{ color: 'var(--mute)' }}>Total for {priced.capacity} clients</span>
                      <span className="font-grotesk font-bold text-2xl">₹{priced.price.toLocaleString('en-IN')}</span>
                    </div>
                    {priced.breakdown?.additionalClients > 0 && (
                      <div className="text-[11px] mt-1" style={{ color: 'var(--faint)' }}>
                        ₹{priced.breakdown.base.toLocaleString('en-IN')} base + {priced.breakdown.additionalClients} × ₹{priced.breakdown.rate} additional clients
                      </div>
                    )}
                  </>
                ) : null}
              </div>
              {err && <div role="alert" className="field-error ">{err}</div>}
              <div className="flex gap-2">
                <button className="btn flex-1" onClick={() => setStep('wizard')}>Back</button>
                <button className="btn-primary flex-1" disabled={saving || !priced?.ok} onClick={proceedToCheckout}>
                  {saving ? 'Preparing…' : 'Continue to payment'}
                </button>
              </div>
            </>
          )}
        </Card>
      )}

      {step === 'checkout' && order && (
        <Card className="p-6 space-y-4">
          <div className="text-sm" style={{ color: 'var(--mute)' }}>{quote?.capacity} client capacity, locked for 10 minutes at this price.</div>
          <PaymentCheckout order={order} onComplete={onPaid} onCancel={() => setStep('package')} />
        </Card>
      )}

      {step === 'done' && (
        <Card className="p-8 text-center">
          <div className="text-3xl mb-2"><CheckIcon /></div>
          <div className="font-grotesk font-bold">Your gym is active!</div>
          <div className="text-xs mt-1" style={{ color: 'var(--mute)' }}>Taking you to your dashboard…</div>
        </Card>
      )}
    </div>
  );
}
