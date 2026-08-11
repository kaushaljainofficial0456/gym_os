import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, GOAL_LABEL, STATUS_META, cls } from '../../utils.js';
import { Card, Kicker, Spinner, ErrorState, Modal, StatusChip } from '../../components/UI.jsx';

const STATUS_FILTERS = ['ALL', 'ON_TRACK', 'NEEDS_ATTENTION', 'AT_RISK', 'INACTIVE'];

export default function Clients() {
  const { data, loading, error, reload } = useFetch(() => api('/clients'));
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('ALL');
  const [sort, setSort] = useState('status');
  const [createOpen, setCreateOpen] = useState(false);

  const filtered = useMemo(() => {
    let rows = data?.clients || [];
    if (q) rows = rows.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
    if (status !== 'ALL') rows = rows.filter((c) => c.status === status);
    return rows;
  }, [data, q, status]);

  if (loading) return <Spinner label="Loading clients…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3 anim-fadeUp">
        <div>
          <h1 className="font-grotesk font-bold text-2xl tracking-tight">Clients</h1>
          <p className="text-mute text-sm">{filtered.length} of {data.clients.length} shown</p>
        </div>
        <button className="btn-primary" onClick={() => setCreateOpen(true)}>+ New client</button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input className="input !w-56" placeholder="Search clients…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input !w-40" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="status">Sort: Status</option>
          <option value="name">Sort: Name</option>
          <option value="adherence">Sort: Adherence</option>
          <option value="change">Sort: Weight change</option>
        </select>
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_FILTERS.map((s) => (
            <button key={s} className={cls('chip', status === s && '!border-gold/50 !text-gold !bg-gold/10')}
              onClick={() => setStatus(s)}>{s === 'ALL' ? 'All' : STATUS_META[s].label}</button>
          ))}
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm min-w-[820px]">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">
                <th className="px-5 py-3.5">Client</th>
                <th className="px-3 py-3.5">Goal</th>
                <th className="px-3 py-3.5">Weight</th>
                <th className="px-3 py-3.5">Δ 7d</th>
                <th className="px-3 py-3.5">Adherence</th>
                <th className="px-3 py-3.5">Last workout</th>
                <th className="px-3 py-3.5">Last check-in</th>
                <th className="px-3 py-3.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-line/50 hover:bg-white/[.03] transition-colors">
                  <td className="px-5 py-3">
                    <Link to={`/app/trainer/clients/${c.id}`} className="flex items-center gap-3 group">
                      <div className="w-8 h-8 rounded-full grid place-items-center bg-gradient-to-br from-ember/30 to-gold/20 border border-line font-grotesk text-xs font-bold">
                        {c.name[0]}
                      </div>
                      <div>
                        <div className="font-grotesk font-semibold group-hover:text-gold transition-colors">{c.name}</div>
                        <div className="text-[11px] text-faint">{c.age ? `${c.age} yrs` : '—'} · {c.email}</div>
                      </div>
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-xs text-mute font-grotesk">{GOAL_LABEL[c.goal] || c.goal}</td>
                  <td className="px-3 py-3 font-grotesk font-semibold">{c.currentWeight ?? '—'} <span className="text-[10px] text-faint">/ {c.targetWeight ?? '—'} kg</span></td>
                  <td className={cls('px-3 py-3 font-grotesk text-xs', (c.change7 ?? 0) < -0.1 ? 'text-cyanx' : (c.change7 ?? 0) > 0.1 ? 'text-bad' : 'text-mute')}>
                    {c.change7 === null ? '—' : `${c.change7 > 0 ? '+' : ''}${c.change7}`}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-ember to-gold" style={{ width: `${Math.min(100, c.adherence)}%` }} />
                      </div>
                      <span className="font-grotesk text-xs">{c.adherence}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-xs text-mute font-grotesk">{c.lastWorkout || '—'}</td>
                  <td className="px-3 py-3 text-xs text-mute font-grotesk">{c.lastCheckin ? c.lastCheckin.slice(0, 10) : '—'}</td>
                  <td className="px-3 py-3"><StatusChip status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <div className="text-center py-12 text-mute text-sm">No clients match — try clearing filters.</div>
          )}
        </div>
      </Card>

      <CreateClient open={createOpen} onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); reload(); }} />
    </div>
  );
}

function CreateClient({ open, onClose, onDone }) {
  const [form, setForm] = useState({ name: '', email: '', age: '', height_cm: '', goal: 'FAT_LOSS', start_weight: '', target_weight: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api('/clients', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name, email: form.email, goal: form.goal,
          age: form.age ? Number(form.age) : undefined,
          height_cm: form.height_cm ? Number(form.height_cm) : undefined,
          start_weight: form.start_weight ? Number(form.start_weight) : undefined,
          target_weight: form.target_weight ? Number(form.target_weight) : undefined
        })
      });
      onDone();
    } catch (ex) {
      setErr(ex.message || 'Failed to create client');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a new client">
      <form onSubmit={submit} className="space-y-3">
        <input className="input" placeholder="Full name" value={form.name} onChange={set('name')} required />
        <input className="input" type="email" placeholder="Email (login)" value={form.email} onChange={set('email')} required />
        <div className="grid grid-cols-3 gap-2">
          <input className="input" type="number" placeholder="Age" value={form.age} onChange={set('age')} />
          <input className="input" type="number" placeholder="Height cm" value={form.height_cm} onChange={set('height_cm')} />
          <select className="input" value={form.goal} onChange={set('goal')}>
            {Object.entries(GOAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input className="input" type="number" placeholder="Start weight (kg)" value={form.start_weight} onChange={set('start_weight')} />
          <input className="input" type="number" placeholder="Target weight (kg)" value={form.target_weight} onChange={set('target_weight')} />
        </div>
        <div className="text-[11px] text-faint">Default password: <b>demo1234</b> — they can change it later.</div>
        {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5">{err}</div>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Creating…' : 'Create client'}</button>
      </form>
    </Modal>
  );
}
