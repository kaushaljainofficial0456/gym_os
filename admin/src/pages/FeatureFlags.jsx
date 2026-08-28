import { useState } from 'react';
import { api } from '../api.js';
import { useFetch } from '../utils.js';

const emptyForm = { key: '', name: '', description: '' };

export default function FeatureFlags() {
  const { data, loading, error, reload } = useFetch(() => api('/console/features'));
  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState(null);
  const [rolloutDrafts, setRolloutDrafts] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const create = async (e) => {
    e.preventDefault();
    if (!form.key.trim() || !form.name.trim()) return;
    setCreating(true); setFormError(null);
    try {
      await api('/console/features', { method: 'POST', body: JSON.stringify(form) });
      setForm(emptyForm);
      reload();
    } catch (err) {
      setFormError(err.data?.issues?.join('; ') || err.message);
    } finally { setCreating(false); }
  };

  const toggle = async (flag) => {
    await api(`/console/features/${flag.id}`, { method: 'POST', body: JSON.stringify({ enabled: !flag.enabled }) });
    reload();
  };

  const saveRollout = async (flag) => {
    const draft = rolloutDrafts[flag.id];
    if (draft == null || draft === '') return;
    await api(`/console/features/${flag.id}`, { method: 'POST', body: JSON.stringify({ rolloutPercentage: Number(draft) }) });
    setRolloutDrafts((d) => { const next = { ...d }; delete next[flag.id]; return next; });
    reload();
  };

  const remove = async (flag) => {
    if (confirmDeleteId !== flag.id) { setConfirmDeleteId(flag.id); return; }
    await api(`/console/features/${flag.id}`, { method: 'DELETE' });
    setConfirmDeleteId(null);
    reload();
  };

  return (
    <div>
      <div className="page-header">
        <h1>Feature Flags</h1>
        <p>Global on/off, a percentage rollout, or an explicit per-gym allow-list (which always wins). This builds the store and evaluation only — no existing feature checks a flag yet.</p>
      </div>

      <div className="card">
        <h2>New flag</h2>
        <form onSubmit={create}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Key</label>
              <input className="input" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} placeholder="new_dashboard" />
              <div className="faint" style={{ marginTop: 5 }}>lowercase letters, digits, underscore, dot, dash</div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Name</label>
              <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="New dashboard" />
            </div>
          </div>
          <div className="field">
            <label>Description (optional)</label>
            <input className="input" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <button className="btn" type="submit" disabled={creating || !form.key.trim() || !form.name.trim()}>{creating ? 'Creating…' : 'Create flag'}</button>
          {formError && <div className="error-text">{formError}</div>}
        </form>
      </div>

      {loading && <div className="spinner-row">Loading…</div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.flags.length && <div className="empty-state">No feature flags yet.</div>}

      {data && data.flags.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Key</th><th>Name</th><th>Enabled</th><th>Rollout</th><th>Allow-listed gyms</th><th></th></tr></thead>
            <tbody>
              {data.flags.map((f) => (
                <tr key={f.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 400, color: 'var(--ink-soft)' }}>{f.key}</td>
                  <td>{f.name}{f.description ? <div className="faint">{f.description}</div> : null}</td>
                  <td>
                    <label className="switch">
                      <input type="checkbox" checked={!!f.enabled} onChange={() => toggle(f)} />
                      <span className="track" />
                    </label>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        className="input" type="number" min={0} max={100} style={{ width: 68, padding: '7px 9px' }}
                        value={rolloutDrafts[f.id] ?? f.rollout_percentage}
                        onChange={(e) => setRolloutDrafts((d) => ({ ...d, [f.id]: e.target.value }))}
                      />
                      <span className="faint">%</span>
                      <button className="btn ghost" onClick={() => saveRollout(f)}>Save</button>
                    </div>
                  </td>
                  <td className="faint">{f.enabled_org_ids.length || '—'}</td>
                  <td>
                    <button className="btn ghost" onClick={() => remove(f)}>{confirmDeleteId === f.id ? 'Confirm?' : 'Delete'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
