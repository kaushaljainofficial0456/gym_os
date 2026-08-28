import { useState } from 'react';
import { api } from '../api.js';
import { useFetch } from '../utils.js';

const AUDIENCE_LABEL = { ALL: 'Everyone', OWNERS: 'Gym owners', TRAINERS: 'Trainers', CLIENTS: 'Clients' };
const PRIORITY_TONE = { LOW: 'mute', NORMAL: 'mute', HIGH: 'warn', URGENT: 'bad' };
const emptyForm = { title: '', message: '', audience: 'ALL', priority: 'NORMAL', startsAt: '', endsAt: '' };

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time, not the ISO
// string the API stores -- convert both directions explicitly rather
// than relying on the browser to guess.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isActiveNow(a) {
  const now = Date.now();
  if (a.starts_at && new Date(a.starts_at).getTime() > now) return false;
  if (a.ends_at && new Date(a.ends_at).getTime() < now) return false;
  return true;
}

export default function Announcements() {
  const { data, loading, error, reload } = useFetch(() => api('/console/announcements'));
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const startEdit = (a) => {
    setEditingId(a.id);
    setFormError(null);
    setForm({
      title: a.title, message: a.message, audience: a.audience, priority: a.priority,
      startsAt: toLocalInput(a.starts_at), endsAt: toLocalInput(a.ends_at),
    });
  };
  const cancelEdit = () => { setEditingId(null); setForm(emptyForm); setFormError(null); };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim() || !form.message.trim()) return;
    setBusy(true); setFormError(null);
    const body = {
      title: form.title, message: form.message, audience: form.audience, priority: form.priority,
      startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
      endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
    };
    try {
      if (editingId) await api(`/console/announcements/${editingId}`, { method: 'POST', body: JSON.stringify(body) });
      else await api('/console/announcements', { method: 'POST', body: JSON.stringify(body) });
      cancelEdit();
      reload();
    } catch (err) {
      setFormError(err.data?.issues?.join('; ') || err.message);
    } finally { setBusy(false); }
  };

  const remove = async (a) => {
    if (confirmDeleteId !== a.id) { setConfirmDeleteId(a.id); return; }
    await api(`/console/announcements/${a.id}`, { method: 'DELETE' });
    setConfirmDeleteId(null);
    reload();
  };

  return (
    <div>
      <div className="page-header">
        <h1>Announcements</h1>
        <p>Platform-wide messages by audience and priority, with an optional active window. This builds the data only — no banner exists yet in the gym-owner app to display them.</p>
      </div>

      <div className="card">
        <h2>{editingId ? 'Edit announcement' : 'New announcement'}</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label>Title</label>
            <input className="input" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </div>
          <div className="field">
            <label>Message</label>
            <textarea className="input" rows={3} value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Audience</label>
              <select className="input" value={form.audience} onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))}>
                {Object.entries(AUDIENCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Priority</label>
              <select className="input" value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
                {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Starts (optional)</label>
              <input className="input" type="datetime-local" value={form.startsAt} onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Ends (optional)</label>
              <input className="input" type="datetime-local" value={form.endsAt} onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
            <button className="btn" type="submit" disabled={busy || !form.title.trim() || !form.message.trim()}>
              {busy ? 'Saving…' : editingId ? 'Save changes' : 'Publish announcement'}
            </button>
            {editingId && <button type="button" className="btn ghost" onClick={cancelEdit}>Cancel</button>}
          </div>
          {formError && <div className="error-text">{formError}</div>}
        </form>
      </div>

      {loading && <div className="spinner-row">Loading…</div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.announcements.length && <div className="empty-state">No announcements yet.</div>}

      {data && data.announcements.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Title</th><th>Audience</th><th>Priority</th><th>Window</th><th>Active now</th><th></th></tr></thead>
            <tbody>
              {data.announcements.map((a) => (
                <tr key={a.id}>
                  <td>{a.title}<div className="faint">{a.message.length > 80 ? a.message.slice(0, 80) + '…' : a.message}</div></td>
                  <td className="faint">{AUDIENCE_LABEL[a.audience] || a.audience}</td>
                  <td><span className={`badge ${PRIORITY_TONE[a.priority] || 'mute'}`}>{a.priority}</span></td>
                  <td className="faint">
                    {a.starts_at ? String(a.starts_at).slice(0, 16).replace('T', ' ') : 'Always'}
                    {' → '}
                    {a.ends_at ? String(a.ends_at).slice(0, 16).replace('T', ' ') : 'Open-ended'}
                  </td>
                  <td>{isActiveNow(a) ? <span className="badge good">Active</span> : <span className="badge mute">Inactive</span>}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn ghost" onClick={() => startEdit(a)}>Edit</button>
                      <button className="btn ghost" onClick={() => remove(a)}>{confirmDeleteId === a.id ? 'Confirm?' : 'Delete'}</button>
                    </div>
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
