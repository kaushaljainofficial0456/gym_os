import { useState } from 'react';
import { api } from '../api.js';
import { useFetch } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';

const AUDIENCE_LABEL = { ALL: 'Everyone', OWNERS: 'Gym owners', TRAINERS: 'Trainers', CLIENTS: 'Clients' };
const PRIORITY_TONE = { LOW: 'mute', NORMAL: 'mute', HIGH: 'warn', URGENT: 'bad' };
const emptyForm = { title: '', message: '', audience: 'ALL', priority: 'NORMAL', startsAt: '', endsAt: '' };

function windowStatus(a) {
  const now = Date.now();
  if (a.starts_at && new Date(a.starts_at).getTime() > now) return { label: 'SCHEDULED', tone: 'mute' };
  if (a.ends_at && new Date(a.ends_at).getTime() < now) return { label: 'EXPIRED', tone: 'mute' };
  return { label: 'ACTIVE', tone: 'good' };
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time, not the ISO
// string the API stores -- convert both directions explicitly rather
// than relying on the browser to guess.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function Announcements() {
  const { data, loading, error, reload } = useFetch(() => api('/console/announcements'));
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const toast = useToast();

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
      const wasEditing = !!editingId;
      cancelEdit();
      reload();
      toast.success(wasEditing ? 'Announcement updated' : 'Announcement published');
    } catch (err) {
      setFormError(err.data?.issues?.join('; ') || err.message);
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try { await api(`/console/announcements/${deleteTarget.id}`, { method: 'DELETE' }); setDeleteTarget(null); reload(); toast.success('Announcement deleted'); }
    catch (e) { toast.error(e.message || 'Could not delete'); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Announcements</h1>
        <p>Platform-wide messages by audience and priority, with an optional active window. Shown as a dismissible banner in the gym-owner, trainer, and client apps, filtered to whichever audience each viewer belongs to.</p>
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
          <div className="form-grid-4">
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

      {loading && <div className="card"><SkeletonRows rows={4} cols={6} /></div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.announcements.length && (
        <div className="card"><EmptyState icon="megaphone" title="No announcements yet" description="Publish one above to reach gym owners, trainers, or clients." /></div>
      )}

      {data && data.announcements.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead><tr><th>Title</th><th>Audience</th><th>Priority</th><th>Window</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.announcements.map((a) => {
                const ws = windowStatus(a);
                return (
                  <tr key={a.id}>
                    <td>{a.title}<div className="faint">{a.message.length > 80 ? a.message.slice(0, 80) + '…' : a.message}</div></td>
                    <td className="faint">{AUDIENCE_LABEL[a.audience] || a.audience}</td>
                    <td><span className={`badge ${PRIORITY_TONE[a.priority] || 'mute'}`}>{a.priority}</span></td>
                    <td className="faint">
                      {a.starts_at ? String(a.starts_at).slice(0, 16).replace('T', ' ') : 'Always'}
                      {' → '}
                      {a.ends_at ? String(a.ends_at).slice(0, 16).replace('T', ' ') : 'Open-ended'}
                    </td>
                    <td><span className={`badge ${ws.tone}`}>{ws.label}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn ghost" onClick={() => startEdit(a)}>Edit</button>
                        <button className="btn ghost" onClick={() => setDeleteTarget(a)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete "${deleteTarget?.title}"?`}
        description="This announcement will stop appearing to anyone, immediately."
        confirmLabel="Delete"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
