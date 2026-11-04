/**
 * GETTING PAID -- the gym's Razorpay Route account.
 *
 * Members pay the gym, not Barbell. Their payments go through Barbell's
 * Razorpay and Razorpay moves the gym's share to this account, which
 * settles to the gym's bank. Until it is active, members pay at the desk
 * and the owner records it (with a receipt) on the Business page.
 *
 * Bank and PAN details go straight to Razorpay. Barbell keeps none of them,
 * which is why the form starts empty every time.
 */
import { useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, Modal } from '../UI.jsx';

const STATUS = {
  NOT_CONNECTED: { title: 'Not set up yet', tone: 'var(--mute)', body: 'Members pay at the front desk until you finish this. Record those payments on the Business page; each gets a receipt.' },
  KYC_PENDING: { title: 'Razorpay is checking your details', tone: 'var(--warn)', body: 'This usually takes one or two working days. Members pay at the desk until then.' },
  LIMITED: { title: 'Razorpay needs something from you', tone: 'var(--bad)', body: 'Fix what is listed below and send your details again. Members pay at the desk until then.' },
  ACTIVE: { title: 'Members can pay you online', tone: 'var(--good)', body: 'Payments settle to your bank account through Razorpay.' },
};

const BUSINESS_TYPES = [
  ['proprietorship', 'Sole proprietorship'], ['partnership', 'Partnership'], ['llp', 'LLP'],
  ['private_limited', 'Private limited company'], ['public_limited', 'Public limited company'], ['individual', 'Individual'],
  ['trust', 'Trust'], ['society', 'Society'], ['ngo', 'NGO'], ['not_yet_registered', 'Not yet registered'], ['other', 'Other'],
];

// What Razorpay names a field, in words an owner recognises.
const FIELD = {
  'settlements.account_number': 'Bank account number', 'settlements.ifsc_code': 'IFSC', 'settlements.beneficiary_name': 'Account holder name',
  'legal_info.pan': 'PAN', 'legal_info.gst': 'GSTIN', 'legal_business_name': 'Registered business name',
  'profile.addresses.registered': 'Registered address', 'contact_name': 'Contact name',
};

const blank = () => ({
  legalBusinessName: '', displayName: '', businessType: 'proprietorship', pan: '', gst: '',
  contactName: '', email: '', phone: '', street1: '', street2: '', city: '', state: '', postalCode: '',
  accountNumber: '', accountNumber2: '', ifsc: '', beneficiaryName: '', acceptTerms: false,
});

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-[11.5px] font-semibold" style={{ color: 'var(--mute)' }}>{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="block text-[10.5px] mt-1" style={{ color: 'var(--faint)' }}>{hint}</span>}
    </label>
  );
}

