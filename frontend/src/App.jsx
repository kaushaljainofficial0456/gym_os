import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { Spinner } from './components/UI.jsx';
import ClickSparkLazy from './components/ClickSparkLazy.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
// Login/SignUp stay eager: they're the first thing an unauthenticated visitor
// needs, so there's no "next page" to defer them in favor of.
import Login from './pages/Login.jsx';
import SignUp from './pages/SignUp.jsx';
import TrainerLayout from './pages/trainer/TrainerLayout.jsx';
import ClientLayout from './pages/client/ClientLayout.jsx';

// Every other page is route-split: previously all of these were static
// imports, so the entry bundle (the one thing every visitor downloads
// before anything renders, even the login page) included every trainer and
// client page plus their dependency trees -- most notably WorkoutBuilder's
// 3D muscle picker, which alone pulls in three.js (~735 kB before gzip).
// None of that is needed until the specific route is actually visited.
// SetupOrg/IndependentLogin are one tap past Login's landing screen (not
// the first thing a visitor needs), and IndependentLogin in particular
// pulls in Google's own GSI script on top -- both split like every other
// non-entry page rather than joining Login/SignUp's eager pair.
const SetupOrg = lazy(() => import('./pages/SetupOrg.jsx'));
const IndependentLogin = lazy(() => import('./pages/IndependentLogin.jsx'));
const TrainerSignUp = lazy(() => import('./pages/TrainerSignUp.jsx'));
const JoinGym = lazy(() => import('./pages/JoinGym.jsx'));
const Dashboard = lazy(() => import('./pages/trainer/Dashboard.jsx'));
const Clients = lazy(() => import('./pages/trainer/Clients.jsx'));
const ClientProfile = lazy(() => import('./pages/trainer/ClientProfile.jsx'));
const WorkoutBuilder = lazy(() => import('./pages/trainer/WorkoutBuilder.jsx'));
const NutritionBuilder = lazy(() => import('./pages/trainer/NutritionBuilder.jsx'));
const Alerts = lazy(() => import('./pages/trainer/Alerts.jsx'));
const Reports = lazy(() => import('./pages/trainer/Reports.jsx'));
const Messages = lazy(() => import('./pages/trainer/Messages.jsx'));
const Business = lazy(() => import('./pages/trainer/Business.jsx'));
const EnterpriseOnboarding = lazy(() => import('./pages/trainer/EnterpriseOnboarding.jsx'));
const EnterpriseDashboard = lazy(() => import('./pages/trainer/EnterpriseDashboard.jsx'));
const EnterpriseQR = lazy(() => import('./pages/trainer/EnterpriseQR.jsx'));
const EnterpriseBilling = lazy(() => import('./pages/trainer/EnterpriseBilling.jsx'));
const Home = lazy(() => import('./pages/client/Home.jsx'));
const Workout = lazy(() => import('./pages/client/Workout.jsx'));
const Nutrition = lazy(() => import('./pages/client/Nutrition.jsx'));
const NutritionTracker = lazy(() => import('./pages/client/NutritionTracker.jsx'));
const Progress = lazy(() => import('./pages/client/Progress.jsx'));
const Profile = lazy(() => import('./pages/client/Profile.jsx'));
const Settings = lazy(() => import('./pages/client/Settings.jsx'));
const Help = lazy(() => import('./pages/client/Help.jsx'));
const Community = lazy(() => import('./pages/client/Community.jsx'));
const Membership = lazy(() => import('./pages/client/Membership.jsx'));
// Design-system showcase — same treatment it already had.
const DesignSystem = lazy(() => import('./pages/DesignSystem.jsx'));
const SharedMeal = lazy(() => import('./pages/public/SharedMeal.jsx'));

const PageFallback = <div className="min-h-screen grid place-items-center"><Spinner /></div>;
// Small helper so each route below stays a one-liner instead of repeating
// the same <Suspense fallback={...}> wrapper 16 times.
// ErrorBoundary here, not just Suspense: a render crash anywhere in a
// lazy-loaded page previously white-screened the ENTIRE app (nav, sidebar,
// everything) with no recovery but a manual refresh -- now it's contained
// to the page that broke, with a real recovery affordance and a reported
// crash (see ErrorBoundary.jsx). One boundary per route means one page
// crashing never takes the rest of the app down with it.
const page = (El) => <ErrorBoundary><Suspense fallback={PageFallback}><El /></Suspense></ErrorBoundary>;

// `fallback` distinguishes "not logged in" from "logged in, wrong role for
// this subtree" — e.g. a trainer hitting an /app/client/* URL is still
// authenticated, so bouncing to /login (which looked identical to a real
// session-expiry) was confusing. Sends them to their own home instead,
// matching the role-aware redirect the catch-all route below already uses.
function Require({ ready, ok, fallback = '/login', children }) {
  if (!ready) return <div className="min-h-screen grid place-items-center"><Spinner /></div>;
  if (!ok()) return <Navigate to={fallback} replace />;
  return children;
}

