import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import Layout from './Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Gyms from './pages/Gyms.jsx';
import GymDetail from './pages/GymDetail.jsx';
import Payments from './pages/Payments.jsx';
import Reconciliation from './pages/Reconciliation.jsx';
import AuditLog from './pages/AuditLog.jsx';
import Support from './pages/Support.jsx';
import SupportDetail from './pages/SupportDetail.jsx';
import FoodIntelligence from './pages/FoodIntelligence.jsx';
import MlMonitoring from './pages/MlMonitoring.jsx';
import Risk from './pages/Risk.jsx';
import FeatureFlags from './pages/FeatureFlags.jsx';
import Announcements from './pages/Announcements.jsx';
import SystemHealth from './pages/SystemHealth.jsx';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="gyms" element={<Gyms />} />
          <Route path="gyms/:id" element={<GymDetail />} />
          <Route path="payments" element={<Payments />} />
          <Route path="reconciliation" element={<Reconciliation />} />
          <Route path="support" element={<Support />} />
          <Route path="support/:id" element={<SupportDetail />} />
          <Route path="intelligence/food" element={<FoodIntelligence />} />
          <Route path="intelligence/ml" element={<MlMonitoring />} />
          <Route path="risk" element={<Risk />} />
          <Route path="features" element={<FeatureFlags />} />
          <Route path="announcements" element={<Announcements />} />
          <Route path="system-health" element={<SystemHealth />} />
          <Route path="audit" element={<AuditLog />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
