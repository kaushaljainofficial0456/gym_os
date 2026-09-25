/**
 * REQUEST A DEMO — /demo
 *
 * PUBLIC. The one page a prospective gym owner reaches before anything
 * else exists for them: no account, no tenant, no session.
 *
 * Submitting creates a PENDING row and nothing more. That is the whole
 * point of the screen, and the confirmation state says so plainly rather
 * than implying something is on its way automatically — a founder reads
 * the request and decides. Promising an instant link here would be the
 * one lie the rest of this feature is built to avoid.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Button } from '../../components/UI.jsx';
import Logo from '../../components/Logo.jsx';

const FEATURES = [
  'Member management', 'Trainer management', 'Workout programming',
  'Nutrition plans', 'Community', 'Leaderboards',
  'Progress tracking', 'Attendance', 'Payments & memberships',
];

const field = {
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  color: 'var(--ink)',
};

export default function DemoRequest() {
  const [form, setForm] = useState({
    ownerName: '', gymName: '', email: '', phone: '', city: '', memberCount: '', message: '',
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/demo/request', {
        method: 'POST',
        body: JSON.stringify({
          ownerName: form.ownerName.trim(),
          gymName: form.gymName.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          // Empty optional fields are omitted rather than sent as '' —
          // the API treats an absent value and a blank string the same,
          // but sending nothing is the honest shape.
          ...(form.city.trim() ? { city: form.city.trim() } : {}),
          ...(form.memberCount ? { memberCount: Number(form.memberCount) } : {}),
          ...(form.message.trim() ? { message: form.message.trim() } : {}),
        }),
      });
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not send your request. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen px-5 py-10 flex flex-col items-center" style={{ background: 'var(--bg)' }}>
      <Link to="/login" className="flex items-center gap-2 mb-8">
        <Logo alt="" aria-hidden="true" className="w-7 h-7 rounded-lg object-cover" />
        <span className="font-brand text-[13px] font-bold" style={{ color: 'var(--ink)', letterSpacing: '.02em' }}>Barbell</span>
      </Link>

      <div className="w-full max-w-4xl grid gap-8 md:grid-cols-[1fr_1.1fr] items-start">
        {/* ---- the pitch ---- */}
        <div className="pt-2">
          <h1 className="t-title" style={{ color: 'var(--ink)' }}>Experience Barbell</h1>
          <p className="t-sub mt-3" style={{ color: 'var(--mute)' }}>
            Run your gym smarter. Explore workouts, nutrition, members, trainers,
            community, leaderboards and more — in a live gym, with real data,
            for 30 minutes.
          </p>
          <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-2.5">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--mute)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
                  strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {f}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[11.5px]" style={{ color: 'var(--faint)' }}>
            Every demo is set up by hand by our team, so you get a link that is
            ready to walk through — not a sandbox to configure yourself.
          </p>
        </div>

        {/* ---- the form, or the confirmation that replaces it ---- */}
        <div className="rounded-3xl p-6"
          style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--e-3)' }}>
          {done ? (
            <div className="text-center py-6">
              <div className="w-12 h-12 rounded-full mx-auto mb-4 grid place-items-center"
                style={{ background: 'var(--accent-soft)' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
                  strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <h2 className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>Request received</h2>
              <p className="mt-2.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--mute)' }}>
                Thanks{form.ownerName ? `, ${form.ownerName.split(' ')[0]}` : ''} — someone from
                our team will review this and send your demo link to{' '}
                <span style={{ color: 'var(--ink)' }}>{form.email}</span> shortly.
              </p>
              <p className="mt-4 text-[11.5px]" style={{ color: 'var(--faint)' }}>
                The 30 minutes do not start until you open the link and press Start,
                so there is no rush.
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="grid gap-3.5">
              <h2 className="text-[15px] font-semibold mb-0.5" style={{ color: 'var(--ink)' }}>Request a demo</h2>

              <Labeled label="Your name" required>
                <input className="input" style={field} required minLength={2} maxLength={100}
                  autoComplete="name" value={form.ownerName} onChange={set('ownerName')} placeholder="Kirthi" />
              </Labeled>

              <Labeled label="Gym name" required>
                <input className="input" style={field} required minLength={2} maxLength={120}
                  autoComplete="organization" value={form.gymName} onChange={set('gymName')} placeholder="BeFitter" />
              </Labeled>

              <div className="grid gap-3.5 sm:grid-cols-2">
                <Labeled label="Email" required>
                  <input className="input" style={field} required type="email" maxLength={200}
                    autoComplete="email" value={form.email} onChange={set('email')} placeholder="you@yourgym.com" />
                </Labeled>
                <Labeled label="Phone" required>
                  <input className="input" style={field} required type="tel" minLength={6} maxLength={30}
                    autoComplete="tel" value={form.phone} onChange={set('phone')} placeholder="+91 98450 00000" />
                </Labeled>
              </div>

              <div className="grid gap-3.5 sm:grid-cols-2">
                <Labeled label="City" hint="optional">
                  <input className="input" style={field} maxLength={80}
                    autoComplete="address-level2" value={form.city} onChange={set('city')} placeholder="Bengaluru" />
                </Labeled>
                <Labeled label="Members" hint="optional">
                  <input className="input" style={field} type="number" min="0" max="100000" inputMode="numeric"
                    value={form.memberCount} onChange={set('memberCount')} placeholder="90" />
                </Labeled>
              </div>

              <Labeled label="Anything you want to see" hint="optional">
                <textarea className="input" style={{ ...field, minHeight: 74, resize: 'vertical' }} maxLength={1000}
                  value={form.message} onChange={set('message')}
                  placeholder="We're mainly trying to fix member retention." />
              </Labeled>

              {error && (
                <div className="text-[12px] rounded-xl px-3 py-2.5"
                  style={{ color: 'var(--bad)', background: 'rgba(var(--bad-rgb), .10)' }} role="alert">
                  {error}
                </div>
              )}

              <Button type="submit" loading={busy} className="w-full mt-1">Request a demo</Button>

              <p className="text-[11px] text-center" style={{ color: 'var(--faint)' }}>
                Reviewed by a person, usually the same day. Already have a link?{' '}
                <Link to="/login" style={{ color: 'var(--accent)' }}>Sign in</Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function Labeled({ label, hint, required, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] mb-1.5" style={{ color: 'var(--faint)' }}>
        {label}
        {required && <span style={{ color: 'var(--secondary)' }}> *</span>}
        {hint && <span style={{ color: 'var(--faint)' }}> · {hint}</span>}
      </span>
      {children}
    </label>
  );
}
