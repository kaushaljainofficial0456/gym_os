/**
 * THE PRE-DEMO SCREEN — /demo/:token
 *
 * PUBLIC, and load-bearing for the one rule this whole feature turns on:
 * OPENING THIS PAGE DOES NOT START THE CLOCK. Reading the link, closing
 * the tab, coming back an hour later — none of it costs the prospect a
 * minute. The 30 minutes begin on the button, and on nothing else.
 *
 * So this page only ever GETs. The single POST it can make is the one
 * behind "Start 30-minute demo", and it happens on a click.
 *
 * It also handles every way a link can already be spent — used, expired,
 * revoked, or simply wrong — because "invalid" tells the person holding a
 * link nothing about what to do next.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, setStoredUser } from '../../api.js';
import { Button } from '../../components/UI.jsx';
import Logo from '../../components/Logo.jsx';
import { rememberDemoToken, syncClock } from '../../demoSession.js';

const EXPLORE = [
  'Member management', 'Trainer management', 'Workout management', 'Nutrition',
  'Community', 'Leaderboards', 'Progress tracking', 'Attendance',
  'Gym dashboard', 'Member experience', 'Trainer experience',
];

// A link that cannot be used any more, and why. Each gets its own
// sentence: "this demo is over" and "an administrator ended this demo"
// call for different next steps from the person reading them.
const DEAD = {
  expired: ['This demo has finished', 'Your 30 minutes are up. We can set up another one whenever you are ready.'],
  completed: ['This demo has been completed', 'You finished this session. Ask us for another if you would like a second look.'],
  revoked: ['This demo was ended by an administrator', 'Get in touch and we will sort out a new one.'],
  not_found: ['We could not find that demo link', 'Check the link, or ask whoever sent it for a fresh one — they can issue one in seconds.'],
};

export default function DemoStart() {
  const { token } = useParams();
  const nav = useNavigate();
  const [info, setInfo] = useState(null);
  const [dead, setDead] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api(`/demo/access/${encodeURIComponent(token)}`)
      .then((res) => {
        if (!alive) return;
        syncClock(res.serverTime);
        // 'active' means they already started and came back (a refresh, a
        // second tab, a reopened browser). Not an error at all — the
        // button below just says Continue, and the deadline is whatever
        // the server already recorded.
        if (['expired', 'completed', 'revoked'].includes(res.state)) setDead(res.state);
        setInfo(res);
      })
      .catch((e) => { if (alive) setDead(e.status === 404 ? 'not_found' : 'not_found'); })
      .finally(() => { /* state above is enough to render every branch */ });
    return () => { alive = false; };
  }, [token]);

  const start = async () => {
    setBusy(true); setError('');
    try {
      const res = await api(`/demo/access/${encodeURIComponent(token)}/start`, { method: 'POST' });
      // Kept for the tab's lifetime so the expiry screen can say why it
      // ended and use their own name — see demoSession.js.
      rememberDemoToken(token);
      syncClock(res.session?.serverTime);
      // The response's user object primes first paint; AuthProvider
      // re-validates against /auth/me the moment the app mounts, so a
      // stale or tampered local copy changes nothing.
      setStoredUser(res.user);
      // A full navigation, not a router push: the app shell reads the
      // session on mount, and the cleanest way to enter it with a brand
      // new identity is to enter it fresh.
      window.location.assign('/app/trainer');
    } catch (e) {
      if (e.status === 410) setDead(e.data?.reason || 'expired');
      else setError(e.message || 'Could not start your demo. Please try again.');
      setBusy(false);
    }
  };

  const firstName = (info?.ownerName || '').trim().split(/\s+/)[0] || null;
  const gym = info?.gymName || null;

  return (
    <div className="min-h-screen px-5 py-10 flex flex-col items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="flex items-center gap-2 mb-7">
        <Logo alt="" aria-hidden="true" className="w-7 h-7 rounded-lg object-cover" />
        <span className="font-brand text-[13px] font-bold" style={{ color: 'var(--ink)', letterSpacing: '.02em' }}>Barbell</span>
      </div>

      <div className="w-full max-w-lg rounded-3xl p-7"
        style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--e-3)' }}>

        {!info && !dead && (
          <div className="text-[12.5px] py-10 text-center" style={{ color: 'var(--mute)' }}>Opening your demo…</div>
        )}

        {dead && <Dead state={dead} firstName={firstName} gym={gym} />}

        {info && !dead && (
          <>
            <div className="text-[10.5px] uppercase tracking-[.18em] mb-3" style={{ color: 'var(--faint)' }}>
              Welcome to Barbell
            </div>
            <h1 className="text-[22px] font-semibold leading-tight" style={{ color: 'var(--ink)' }}>
              {gym ? `Your ${gym} demo` : 'Your demo'}
            </h1>
            <p className="mt-3 text-[13px] leading-relaxed" style={{ color: 'var(--mute)' }}>
              {firstName ? `Hello ${firstName}. ` : ''}
              You have <strong style={{ color: 'var(--ink)' }}>30 minutes</strong> to explore the complete
              Barbell gym-management experience — as the owner, as a trainer, and as a member.
            </p>

            <div className="mt-5 rounded-2xl p-4" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
              <div className="text-[10.5px] uppercase tracking-[.16em] mb-2.5" style={{ color: 'var(--faint)' }}>
                Explore
              </div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {EXPLORE.map((f) => (
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

            <p className="mt-4 text-[11.5px] leading-relaxed" style={{ color: 'var(--faint)' }}>
              Your demo gym, <strong style={{ color: 'var(--mute)' }}>{info.demoGymName || 'BeFitter'}</strong>, is
              already running with a full roster, months of attendance, real programmes and an active community —
              so you can use it the way you would use your own.
            </p>

            {error && (
              <div className="mt-4 text-[12px] rounded-xl px-3 py-2.5"
                style={{ color: 'var(--bad)', background: 'rgba(var(--bad-rgb), .10)' }} role="alert">
                {error}
              </div>
            )}

            <Button onClick={start} loading={busy} size="lg" className="w-full mt-5">
              {info.state === 'active' ? 'Continue your demo' : 'Start 30-minute demo'}
            </Button>
            <p className="mt-3 text-[11px] text-center" style={{ color: 'var(--faint)' }}>
              {info.state === 'active'
                ? 'Your demo is already running — this picks up where you left off.'
                : 'The clock starts when you press this, not before.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Dead({ state, firstName, gym }) {
  const [title, body] = DEAD[state] || DEAD.not_found;
  return (
    <div className="text-center py-4">
      <h1 className="text-[19px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h1>
      <p className="mt-3 text-[13px] leading-relaxed" style={{ color: 'var(--mute)' }}>
        {firstName ? `${firstName}, ` : ''}{body}
      </p>
      {gym && (
        <p className="mt-4 text-[12.5px]" style={{ color: 'var(--mute)' }}>
          Still thinking about Barbell for {gym}?
        </p>
      )}
      <Link to="/demo" className="btn-primary mt-5 inline-flex">Request another demo</Link>
    </div>
  );
}
