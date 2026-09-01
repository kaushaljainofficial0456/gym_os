import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { SkeletonBlock } from './components/Skeleton.jsx';
import Layout from './Layout.jsx';
import Login from './pages/Login.jsx';

// Route-level code splitting (performance pass) -- this package used to
// import all 14 post-login pages eagerly into one bundle (241 kB, no
// splitting at all), unlike the main frontend app which already lazy-
// loads 33 routes the same way. Login stays eager: it's the one screen
// nearly every session hits first, and it's a single small page, so
// there's nothing to gain and a real (if small) first-paint cost to
// lazy-loading it. Every other page loads its own chunk on first visit
// instead of shipping all of them (gyms, payments, reconciliation,
// support, food intelligence, ML monitoring, risk, feature flags,
// announcements, system health, audit log) up front for every login.
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Gyms = lazy(() => import('./pages/Gyms.jsx'));
const GymDetail = lazy(() => import('./pages/GymDetail.jsx'));
const Payments = lazy(() => import('./pages/Payments.jsx'));
const Refunds = lazy(() => import('./pages/Refunds.jsx'));
const Reconciliation = lazy(() => import('./pages/Reconciliation.jsx'));
const AuditLog = lazy(() => import('./pages/AuditLog.jsx'));
const Support = lazy(() => import('./pages/Support.jsx'));
const SupportDetail = lazy(() => import('./pages/SupportDetail.jsx'));
const FoodIntelligence = lazy(() => import('./pages/FoodIntelligence.jsx'));
const MlMonitoring = lazy(() => import('./pages/MlMonitoring.jsx'));
const Risk = lazy(() => import('./pages/Risk.jsx'));
const FeatureFlags = lazy(() => import('./pages/FeatureFlags.jsx'));
const Announcements = lazy(() => import('./pages/Announcements.jsx'));
const SystemHealth = lazy(() => import('./pages/SystemHealth.jsx'));

const PageFallback = <div style={{ padding: 24 }}><SkeletonBlock height={280} /></div>;
// One-liner per route, same shape as the main frontend's own `page()`
// helper -- no per-page repetition of the Suspense wrapper.
const page = (El) => <Suspense fallback={PageFallback}><El /></Suspense>;

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Layout />}>
            <Route index element={page(Dashboard)} />
            <Route path="gyms" element={page(Gyms)} />
            <Route path="gyms/:id" element={page(GymDetail)} />
            <Route path="payments" element={page(Payments)} />
            <Route path="refunds" element={page(Refunds)} />
            <Route path="reconciliation" element={page(Reconciliation)} />
            <Route path="support" element={page(Support)} />
            <Route path="support/:id" element={page(SupportDetail)} />
            <Route path="intelligence/food" element={page(FoodIntelligence)} />
            <Route path="intelligence/ml" element={page(MlMonitoring)} />
            <Route path="risk" element={page(Risk)} />
            <Route path="features" element={page(FeatureFlags)} />
            <Route path="announcements" element={page(Announcements)} />
            <Route path="system-health" element={page(SystemHealth)} />
            <Route path="audit" element={page(AuditLog)} />
          </Route>
        </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}
