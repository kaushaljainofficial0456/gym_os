import { api } from '../api.js';
import { useFetch, money } from '../utils.js';
import { useAuth } from '../auth.jsx';
import StatCard from '../components/StatCard.jsx';
import Decoration from '../components/Decoration.jsx';
import { SkeletonCards } from '../components/Skeleton.jsx';

// Every number here comes straight from GET /api/console/dashboard's
// real aggregate queries -- see console.js. Nothing on this page is
// hardcoded; an empty platform shows real zeros (a genuine 0 is a
// number, shown and animated like any other), and a metric this pass
// never built shows "N/A" via StatCard's own non-numeric path, never a
// fabricated figure.
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Dashboard() {
  const { data, loading, error } = useFetch(() => api('/console/dashboard'));
  const { user } = useAuth();
  const firstName = (user?.name || '').split(' ')[0] || 'there';

  return (
    <div style={{ position: 'relative' }}>
      <Decoration variant="dashboard" />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div className="page-header">
          <h1>{greeting()}, {firstName}</h1>
          <p>Real-time platform overview — every number below is a live database aggregate, never a placeholder.</p>
        </div>

        {loading && <SkeletonCards count={11} />}
        {error && <div className="error-text">{error.message}</div>}

        {data && (
          <div className="kpi-grid">
            <StatCard icon="gyms" label="Total gyms" value={data.totalGyms} />
            <StatCard icon="check" label="Active gyms" value={data.activeGyms} />
            <StatCard icon="users" label="Total clients" value={data.totalClients} />
            <StatCard icon="user" label="Total trainers" value={data.totalTrainers} />
            <StatCard icon="dumbbell" label="Active memberships" value={data.activeMemberships} />
            <StatCard icon="payments" label="Revenue today" value={data.revenueToday ?? 'N/A'} format={money} />
            <StatCard icon="trend" label="Revenue this month" value={data.revenueThisMonth ?? 'N/A'} format={money} />
            <StatCard icon="errors" label="Payment failures today" value={data.paymentFailuresToday} />
            <StatCard icon="refunds" label="Total refunds issued" value={data.totalRefunds} />
            <StatCard icon="reconciliation" label="Open reconciliation issues" value={data.openReconciliationIssues} />
            <StatCard icon="support" label="Open support tickets" value={data.openSupportTickets} />
          </div>
        )}
      </div>
    </div>
  );
}
