import { useState } from 'react';
import { api } from '../api.js';
import { useFetch, formatDateTime } from '../utils.js';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonCards, SkeletonRows } from '../components/Skeleton.jsx';

export default function SystemHealth() {
  const { data: health, loading: healthLoading, error: healthError } = useFetch(() => api('/console/system/health'));
  const [type, setType] = useState('');
  const { data: errors, loading: errorsLoading, error: errorsError } = useFetch(() => api(`/console/system/errors${type ? `?type=${type}` : ''}`), [type]);

  return (
    <div>
      <div className="page-header">
        <h1>System Health</h1>
        <p>Real signals only — a database round-trip, actual provider configuration, real error counts. Anything this pass genuinely can't check (external uptime, queue depth) is simply absent, never faked green.</p>
      </div>

      {healthLoading && <SkeletonCards count={5} />}
      {healthError && <div className="error-text">{healthError.message}</div>}

      {health && (
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="label">Database</div>
            <div className="value" style={{ fontSize: 18 }}>
              <span className={`badge ${health.database.healthy ? 'good' : 'bad'}`}>{health.database.healthy ? 'Healthy' : 'Down'}</span>
            </div>
            {health.database.latencyMs != null && <div className="faint" style={{ marginTop: 8 }}>{health.database.latencyMs}ms round-trip</div>}
          </div>
          <div className="kpi-card"><div className="label">Errors, last hour</div><div className="value">{health.errors.lastHour}</div></div>
          <div className="kpi-card"><div className="label">Errors, last 24h</div><div className="value">{health.errors.lastDay}</div></div>
          <div className="kpi-card">
            <div className="label">Payments</div>
            <div className="value" style={{ fontSize: 16 }}>{health.payments.provider}</div>
            <div className="faint" style={{ marginTop: 8 }}>{health.payments.liveConfigured ? 'Live keys configured' : 'Test / mock mode'}</div>
          </div>
          <div className="kpi-card">
            <div className="label">Food AI</div>
            <div className="value" style={{ fontSize: 16 }}>{health.ai.anyProviderConfigured ? 'Provider configured' : 'No provider configured'}</div>
            <div className="faint" style={{ marginTop: 8 }}>Chain: {health.ai.chain.join(' → ')}</div>
          </div>
          {health.email && (
            <div className="kpi-card">
              <div className="label">Email</div>
              <div className="value" style={{ fontSize: 16 }}>{health.email.provider}</div>
              <div className="faint" style={{ marginTop: 8 }}>{health.email.liveConfigured ? 'Live provider configured' : 'Mock mode -- no real delivery'}</div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Error center</h2>
        <div className="search-row">
          <select className="input" style={{ maxWidth: 220 }} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            <option value="server_error">Server errors</option>
            <option value="client_error">Client errors</option>
          </select>
        </div>
        {errorsLoading && <SkeletonRows rows={4} cols={4} />}
        {errorsError && <div className="error-text">{errorsError.message}</div>}
        {errors && !errors.errors.length && <EmptyState icon="health" title="No errors recorded" description="Server and client errors will show up here as they happen." />}
        {errors && errors.errors.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Type</th><th>Gym</th><th>Message</th><th>When</th></tr></thead>
              <tbody>
                {errors.errors.map((e) => (
                  <tr key={e.id}>
                    <td><span className={`badge ${e.type === 'server_error' ? 'bad' : 'warn'}`}>{e.type === 'server_error' ? 'Server' : 'Client'}</span></td>
                    <td className="faint">{e.orgName || '—'}</td>
                    <td>{e.message || e.path || '—'}</td>
                    <td className="faint">{formatDateTime(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
