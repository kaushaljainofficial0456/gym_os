import { useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { ArrowRight, Building2, Dumbbell, UserRound } from 'lucide-react';
import { useAuth } from '../auth.jsx';
import { consumeReturnTo } from '../api.js';
import { announceArrival } from '../components/ArrivalHost.jsx';
import { PasswordInput } from '../components/UI.jsx';
import { useAuthStage } from '../components/auth/AuthLayout.jsx';
import { AuthTitle, ChoiceRow, Cta, Divider, ErrorNote, Field, RoleSwitch } from '../components/auth/authKit.jsx';

// The three top-level paths onto Barbell. Each is a genuinely different
// account-creation story, not a cosmetic split of one login form:
//   - Enterprise: a gym's very first visit, before any account exists ->
//     /setup-org (POST /auth/setup-org).
//   - Gym ecosystem: someone whose account already exists under a gym
//     (trainer, owner, or a gym-code client) -> the sign-in form below.
//   - Independent client: no gym at all -> /independent (Google sign-in,
//     POST /auth/google).
const PATHS = [
  { id: 'enterprise', icon: Building2, title: 'Enterprise', sub: 'Set up a new gym' },
  { id: 'ecosystem', icon: Dumbbell, title: 'Gym ecosystem', sub: 'Clients, trainers and owners' },
  { id: 'independent', icon: UserRound, title: 'Independent client', sub: 'Train solo, no gym needed' },
];

/* Sign-in itself does not depend on the role -- the account knows what it
   is. The switch decides which demo account the demo button opens and
   where "new here" leads, and it is remembered for next time. */
const ROLES = [
  { id: 'CLIENT', label: 'Client' },
  { id: 'TRAINER', label: 'Trainer' },
  { id: 'GYM_OWNER', label: 'Owner' },
];
const DEMO = { CLIENT: 'client1@ironforge.in', TRAINER: 'trainer1@ironforge.in', GYM_OWNER: 'owner@ironforge.in' };
const NEW_HERE = {
  CLIENT: ['New here?', 'Create an account', '/signup'],
  TRAINER: ['New trainer?', 'Create an account', '/signup/trainer'],
  GYM_OWNER: ['New gym?', 'Set it up', '/setup-org'],
};
const ROLE_KEY = 'barbell-last-role';

function lastRole() {
  try {
    const r = localStorage.getItem(ROLE_KEY);
    return ROLES.some((x) => x.id === r) ? r : 'CLIENT';
  } catch { return 'CLIENT'; }
}

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  // The step lives in history state, not component state, so the phone's
  // back gesture walks back through the flow instead of leaving it.
  const view = location.state?.view === 'signin' ? 'signin' : 'landing';
  const dir = navType === 'POP' ? 'back' : 'fwd';
  // The route's own entrance already animates the first step; only a
  // change of step animates here, or the two slides would add up.
  const firstView = useRef(view);
  const switched = useRef(false);
  if (view !== firstView.current) switched.current = true;
  const stepClass = switched.current ? 'auth-view' : undefined;
  useAuthStage(view === 'landing' ? 'hero' : 'compact');

  const [role, setRoleState] = useState(lastRole);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const setRole = (r) => {
    setRoleState(r);
    try { localStorage.setItem(ROLE_KEY, r); } catch { /* storage blocked */ }
  };

  const go = (u) => {
    if (u.role !== 'CLIENT') return nav('/app/trainer');
    announceArrival(u.name);
    // A shared-meal preview (or similar) that sent this visitor to log in
    // gets priority over the default client home -- consumed once, never
    // re-applied to a later, unrelated login. It never auto-completes the
    // action they were headed toward; it only returns them to that page.
    // Without one, GuestOnly sends them home (or to the terms first).
    const back = consumeReturnTo();
    return back ? nav(back) : undefined;
  };

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { go(await fn()); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  const submit = (e) => { e.preventDefault(); run(() => login(email, password)); };
  const demo = () => run(() => login(DEMO[role], 'demo1234'));

  const pickPath = (id) => {
    if (id === 'enterprise') return nav('/setup-org');
    if (id === 'independent') return nav('/independent');
    setErr('');
    return nav('/login', { state: { view: 'signin' } });
  };
  const back = () => (location.key !== 'default' ? nav(-1) : nav('/login', { replace: true, state: null }));

  const [newQ, newA, newTo] = NEW_HERE[role];

  return (
    <>
      {view === 'landing' ? (
        <div key="landing" className={stepClass} data-dir={dir}>
          <AuthTitle eyebrow="Welcome" title="How will you use Barbell?" />
          <div className="auth-rows auth-rise">
            {PATHS.map((p) => (
              <ChoiceRow key={p.id} icon={p.icon} title={p.title} sub={p.sub} onClick={() => pickPath(p.id)} />
            ))}
          </div>
        </div>
      ) : (
        <div key="signin" className={stepClass} data-dir={dir}>
          <AuthTitle title="Sign in" onBack={back} />
          <RoleSwitch label="I'm signing in as" options={ROLES} value={role} onChange={setRole} />

          <form onSubmit={submit} className="auth-form">
            <Field id="email" label="Email">
              <input id="email" className="input auth-input" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username" inputMode="email"
                aria-invalid={err ? 'true' : undefined}
                placeholder="you@yourgym.com" required autoFocus />
            </Field>
            <Field id="password" label="Password"
              aside={<Link to="/forgot-password" className="auth-aside">Forgot password?</Link>}>
              <PasswordInput id="password" className="auth-input" value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-invalid={err ? 'true' : undefined}
                placeholder="Your password" required />
            </Field>
            <ErrorNote>{err}</ErrorNote>
            <Cta busy={busy}>Sign in</Cta>
          </form>

          <p className="auth-foot">{newQ} <Link to={newTo}>{newA}</Link></p>

          <Divider />
          <button type="button" className="auth-ghost" onClick={demo} disabled={busy}>
            Explore the demo
            <ArrowRight size={16} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}
