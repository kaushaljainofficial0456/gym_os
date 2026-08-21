import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { Spinner } from './components/UI.jsx';
import Login from './pages/Login.jsx';
import TrainerLayout from './pages/trainer/TrainerLayout.jsx';
import Dashboard from './pages/trainer/Dashboard.jsx';
import Clients from './pages/trainer/Clients.jsx';
import ClientProfile from './pages/trainer/ClientProfile.jsx';
import WorkoutBuilder from './pages/trainer/WorkoutBuilder.jsx';
import NutritionBuilder from './pages/trainer/NutritionBuilder.jsx';
import Alerts from './pages/trainer/Alerts.jsx';
import Reports from './pages/trainer/Reports.jsx';
import Messages from './pages/trainer/Messages.jsx';
import Business from './pages/trainer/Business.jsx';
import ClientLayout from './pages/client/ClientLayout.jsx';
import Home from './pages/client/Home.jsx';
import Workout from './pages/client/Workout.jsx';
import Nutrition from './pages/client/Nutrition.jsx';
import Progress from './pages/client/Progress.jsx';
import Profile from './pages/client/Profile.jsx';
import Settings from './pages/client/Settings.jsx';
import Help from './pages/client/Help.jsx';

// Lazy: the design-system showcase is a reference page for the team, not
// something a real user navigates to. Static-importing it would put its
// demo content in the entry chunk everyone downloads.
const DesignSystem = lazy(() => import('./pages/DesignSystem.jsx'));

function Require({ ready, ok, children }) {
  if (!ready) return <div className="min-h-screen grid place-items-center"><Spinner /></div>;
  if (!ok()) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { ready, user, isTrainer, isClient } = useAuth();
  const authed = !!user;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Design-system showcase. Intentionally unauthenticated: it renders
          only static demo data, and needing a login to check a colour token
          is friction that stops people checking. */}
      <Route
        path="/design"
        element={
          <Suspense fallback={<div className="min-h-screen grid place-items-center"><Spinner /></div>}>
            <DesignSystem />
          </Suspense>
        }
      />
      <Route path="/app" element={
        <Require ready={ready} ok={() => authed}>
          {isTrainer ? <Navigate to="/app/trainer" replace /> : <Navigate to="/app/client" replace />}
        </Require>
      } />
      <Route path="/app/trainer" element={
        <Require ready={ready} ok={() => authed && isTrainer}><TrainerLayout /></Require>
      }>
        <Route index element={<Dashboard />} />
        <Route path="clients" element={<Clients />} />
        <Route path="clients/:id" element={<ClientProfile />} />
        <Route path="workouts" element={<WorkoutBuilder />} />
        <Route path="nutrition" element={<NutritionBuilder />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="reports" element={<Reports />} />
        <Route path="messages" element={<Messages />} />
        <Route path="business" element={<Business />} />
      </Route>
      <Route path="/app/client" element={
        <Require ready={ready} ok={() => authed && isClient}><ClientLayout /></Require>
      }>
        <Route index element={<Home />} />
        <Route path="workout" element={<Workout />} />
        <Route path="nutrition" element={<Nutrition />} />
        <Route path="progress" element={<Progress />} />
        <Route path="profile" element={<Profile />} />
        <Route path="settings" element={<Settings />} />
        <Route path="help" element={<Help />} />
      </Route>
      <Route path="*" element={<Navigate to={authed ? (isTrainer ? '/app/trainer' : '/app/client') : '/login'} replace />} />
    </Routes>
  );
}
