import { useState } from 'react';
import { api } from '../api.js';
import { useFetch, formatDateTime } from '../utils.js';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

const PAGE_SIZE = 50;

export default function AuditLog() {
  const [q, setQ] = useState('');
  const [entityType, setEntityType] = useState('');
  const [since, setSince] = useState('');
  const [page, setPage] = useState(0);

  const query = new URLSearchParams();
  if (q.trim()) query.set('q', q.trim());
  if (entityType) query.set('entityType', entityType);
  if (since) query.set('since', new Date(since).toISOString());
  query.set('limit', String(PAGE_SIZE));
  query.set('offset', String(page * PAGE_SIZE));

  const { data, loading, error } = useFetch(() => api(`/console/audit?${query.toString()}`), [q, entityType, since, page]);

  const resetFilters = () => { setQ(''); setEntityType(''); setSince(''); setPage(0); };
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div>
      <div className="page-header">
        <h1>Audit Log</h1>
        <p>Every sensitive Admin Console action, immutable and append-only.</p>
      </div>

      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px 180px auto', gap: 10, alignItems: 'end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Search</label>
            <input className="input" placeholder="action, entity type, entity id…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Entity type</label>
            <select className="input" value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {['organization', 'payment_order', 'support_ticket', 'reconciliation_issue', 'risk_event', 'export'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Since</label>
            <input className="input" type="date" value={since} onChange={(e) => { setSince(e.target.value); setPage(0); }} />
          </div>
          <button className="btn ghost" onClick={resetFilters}>Clear</button>
        </div>
      </div>

      {loading && <div className="card"><SkeletonRows rows={8} cols={4} /></div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.logs.length && (
        <div className="card"><EmptyState icon="audit" title="No matching actions" description="Nothing in the audit trail matches these filters." /></div>
      )}

      {data && data.logs.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr><th>Admin</th><th>Action</th><th>Entity</th><th>When</th></tr>
            </thead>
            <tbody>
              {data.logs.map((l) => (
                <tr key={l.id}>
                  <td>{l.admin_name}<div className="faint">{l.admin_email}</div></td>
                  <td>{l.action}</td>
                  <td className="faint">{l.entity_type ? `${l.entity_type}:${l.entity_id}` : '—'}</td>
                  <td className="faint">{formatDateTime(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
            <span className="faint">{data.total} total · page {page + 1} of {totalPages}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Previous</button>
              <button className="btn ghost" onClick={() => setPage((p) => p + 1)} disabled={page + 1 >= totalPages}>Next</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