export default function PayoutSetup() {
  const account = useFetch(() => api('/enterprise/payment-account'));
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [checking, setChecking] = useState(false);
  const a = account.data?.account;
  const st = STATUS[a?.status] || STATUS.NOT_CONNECTED;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async () => {
    setErr('');
    if (f.accountNumber !== f.accountNumber2) { setErr('The two bank account numbers do not match.'); return; }
    setBusy(true);
    try {
      const { accountNumber2: _confirm, ...body } = f;
      await api('/enterprise/payment-account', { method: 'POST', body: JSON.stringify({ ...body, gst: f.gst.trim() || undefined, street2: f.street2.trim() || undefined }) });
      setOpen(false); setF(blank());
      account.reload({ silent: true });
    } catch (e) {
      setErr(e.message || 'Could not send your details. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setChecking(true); setErr('');
    try { await api('/enterprise/payment-account/refresh', { method: 'POST' }); account.reload({ silent: true }); }
    catch (e) { setErr(e.message || 'Could not check with Razorpay just now.'); }
    finally { setChecking(false); }
  };

  return (
    <Card className="p-5">
      <div className="kicker">Getting paid</div>
      {account.loading ? (
        <div className="t-sub">Loading…</div>
      ) : account.error ? (
        <div className="field-error" role="alert">{account.error.message}</div>
      ) : (
        <>
          <div className="font-grotesk font-bold" style={{ color: st.tone }}>{st.title}</div>
          <p className="text-sm mt-1" style={{ color: 'var(--mute)' }}>{st.body}</p>
          {a?.businessName && <p className="text-xs mt-2" style={{ color: 'var(--faint)' }}>Paid to {a.legalName || a.businessName}</p>}
          {a?.status === 'LIMITED' && a.requirements?.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm" style={{ color: 'var(--ink)' }}>
              {a.requirements.map((r) => <li key={r.field}>• {FIELD[r.field] || r.field}</li>)}
            </ul>
          )}
          <p className="text-xs mt-3" style={{ color: 'var(--faint)' }}>
            Barbell keeps {a?.feePercent ?? 2.36}% of each online payment to cover Razorpay&rsquo;s fee. The rest is yours.
            {a?.provider === 'mock' && ' Practice mode: an account is switched on as soon as it is sent.'}
          </p>
          {err && <div className="field-error mt-2" role="alert">{err}</div>}
          <div className="flex flex-wrap gap-2 mt-4">
            <button type="button" className="btn-primary" onClick={() => { setErr(''); setOpen(true); }}>
              {a?.connected ? 'Update details' : 'Set up payouts'}
            </button>
            {a?.connected && a?.status !== 'ACTIVE' && (
              <button type="button" className="btn" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check status'}</button>
            )}
          </div>
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Set up payouts" sub="These go straight to Razorpay. Barbell does not keep your bank or PAN details.">
        <div className="space-y-4">
          <div className="space-y-3">
            <div className="kicker">Business</div>
            <Field label="Registered business name" hint="As on your PAN or registration">
              <input className="input" value={f.legalBusinessName} onChange={set('legalBusinessName')} maxLength={200} />
            </Field>
            <Field label="Name members see (optional)">
              <input className="input" value={f.displayName} onChange={set('displayName')} maxLength={120} placeholder="Your gym's name" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Business type">
                <select className="input" value={f.businessType} onChange={set('businessType')}>
                  {BUSINESS_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="PAN">
                <input className="input uppercase" value={f.pan} onChange={set('pan')} maxLength={10} placeholder="ABCDE1234F" autoComplete="off" />
              </Field>
            </div>
            <Field label="GSTIN (optional)">
              <input className="input uppercase" value={f.gst} onChange={set('gst')} maxLength={15} autoComplete="off" />
            </Field>
          </div>

          <div className="space-y-3">
            <div className="kicker">Contact</div>
            <Field label="Your name"><input className="input" value={f.contactName} onChange={set('contactName')} maxLength={120} autoComplete="name" /></Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Email"><input className="input" type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
              <Field label="Mobile"><input className="input" inputMode="numeric" value={f.phone} onChange={set('phone')} maxLength={10} placeholder="10 digits" autoComplete="tel-national" /></Field>
            </div>
          </div>

          <div className="space-y-3">
            <div className="kicker">Registered address</div>
            <Field label="Address line 1"><input className="input" value={f.street1} onChange={set('street1')} maxLength={100} /></Field>
            <Field label="Address line 2 (optional)"><input className="input" value={f.street2} onChange={set('street2')} maxLength={100} /></Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="City"><input className="input" value={f.city} onChange={set('city')} maxLength={100} /></Field>
              <Field label="State"><input className="input" value={f.state} onChange={set('state')} maxLength={32} placeholder="Karnataka" /></Field>
              <Field label="PIN code"><input className="input" inputMode="numeric" value={f.postalCode} onChange={set('postalCode')} maxLength={6} /></Field>
            </div>
          </div>

          <div className="space-y-3">
            <div className="kicker">Bank account to be paid into</div>
            <Field label="Account holder name"><input className="input" value={f.beneficiaryName} onChange={set('beneficiaryName')} maxLength={120} /></Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Account number"><input className="input" inputMode="numeric" value={f.accountNumber} onChange={set('accountNumber')} maxLength={18} autoComplete="off" /></Field>
              <Field label="Account number again"><input className="input" inputMode="numeric" value={f.accountNumber2} onChange={set('accountNumber2')} maxLength={18} autoComplete="off" /></Field>
            </div>
            <Field label="IFSC"><input className="input uppercase" value={f.ifsc} onChange={set('ifsc')} maxLength={11} placeholder="HDFC0001234" autoComplete="off" /></Field>
          </div>

          <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--ink)' }}>
            <input type="checkbox" className="mt-1" checked={f.acceptTerms} onChange={set('acceptTerms')} />
            <span>I accept <a href="https://razorpay.com/s/terms/" target="_blank" rel="noopener noreferrer" className="underline">Razorpay&rsquo;s terms</a> for receiving payments.</span>
          </label>
          {err && <div className="field-error" role="alert">{err}</div>}
          <button type="button" className="btn-primary w-full" disabled={busy || !f.acceptTerms} onClick={submit}>
            {busy ? 'Sending to Razorpay…' : 'Send to Razorpay'}
          </button>
        </div>
      </Modal>
    </Card>
  );
}
