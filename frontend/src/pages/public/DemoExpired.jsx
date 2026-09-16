/**
 * THE END OF THE DEMO — /demo-expired
 *
 * Reached two ways, and it has to read well from both: the prospect
 * finished deliberately from the banner, or they were mid-click when the
 * 30 minutes ran out and api.js sent them here.
 *
 * This is the one screen in the whole feature whose job is conversion, so
 * it does three things: says what happened without sounding like an
 * error, reminds them what they just saw, and gives them somewhere
 * obvious to go. It uses their own name and their own gym's name when it
 * has them — the session token is still in this tab's sessionStorage
 * (see demoSession.js) and the public /demo/ended/:token endpoint reads
 * the request they filled in.
 *
 * "Start again" deliberately does not exist here. A second demo is a
 * founder's decision (spec 22) — so the button says Request another, and
 * it goes back through the same queue as the first.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, clearStoredUser } from '../../api.js';
import Logo from '../../components/Logo.jsx';
import { recallDemoToken } from '../../demoSession.js';

const SAW = [
  'Member management', 'Trainer management', 'Workouts', 'Nutrition',
  'Community', 'Leaderboards', 'Progress tracking', 'Engagement',
];

const HEADLINE = {
  revoked: 'Your demo was ended',
  completed: 'Thanks for looking around',
  expired: 'Your Barbell demo has ended',
};

const SUBHEAD = {
  revoked: 'An administrator closed this session. Get in touch and we will set up another.',
  completed: 'You went through the whole thing — here is what to do next.',
  expired: 'That was 30 minutes of the real product, running on a real gym.',
};

export default function DemoExpired() {
  const [info, setInfo] = useState(null);
  const [token, setToken] = useState(null);

  useEffect(() => {
    // The demo is over: whatever optimistic user object this browser was
    // holding for first paint is now wrong, and leaving it behind would
    // make the app flash a signed-in shell on the next navigation. The
    // httpOnly cookie is already dead server-side — the session row says
    // so — so there is nothing to revoke, only local state to drop.
    clearStoredUser();

    const t = recallDemoToken();
    if (!t) return;
    setToken(t);
    api(`/demo/ended/${encodeURIComponent(t)}`)
      .then(setInfo)
      .catch(() => { /* an unknown token just means generic copy */ });
    // The token is deliberately NOT cleared here.
    //
    // It was, and that was a bug: clearing it in the effect means the
    // SECOND run of the effect finds nothing. React's StrictMode mounts,
    // unmounts and remounts every component in development, so the
    // surviving instance had no token and rendered the generic
    // "Ready to bring Barbell to your gym?" instead of "Kirthi, ready to
    // bring Barbell to BeFitter?" -- on the one screen whose entire job
    // is conversion. Caught by walking the real flow in a browser; it is
    // invisible from the code and invisible in a production build, which
    // is the worst combination.
    //
    // Keeping it costs nothing worth having: sessionStorage is scoped to
    // this tab and dies with it, the token names a session the server has
    // already ended, and the same value is sitting in this tab's own
    // history. Starting a later demo overwrites it.
  }, []);

  // A CTA is the single most useful thing a founder can learn from a
  // demo, and by definition it happens when there is no session left to
  // authenticate with -- so it goes to the narrow public endpoint that
  // accepts this one event and nothing else.
  const cta = (name) => {
    if (!token) return;
    api(`/demo/access/${encodeURIComponent(token)}/event`, {
      method: 'POST',
      body: JSON.stringify({ type: 'cta_clicked', data: { cta: name } }),
    }).catch(() => {});
  };

  const state = info?.state === 'revoked' ? 'revoked' : info?.state === 'completed' ? 'completed' : 'expired';
  const firstName = (info?.ownerName || '').trim().split(/\s+/)[0] || null;
  const gym = info?.gymName || null;

  return (
    <div className="min-h-screen px-5 py-10 flex flex-col items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="flex items-center gap-2 mb-7">
        <Logo alt="" aria-hidden="true" className="w-7 h-7 rounded-lg object-cover" />
        <span className="font-brand text-[13px] font-bold" style={{ color: 'var(--ink)', letterSpacing: '.02em' }}>Barbell</span>
      </div>

      <div className="w-full max-w-lg rounded-3xl p-7 text-center"
        style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--e-3)' }}>

        <h1 className="text-[22px] font-semibold leading-tight" style={{ color: 'var(--ink)' }}>
          {HEADLINE[state]}
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed" style={{ color: 'var(--mute)' }}>
          {SUBHEAD[state]}
          {gym && state !== 'revoked' && (
            <> You just saw how Barbell would manage and engage members at {gym}.</>
          )}
        </p>

        <div className="mt-6 rounded-2xl p-4 text-left" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
          <div className="text-[10.5px] uppercase tracking-[.16em] mb-2.5" style={{ color: 'var(--faint)' }}>
            What you explored
          </div>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {SAW.map((f) => (
              <li key={f} className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--mute)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
                  strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {f}
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-6 text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
          {firstName && gym
            ? `${firstName}, ready to bring Barbell to ${gym}?`
            : 'Ready to bring Barbell to your gym?'}
        </p>

        <div className="mt-4 grid gap-2.5">
          <Link to="/contact" onClick={() => cta('book_setup_call')} className="btn-primary btn-lg w-full">
            Book a setup call
          </Link>
          <Link to="/setup-org" onClick={() => cta('request_full_trial')} className="btn-secondary w-full">
            Start with your own gym
          </Link>
          <Link to="/demo" onClick={() => cta('request_another_demo')} className="btn-ghost w-full">
            Request another demo
          </Link>
        </div>

        <p className="mt-5 text-[11px]" style={{ color: 'var(--faint)' }}>
          A second demo needs to be set up by our team, same as the first —
          that way it is ready to walk through rather than empty.
        </p>
      </div>
    </div>
  );
}
