import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Spinner, ErrorState, Ring } from '../../components/UI.jsx';
import { AdherenceBreakdown } from '../../components/charts.jsx';

const EQUIPMENT = [
  { id: 'barbell', label: 'Barbell' },
  { id: 'dumbbells', label: 'Dumbbells' },
  { id: 'cable', label: 'Cable machine' },
  { id: 'machine', label: 'Machine' },
  { id: 'bench', label: 'Bench' },
  { id: 'pull_up_bar', label: 'Pull-up bar' },
  { id: 'bands', label: 'Resistance bands' },
  { id: 'bodyweight', label: 'Bodyweight' },
  { id: 'full_gym', label: 'Full gym' }
];
const GOALS = [
  ['FAT_LOSS', 'Fat loss'], ['MUSCLE_GAIN', 'Muscle gain'], ['RECOMP', 'Recomposition'],
  ['STRENGTH', 'Strength'], ['GENERAL', 'General fitness']
];
const EXP = [['BEGINNER', 'Beginner'], ['INTERMEDIATE', 'Intermediate'], ['ADVANCED', 'Advanced']];

const DASH_CARDS = [
  ['workout', "Today's workout"], ['fuel', 'Calories & macros'], ['water', 'Water'],
  ['sleep', 'Sleep'], ['coach', 'SK Coach'], ['adherence', 'Adherence'], ['goal', 'My goal'], ['crowd', 'Gym crowd']
];