// A CLIENT or TRAINER account can exist with no gym yet -- registered
// directly (no gymCode) or self-served via /signup/trainer, waiting on a
// QR scan to actually join an org (see auth.js's /register,
// /register-trainer). orgId (camelCase, straight off login/register) and
// org_id (snake_case, off /auth/me on a page refresh -- auth.jsx's own
// comment on this pre-existing inconsistency) are both checked so this
// never flips depending on which shape happened to load last.
function needsGymJoin(user) {
  return !!user && ['CLIENT', 'TRAINER'].includes(user.role) && !user.orgId && !user.org_id;
}

export default function App() {
  const { ready, user, isTrainer, isClient } = useAuth();
  const authed = !!user;
  const pendingGym = needsGymJoin(user);

  return (
    <ClickSparkLazy>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/signup/trainer" element={page(TrainerSignUp)} />
      <Route path="/setup-org" element={page(SetupOrg)} />
      <Route path="/independent" element={page(IndependentLogin)} />
      {/* Design-system showcase. Intentionally unauthenticated: it renders
          only static demo data, and needing a login to check a colour token
          is friction that stops people checking. */}
      <Route path="/design" element={page(DesignSystem)} />
      {/* Share Meals preview -- PUBLIC on purpose (see SharedMeal.jsx):
          a recipient must be able to preview a shared meal before ever
          being asked to log in. Saving it into their own diet still
          requires auth, enforced by the API route it calls, not by this
          route being gated. */}
      <Route path="/share/:id" element={page(SharedMeal)} />
      {/* QR-based gym join -- any authenticated CLIENT or TRAINER with no
          org yet lands here (see needsGymJoin above) instead of a normal
          dashboard, which would otherwise 404/empty-state on every
          org-scoped call it tries to make. */}
      <Route path="/join" element={
        <Require ready={ready} ok={() => authed && ['CLIENT', 'TRAINER'].includes(user?.role)}>{page(JoinGym)}</Require>
      } />
      <Route path="/app" element={
        <Require ready={ready} ok={() => authed}>
          {pendingGym ? <Navigate to="/join" replace /> : isTrainer ? <Navigate to="/app/trainer" replace /> : <Navigate to="/app/client" replace />}
        </Require>
      } />
      <Route path="/app/trainer" element={
        <Require ready={ready} ok={() => authed && isTrainer && !pendingGym} fallback={authed ? (pendingGym ? '/join' : '/app/client') : '/login'}><TrainerLayout /></Require>
      }>
        <Route index element={page(Dashboard)} />
        <Route path="clients" element={page(Clients)} />
        <Route path="clients/:id" element={page(ClientProfile)} />
        <Route path="workouts" element={page(WorkoutBuilder)} />
        <Route path="nutrition" element={page(NutritionBuilder)} />
        <Route path="alerts" element={page(Alerts)} />
        <Route path="reports" element={page(Reports)} />
        <Route path="messages" element={page(Messages)} />
        <Route path="business" element={page(Business)} />
        {/* Enterprise: SK OS billing THIS gym (packages/QR/upgrades) --
            distinct from Business above (this gym billing ITS OWN
            clients). Owner-only; TrainerLayout only shows the nav link
            to isOwner, but the routes themselves are the real gate. */}
        <Route path="enterprise" element={page(EnterpriseDashboard)} />
        <Route path="enterprise/onboarding" element={page(EnterpriseOnboarding)} />
        <Route path="enterprise/qr" element={page(EnterpriseQR)} />
        <Route path="enterprise/billing" element={page(EnterpriseBilling)} />
      </Route>
      <Route path="/app/client" element={
        <Require ready={ready} ok={() => authed && isClient && !pendingGym} fallback={authed ? (pendingGym ? '/join' : '/app/trainer') : '/login'}><ClientLayout /></Require>
      }>
        <Route index element={page(Home)} />
        <Route path="workout" element={page(Workout)} />
        <Route path="nutrition" element={page(Nutrition)} />
        <Route path="nutrition-tracker" element={page(NutritionTracker)} />
        <Route path="progress" element={page(Progress)} />
        <Route path="profile" element={page(Profile)} />
        <Route path="membership" element={page(Membership)} />
        <Route path="settings" element={page(Settings)} />
        <Route path="community" element={page(Community)} />
        <Route path="help" element={page(Help)} />
      </Route>
      <Route path="*" element={<Navigate to={authed ? (pendingGym ? '/join' : isTrainer ? '/app/trainer' : '/app/client') : '/login'} replace />} />
    </Routes>
    </ClickSparkLazy>
  );
}
