import { api } from '../api.js';
import { useFetch, money } from '../utils.js';

// Every number here comes straight from GET /api/console/dashboard's
// real aggregate queries -- see console.js. Nothing on this page is
// hardcoded; an empty platform shows real zeros, per the spec's own
// "never fabricate metrics" rule.
export default function Dashboard() {
  const { data, loading, error } = useFetch(() => api('/console/dashboard'));

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Real-time platform overview -- every number below is a live database aggregate.</p>
      </div>

      {loading && <div className="spinner-row">Loading…</div>}
      {error && <div className="error-text">{error.message}</div>}

      {data && (
        <div className="kpi-grid">
          <Kpi label="Total gyms" value={data.totalGyms} />
          <Kpi label="Active gyms" value={data.activeGyms} />
          <Kpi label="Total clients" value={data.totalClients} />
          <Kpi label="Total trainers" value={data.totalTrainers} />
          <Kpi label="Active memberships" value={data.activeMemberships} />
          <Kpi label="Revenue today" value={money(data.revenueToday)} raw />
          <Kpi label="Revenue this month" value={money(data.revenueThisMonth)} raw />
          <Kpi label="Payment failures today" value={data.paymentFailuresToday} />
          <Kpi label="Total refunds issued" value={data.totalRefunds} />
          <Kpi label="Open reconciliation issues" value={data.openReconciliationIssues} />
          <Kpi label="Open support tickets" value={data.openSupportTickets} />
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, raw, na }) {
  const isNA = na || value == null;
  return (
    <div className="kpi-card">
      <div className="label">{label}</div>
      <div className={`value${isNA ? ' na' : ''}`}>{isNA ? 'N/A' : raw ? value : value}</div>
      {isNA && <div className="faint">Not built this pass</div>}
    </div>
  );
}