function MiniSpark({ values, color = '#FF6A3D' }) {
  if (!values?.length) return <div className="text-[10px] text-faint">No entries yet</div>;
  const pts = values.slice(-8).map((v, i, a) => {
    const min = Math.min(...a), max = Math.max(...a);
    const x = (i / Math.max(1, a.length - 1)) * 80 + 6;
    const y = 26 - ((v - min) / (max - min || 1)) * 20 - 3;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg viewBox="0 0 92 30" className="w-full h-8">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Profile() {
  const home = useFetch(() => api('/tracking/me/home'));
  const meDash = useFetch(() => api('/me/dashboard'));
  const metrics = useFetch(() => api('/me/metrics'));
  const profile = useFetch(() => api('/me/profile'));
  const [msgs, setMsgs] = useState(null);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  // metric form
  const [mForm, setMForm] = useState({ name: '', unit: '', frequency: 'weekly', target: '', type: 'number' });
  const [mLog, setMLog] = useState({});   // metricId -> { value, date }
  const [savingM, setSavingM] = useState(false);
  const [editingM, setEditingM] = useState(null); // { id, name, unit, frequency, target, type }
  const [editingLog, setEditingLog] = useState(null); // { metricId, entryId }
  // dashboard prefs
  const [order, setOrder] = useState([]);
  const [hidden, setHidden] = useState([]);
  const [savingPrefs, setSavingPrefs] = useState(false);
  // goal editor
  const [gForm, setGForm] = useState(null);
  const [savingG, setSavingG] = useState(false);
  const [toast, setToast] = useState('');

  const data = home.data;
  const clientId = data?.client?.id;

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(h);
  }, [toast]);

  useEffect(() => {
    if (meDash.data?.prefs) {
      try { setOrder(JSON.parse(meDash.data.prefs.order_list || '[]')); } catch { setOrder(DASH_CARDS.map(c => c[0])); }
      try { setHidden(JSON.parse(meDash.data.prefs.hidden || '[]')); } catch { setHidden([]); }
    }
  }, [meDash.data]);

  useEffect(() => {
    if (profile.data?.client) {
      const c = profile.data.client, p = profile.data.profile || {};
      let eq = [];
      try { eq = p.equipment ? JSON.parse(p.equipment) : (c.equipment ? JSON.parse(c.equipment) : []); } catch { eq = []; }
      setGForm({ goal: c.goal, targetWeight: c.target_weight, goalDate: c.goal_date || '', experience: p.experience || 'INTERMEDIATE', equipment: eq });
    }
  }, [profile.data]);

  useEffect(() => {
    if (clientId) {
      api(`/messages?client_id=${clientId}`).then((r) => setMsgs(r.messages || [])).catch(() => {});
    }
  }, [clientId]);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  if (home.loading || meDash.loading) return <Spinner label="Loading your profile…" />;
  if (home.error) return <ErrorState error={home.error} onRetry={home.reload} />;

  const c = data.client;
  const total = c.startWeight - c.targetWeight;
  const progress = total > 0 ? Math.min(100, Math.max(0, ((c.startWeight - c.currentWeight) / total) * 100)) : 0;

  const send = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      const res = await api('/messages', { method: 'POST', body: JSON.stringify({ client_id: clientId, type: 'message', body }) });
      setMsgs((m) => [...(m || []), { id: res.id, body, from_name: c.name, type: 'message', created_at: new Date().toISOString(), mine: true }]);
      setBody('');
    } catch { /* keep body */ }
    setSending(false);
  };

  const createMetric = async () => {
    if (!mForm.name.trim()) return;
    setSavingM(true);
    try {
      await api('/me/metrics', { method: 'POST', body: JSON.stringify({ ...mForm, target: mForm.target === '' ? null : Number(mForm.target) }) });
      setMForm({ name: '', unit: '', frequency: 'weekly', target: '', type: 'number' });
      metrics.reload();
      setToast('Metric created');
    } catch (e) { setToast(e.message); }
    setSavingM(false);
  };

  const saveMetricEdit = async () => {
    if (!editingM?.name?.trim()) return;
    setSavingM(true);
    try {
      await api(`/me/metrics/${editingM.id}`, { method: 'PUT', body: JSON.stringify({
        name: editingM.name, unit: editingM.unit, frequency: editingM.frequency,
        target: editingM.target === '' ? null : Number(editingM.target), type: editingM.type
      }) });
      setEditingM(null);
      metrics.reload();
      setToast('Metric updated');
    } catch (e) { setToast(e.message); }
    setSavingM(false);
  };

  const logBoolean = async (mId, val) => {
    setSavingM(true);
    try {
      await api(`/me/metrics/${mId}/entries`, { method: 'POST', body: JSON.stringify({ value: val ? 1 : 0 }) });
      metrics.reload();
      setToast(val ? 'Done ✓' : 'Logged');
    } catch (e) { setToast(e.message); }
    setSavingM(false);
  };

  const deleteEntry = async (mId, eId) => {
    try {
      await api(`/me/metrics/${mId}/entries/${eId}`, { method: 'DELETE' });
      metrics.reload();
      setToast('Entry removed');
    } catch (e) { setToast(e.message); }
  };

  const logEntry = async (mId) => {
    const v = Number(mLog[mId]?.value);
    if (Number.isNaN(v)) return;
    setSavingM(true);
    try {
      await api(`/me/metrics/${mId}/entries`, { method: 'POST', body: JSON.stringify({ value: v, date: mLog[mId]?.date || undefined }) });
      setMLog((x) => ({ ...x, [mId]: {} }));
      metrics.reload();
      setToast('Logged');
    } catch (e) { setToast(e.message); }
    setSavingM(false);
  };

  const deleteMetric = async (mId) => {
    await api(`/me/metrics/${mId}`, { method: 'DELETE' }).then(() => { metrics.reload(); }).catch((e) => setToast(e.message));
  };

  const savePrefs = async () => {
    setSavingPrefs(true);
    try {
      await api('/me/dashboard', { method: 'PUT', body: JSON.stringify({ order, hidden }) });
      setToast('Dashboard saved');
    } catch (e) { setToast(e.message); }
    setSavingPrefs(false);
  };

  const move = (key, dir) => {
    setOrder((o) => {
      const i = o.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= o.length) return o;
      const n = [...o]; [n[i], n[j]] = [n[j], n[i]]; return n;
    });
  };

  const saveGoal = async () => {
    if (!gForm) return;
    setSavingG(true);
    try {
      await api('/me/profile', { method: 'PUT', body: JSON.stringify({
        goal: gForm.goal, target_weight: Number(gForm.targetWeight) || null,
        goal_date: gForm.goalDate || null, experience: gForm.experience, equipment: gForm.equipment
      }) });
      home.reload();
      setToast('Goal updated');
    } catch (e) { setToast(e.message); }
    setSavingG(false);
  };

  const toggleEq = (id) => {
    setGForm((f) => {
      const eq = f.equipment.includes(id) ? f.equipment.filter((x) => x !== id) : [...f.equipment, id];
      return { ...f, equipment: eq };
    });
  };

  const visibleCards = (order.length ? order : DASH_CARDS.map((x) => x[0])).filter((k) => !hidden.includes(k));

  return (
    <div className="space-y-4">
      {toast && <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 rounded-xl border border-gold/40 bg-panel px-4 py-2 text-sm shadow-card anim-fadeUp">{toast}</div>}

      {/* header */}
      <div className="card p-5 flex items-center gap-4">
        <div className="w-14 h-14 rounded-full grid place-items-center font-grotesk font-bold text-lg bg-gradient-to-br from-ember/40 to-gold/25 border border-line shrink-0">
          {c.name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-grotesk font-bold text-lg">{c.name}</div>
          <div className="text-xs text-mute">{c.goal.replace(/_/g, ' ')} · {c.currentWeight} kg now</div>
        </div>
        <Ring value={data.adherence} max={100} size={72} stroke={7} label={<span className="font-grotesk font-bold text-sm">{data.adherence}%</span>} sub={<span className="text-[7px]">adh.</span>} />
      </div>

      {/* goal progress */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">Goal progress</div>
          <div className="font-grotesk text-xs font-bold text-gold">{Math.round(progress)}%</div>
        </div>
        <div className="h-2 rounded-full bg-white/8 overflow-hidden mb-2">
          <div className="h-full rounded-full bg-gradient-to-r from-ember to-gold transition-all duration-700" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex justify-between text-[11px] text-mute font-grotesk">
          <span>Start {c.startWeight} kg</span>
          <span>Now {c.currentWeight} kg</span>
          <span>Target {c.targetWeight} kg · {c.goalDate?.slice(0, 10) || '—'}</span>
        </div>
      </div>

      {/* my goal — client self-edit */}
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-3">My goal & setup</div>
        {gForm && (
          <div className="space-y-3">
            <div>
              <div className="text-[10px] text-faint mb-1.5 font-grotesk">PRIMARY GOAL</div>
              <div className="flex flex-wrap gap-1.5">
                {GOALS.map(([v, l]) => (
                  <button key={v} onClick={() => setGForm((f) => ({ ...f, goal: v }))}
                    className={`chip ${gForm.goal === v ? '!border-gold/50 !text-gold bg-gold/10' : ''}`}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-faint mb-1.5 font-grotesk">EXPERIENCE</div>
              <div className="flex flex-wrap gap-1.5">
                {EXP.map(([v, l]) => (
                  <button key={v} onClick={() => setGForm((f) => ({ ...f, experience: v }))}
                    className={`chip ${gForm.experience === v ? '!border-gold/50 !text-gold bg-gold/10' : ''}`}>{l}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] text-faint font-grotesk">TARGET WEIGHT (KG)</span>
                <input type="number" className="input mt-1" value={gForm.targetWeight ?? ''} onChange={(e) => setGForm((f) => ({ ...f, targetWeight: e.target.value }))} />
              </label>
              <label className="block">
                <span className="text-[10px] text-faint font-grotesk">TARGET DATE</span>
                <input type="date" className="input mt-1" value={gForm.goalDate || ''} onChange={(e) => setGForm((f) => ({ ...f, goalDate: e.target.value }))} />
              </label>
            </div>
            <div>
              <div className="text-[10px] text-faint mb-1.5 font-grotesk">MY EQUIPMENT</div>
              <div className="flex flex-wrap gap-1.5">
                {EQUIPMENT.map((e) => (
                  <button key={e.id} onClick={() => toggleEq(e.id)}
                    className={`chip ${gForm.equipment.includes(e.id) ? '!border-cyanx/50 !text-cyanx bg-cyanx/10' : ''}`}>
                    {gForm.equipment.includes(e.id) ? '✓ ' : ''}{e.label}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn-primary w-full" onClick={saveGoal} disabled={savingG}>{savingG ? 'Saving…' : 'Save my goal'}</button>
          </div>
        )}
      </div>

      {/* my metrics */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">My metrics</div>
          <span className="text-[10px] text-faint font-grotesk">track what matters to you</span>
        </div>
        {/* create form */}
        <div className="rounded-xl border border-line bg-white/[.03] p-3 space-y-2 mt-2">
          <div className="grid grid-cols-2 gap-2">
            <input className="input" placeholder="Metric name (e.g. Waist, Steps, Bench)" value={mForm.name} onChange={(e) => setMForm((f) => ({ ...f, name: e.target.value }))} />
            <input className="input" placeholder="Unit (cm, kg, steps…)" value={mForm.unit} onChange={(e) => setMForm((f) => ({ ...f, unit: e.target.value }))} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <select className="input" value={mForm.type} onChange={(e) => setMForm((f) => ({ ...f, type: e.target.value }))}>
              <option value="number">Number</option><option value="count">Count</option><option value="duration">Duration (h)</option><option value="boolean">Yes / No</option>
            </select>
            <select className="input" value={mForm.frequency} onChange={(e) => setMForm((f) => ({ ...f, frequency: e.target.value }))}>
              <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select>
            <input className="input" placeholder="Target (optional)" type="number" value={mForm.target} onChange={(e) => setMForm((f) => ({ ...f, target: e.target.value }))} />
          </div>
          <button className="btn-primary w-full" onClick={createMetric} disabled={savingM || !mForm.name.trim()}>Add tracking metric</button>
        </div>
        {/* edit metric form */}
        {editingM && (
          <div className="rounded-xl border border-gold/30 bg-gold/5 p-3 space-y-2 mt-2">
            <div className="text-[10px] text-gold font-grotesk uppercase tracking-wider">EDIT METRIC</div>
            <div className="grid grid-cols-2 gap-2">
              <input className="input" value={editingM.name} onChange={(e) => setEditingM((f) => ({ ...f, name: e.target.value }))} />
              <input className="input" placeholder="Unit" value={editingM.unit || ''} onChange={(e) => setEditingM((f) => ({ ...f, unit: e.target.value }))} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <select className="input" value={editingM.type} onChange={(e) => setEditingM((f) => ({ ...f, type: e.target.value }))}>
                <option value="number">Number</option><option value="count">Count</option><option value="duration">Duration (h)</option><option value="boolean">Yes / No</option>
              </select>
              <select className="input" value={editingM.frequency} onChange={(e) => setEditingM((f) => ({ ...f, frequency: e.target.value }))}>
                <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
              </select>
              <input className="input" placeholder="Target" type="number" value={editingM.target ?? ''} onChange={(e) => setEditingM((f) => ({ ...f, target: e.target.value }))} />
            </div>
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={() => setEditingM(null)}>Cancel</button>
              <button className="btn-primary flex-1" onClick={saveMetricEdit} disabled={savingM}>Save</button>
            </div>
          </div>
        )}
        {/* metric list */}
        <div className="space-y-2 mt-3">
          {(metrics.data?.metrics || []).map((m) => {
            const vals = (m.entries || []).map((e) => e.value).reverse();
            return (
              <div key={m.id} className="rounded-xl border border-line bg-white/[.03] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="font-grotesk text-sm font-bold">{m.name}</span>
                    {m.unit && <span className="text-[10px] text-mute font-grotesk"> ({m.unit})</span>}
                    {m.target != null && <span className="text-[10px] text-faint font-grotesk"> · target {m.target}</span>}
                    {m.latest && <span className="block text-[11px] text-gold font-grotesk">latest {m.latest.value} {m.unit || ''} · {m.latest.date}</span>}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button className="text-[10px] text-mute hover:text-ink" onClick={() => setEditingM({ id: m.id, name: m.name, unit: m.unit || '', frequency: m.frequency, target: m.target ?? '', type: m.type || 'number' })} aria-label={`Edit ${m.name}`}>Edit</button>
                    <button className="text-[10px] text-bad/80 hover:text-bad" onClick={() => deleteMetric(m.id)} aria-label={`Delete ${m.name}`}>✕</button>
                  </div>
                </div>
                <MiniSpark values={vals} color={m.color || '#FF6A3D'} />
                {/* recent entries with delete */}
                {(m.entries || []).slice(0, 4).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {(m.entries || []).slice(0, 4).map((e) => (
                      <span key={e.id} className="inline-flex items-center gap-1 chip border-line !px-2 !py-0.5 text-[10px]">
                        {m.type === 'boolean' ? (e.value ? '✓ done' : '✗ no') : `${e.value}${m.unit ? ' ' + m.unit : ''}`} · {e.date}
                        <button className="text-faint hover:text-bad" onClick={() => deleteEntry(m.id, e.id)} aria-label={`Delete entry ${e.date}`}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
                {m.type === 'boolean' ? (
                  <div className="flex gap-2 mt-1.5">
                    <button className="btn !py-1.5 !px-3 !text-[11px] flex-1" onClick={() => logBoolean(m.id, true)} disabled={savingM}>✓ Yes</button>
                    <button className="btn !py-1.5 !px-3 !text-[11px] flex-1" onClick={() => logBoolean(m.id, false)} disabled={savingM}>✗ No</button>
                  </div>
                ) : (
                  <div className="flex gap-2 mt-1.5">
                    <input type="number" step="any" className="input !py-1.5 !text-xs flex-1" placeholder={`Value (${m.unit || '…'})`}
                      value={mLog[m.id]?.value ?? ''} onChange={(e) => setMLog((x) => ({ ...x, [m.id]: { ...x[m.id], value: e.target.value } }))} />
                    <input type="date" className="input !py-1.5 !text-xs" value={mLog[m.id]?.date || ''}
                      onChange={(e) => setMLog((x) => ({ ...x, [m.id]: { ...x[m.id], date: e.target.value } }))} />
                    <button className="btn !py-1.5 !px-3 !text-[11px] shrink-0" onClick={() => logEntry(m.id)} disabled={savingM}>Log</button>
                  </div>
                )}
              </div>
            );
          })}
          {!metrics.data?.metrics?.length && <div className="text-center text-xs text-mute py-3">No personal metrics yet — create your first one above (e.g. waist, steps, bench press).</div>}
        </div>
      </div>

      {/* my dashboard */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">My dashboard</div>
          <span className="text-[10px] text-faint font-grotesk">show · hide · reorder</span>
        </div>
        <div className="space-y-1.5">
          {(order.length ? order : DASH_CARDS.map((x) => x[0])).map((key) => {
            const label = DASH_CARDS.find((d) => d[0] === key)?.[1] || key;
            const isHidden = hidden.includes(key);
            return (
              <div key={key} className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${isHidden ? 'border-line opacity-45' : 'border-line bg-white/[.03]'}`}>
                <button className="text-faint hover:text-ink text-sm w-5" onClick={() => move(key, -1)} aria-label={`Move ${label} up`}>↑</button>
                <button className="text-faint hover:text-ink text-sm w-5" onClick={() => move(key, 1)} aria-label={`Move ${label} down`}>↓</button>
                <span className="flex-1 text-sm">{label}</span>
                <button
                  onClick={() => setHidden((h) => (isHidden ? h.filter((x) => x !== key) : [...h, key]))}
                  className={`chip !text-[10px] ${isHidden ? '!border-good/40 !text-good' : '!border-line text-mute'}`}>
                  {isHidden ? 'Show' : 'Hide'}
                </button>
              </div>
            );
          })}
        </div>
        <div className="text-[10px] text-faint mt-2">Currently showing: {visibleCards.join(' · ').replace(/_/g, ' ')}</div>
        <button className="btn-primary w-full mt-2" onClick={savePrefs} disabled={savingPrefs}>{savingPrefs ? 'Saving…' : 'Save dashboard layout'}</button>
      </div>

      {/* adherence breakdown */}
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-3">This week</div>
        <AdherenceBreakdown components={data.adherenceComponents} />
      </div>

      {/* coach message */}
      <div className="rounded-2xl p-4" style={{ background: 'linear-gradient(150deg, rgba(255,106,61,.12), rgba(255,194,75,.05))', border: '1px solid rgba(255,106,61,.3)' }}>
        <div className="text-[10px] uppercase tracking-wider text-ember font-grotesk mb-1.5">Coach message</div>
        <p className="text-sm leading-relaxed">{data.coachMessage}</p>
      </div>

      {/* messages */}
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-3">Message your coach</div>
        <div className="h-44 overflow-y-auto space-y-2 pr-1 mb-3">
          {(msgs || []).map((m) => {
            const mine = m.from_name === c.name || m.mine;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-[13px] ${mine ? 'bg-gradient-to-br from-ember/25 to-gold/15 border border-gold/30 rounded-br-md' : 'bg-white/[.05] border border-line rounded-bl-md'}`}>
                  {!mine && <div className="text-[9px] text-mute font-grotesk mb-0.5">{m.from_name}</div>}
                  <div>{m.body}</div>
                  <div className="text-[8px] text-faint mt-1 font-grotesk">{new Date(m.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
              </div>
            );
          })}
          {!msgs?.length && <div className="text-center text-xs text-mute py-6">No messages yet — say hi to your coach.</div>}
          <div ref={endRef} />
        </div>
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="Type a message…" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
          <button className="btn-primary shrink-0" onClick={send} disabled={sending || !body.trim()}>Send</button>
        </div>
      </div>
    </div>
  );
}
