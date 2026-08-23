import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { Spinner } from './components/UI.jsx';
import ClickSparkLazy from './components/ClickSparkLazy.jsx';
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
const Dashboard = lazy(() => import('./pages/trainer/Dashboard.jsx'));
const Clients = lazy(() => import('./pages/trainer/Clients.jsx'));
const ClientProfile = lazy(() => import('./pages/trainer/ClientProfile.jsx'));
const WorkoutBuilder = lazy(() => import('./pages/trainer/WorkoutBuilder.jsx'));
const NutritionBuilder = lazy(() => import('./pages/trainer/NutritionBuilder.jsx'));
const Alerts = lazy(() => import('./pages/trainer/Alerts.jsx'));
const Reports = lazy(() => import('./pages/trainer/Reports.jsx'));
const Messages = lazy(() => import('./pages/trainer/Messages.jsx'));
const Business = lazy(() => import('./pages/trainer/Business.jsx'));
const Home = lazy(() => import('./pages/client/Home.jsx'));
const Workout = lazy(() => import('./pages/client/Workout.jsx'));
const Nutrition = lazy(() => import('./pages/client/Nutrition.jsx'));
const NutritionTracker = lazy(() => import('./pages/client/NutritionTracker.jsx'));
const Progress = lazy(() => import('./pages/client/Progress.jsx'));
const Profile = lazy(() => import('./pages/client/Profile.jsx'));
const Settings = lazy(() => import('./pages/client/Settings.jsx'));
const Help = lazy(() => import('./pages/client/Help.jsx'));
// Design-system showcase — same treatment it already had.
const DesignSystem = lazy(() => import('./pages/DesignSystem.jsx'));

const PageFallback = <div className="min-h-screen grid place-items-center"><Spinner /></div>;
// Small helper so each route below stays a one-liner instead of repeating
// the same <Suspense fallback={...}> wrapper 16 times.
const page = (El) => <Suspense fallback={PageFallback}><El /></Suspense>;

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

export default function App() {
  const { ready, user, isTrainer, isClient } = useAuth();
  const authed = !!user;

  return (
    <ClickSparkLazy>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/setup-org" element={page(SetupOrg)} />
      <Route path="/independent" element={page(IndependentLogin)} />
      {/* Design-system showcase. Intentionally unauthenticated: it renders
          only static demo data, and needing a login to check a colour token
          is friction that stops people checking. */}
      <Route path="/design" element={page(DesignSystem)} />
      <Route path="/app" element={
        <Require ready={ready} ok={() => authed}>
          {isTrainer ? <Navigate to="/app/trainer" replace /> : <Navigate to="/app/client" replace />}
        </Require>
      } />
      <Route path="/app/trainer" element={
        <Require ready={ready} ok={() => authed && isTrainer} fallback={authed ? '/app/client' : '/login'}><TrainerLayout /></Require>
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
      </Route>
      <Route path="/app/client" element={
        <Require ready={ready} ok={() => authed && isClient} fallback={authed ? '/app/trainer' : '/login'}><ClientLayout /></Require>
      }>
        <Route index element={page(Home)} />
        <Route path="workout" element={page(Workout)} />
        <Route path="nutrition" element={page(Nutrition)} />
        <Route path="nutrition-tracker" element={page(NutritionTracker)} />
        <Route path="progress" element={page(Progress)} />
        <Route path="profile" element={page(Profile)} />
        <Route path="settings" element={page(Settings)} />
        <Route path="help" element={page(Help)} />
      </Route>
      <Route path="*" element={<Navigate to={authed ? (isTrainer ? '/app/trainer' : '/app/client') : '/login'} replace />} />
    </Routes>
    </ClickSparkLazy>
  );
}
