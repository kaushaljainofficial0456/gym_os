import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { useTheme } from '../../themeContext.jsx';
import { Spinner, ErrorState, Ring } from '../../components/UI.jsx';
import { AdherenceBreakdown } from '../../components/charts.jsx';
import Icon from '../../components/Icon.jsx';

const EQUIPMENT = [
  { id: 'barbell', label: 'Barbell' }, { id: 'dumbbells', label: 'Dumbbells' }, { id: 'cable', label: 'Cable machine' },
  { id: 'machine', label: 'Machine' }, { id: 'bench', label: 'Bench' },
  { id: 'pull_up_bar', label: 'Pull-up bar' }, { id: 'bands', label: 'Resistance bands' },
  { id: 'bodyweight', label: 'Bodyweight' }, { id: 'full_gym', label: 'Full gym' }
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

const PROFILE_SECTIONS = [
  { id: 'goal', label: 'Goal & Setup', icon: 'target', desc: 'View progress and update your goals' },
  { id: 'equipment', label: 'My Equipment', icon: 'strength', desc: 'Manage your gym equipment' },
  { id: 'metrics', label: 'My Metrics', icon: 'chart', desc: 'Track personal measurements' },
  { id: 'nutrition-tracker', label: 'Nutrition Tracker', icon: 'food', desc: 'Calendar and full logging history' },
  { id: 'coach', label: 'Coach Preference', icon: 'chat', desc: 'Coach settings and messages' },
  { id: 'dashboard', label: 'Dashboard', icon: 'clipboard', desc: 'Customize your home dashboard' },
  { id: 'help', label: 'Help', icon: '❓', desc: 'Learn how to use SK OS' },
];

function MiniSpark({ values, color = 'var(--accent)' }) {
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

function BackButton({ onClick }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2 transition-colors mb-4" style={{ color: 'var(--mute)' }}
      onMouseEnter={(e) => e.currentTarget.style.color = 'var(--ink)'}
      onMouseLeave={(e) => e.currentTarget.style.color = 'var(--mute)'}>
      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 3L5 8L10 13" />
      </svg>
      <span className="font-grotesk text-sm font-semibold">Back to Profile</span>
    </button>
  );
}

function HelpInline() {
  const [expanded, setExpanded] = useState(null);
  const HELP_SECTIONS = [
    { id: 'overview', icon: 'home', title: 'How SK OS Works', content: 'SK OS is your personal fitness operating system. It connects you with your coach, tracks your workouts, nutrition, and progress — all in one place.', items: ['Your coach designs personalized plans', 'Track daily activities — workouts, meals, sleep', 'SK OS analyzes your data and provides insights', 'Your coach gets real-time updates'] },
    { id: 'workouts', icon: 'strength', title: 'How Workouts Work', content: 'Your coach assigns structured workout plans with exercises, sets, reps, and weights.', items: ['Open a workout to see all exercises', 'Log your actual weights and reps', 'Rest timer helps track between sets', 'Complete all exercises to finish the session'] },
    { id: 'nutrition', icon: 'food', title: 'How Nutrition Works', content: 'Your nutrition plan is designed by your coach based on your goals.', items: ['View your daily meal plan', 'Mark meals as eaten when complete', 'Use Ask SK OS to quickly log foods', 'Take a meal photo for calorie estimates'] },
    { id: 'progress', icon: 'trending', title: 'Progress Tracking', content: 'Track your body transformation over time with weight, measurements, and photos.', items: ['Log weight regularly on Progress page', 'View weight trends with charts', 'Track body measurements', 'See your adherence score'] },
    { id: 'coach', icon: 'robot', title: 'Coach & Intelligence', content: 'SK OS provides intelligent coaching insights and recommendations.', items: ['Coach Brief shows daily priorities', 'Weekly reviews summarize performance', 'Ask SK OS natural language questions', 'Message your coach from Profile'] },
  ];
  return (
    <div className="space-y-3">
      <div className="font-display font-bold text-lg" style={{ color: 'var(--ink)' }}>Help</div>
      {HELP_SECTIONS.map((section) => (
        <div key={section.id} className="card overflow-hidden">
          <button onClick={() => setExpanded(expanded === section.id ? null : section.id)} className="w-full flex items-center gap-3 p-4 text-left" style={{ color: 'var(--ink)' }}>
            <span className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name={section.icon} size={20} /></span>
            <span className="flex-1 font-grotesk font-bold text-sm">{section.title}</span>
            <span className="text-lg transition-transform duration-200" style={{ color: 'var(--mute)', transform: expanded === section.id ? 'rotate(45deg)' : 'none' }}>+</span>
          </button>
          {expanded === section.id && (
            <div className="px-4 pb-4 border-t border-line/40 pt-3 anim-fadeUp">
              <p className="text-[13px] leading-relaxed mb-3" style={{ color: 'var(--mute)' }}>{section.content}</p>
              <div className="space-y-2">
                {section.items.map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className="text-gold text-xs mt-0.5 shrink-0">•</span>
                    <span className="text-[12px] leading-relaxed" style={{ color: 'var(--mute)' }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium" style={{ color: 'var(--mute)' }}>Appearance</div>
          <div className="text-sm font-grotesk mt-0.5" style={{ color: 'var(--ink)' }}>{isDark ? 'Dark Mode' : 'Light Mode'}</div>
        </div>
        <button
          onClick={toggle}
          className="relative w-12 h-6 rounded-full transition-colors duration-200"
          style={{ background: 'var(--accent-grad)' }}
          role="switch"
          aria-checked={isDark}
          aria-label="Toggle dark mode"
        >
          <span
            className="absolute top-0.5 w-5 h-5 rounded-full transition-all duration-200 shadow-sm"
            style={{
              left: isDark ? 'calc(100% - 22px)' : '2px',
              background: '#fff',
            }}
          />
        </button>
      </div>
    </div>
  );
}

export default function Profile() {
  const [activeSection, setActiveSection] = useState(null);

  // Already fetched once by the persistent ClientLayout — reuse it instead
  // of re-fetching /tracking/me/home on every mount (see ClientLayout.jsx).
  const home = useOutletContext();
  const meDash = useFetch(() => api('/me/dashboard'));
  const metrics = useFetch(() => api('/me/metrics'));
  const profile = useFetch(() => api('/me/profile'));
  const [msgs, setMsgs] = useState(null);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  // metric form
  const [mForm, setMForm] = useState({ name: '', unit: '', frequency: 'weekly', target: '', type: 'number' });
  const [mLog, setMLog] = useState({});
  const [savingM, setSavingM] = useState(false);
  const [editingM, setEditingM] = useState(null);
  // dashboard prefs
  const [order, setOrder] = useState([]);
  const [hidden, setHidden] = useState([]);
  const [savingPrefs, setSavingPrefs] = useState(false);
  // goal editor
  const [gForm, setGForm] = useState(null);
  const [savingG, setSavingG] = useState(false);
  const [toast, setToast] = useState('');
  const [localAvatar, setLocalAvatar] = useState(null);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  // coach memory/preferences
  const coachMem = useFetch(() => api('/intel/coach/memory'));
  const [coachPrefs, setCoachPrefs] = useState({});
  const [savingPrefs2, setSavingPrefs2] = useState(false);

  const data = home.data;
  const clientId = data?.client?.id;

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setToast('Only JPG, PNG, or WebP images are supported'); return; }
    if (file.size > 5 * 1024 * 1024) { setToast('Image too large (max 5 MB)'); return; }
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file);
      });
      const res = await api('/me/avatar', { method: 'POST', body: JSON.stringify({ image: b64 }) });
      setLocalAvatar(res.avatar);
      home.reload();
      setToast('Profile photo updated ✓');
    } catch (err) { setToast(err.message || 'Upload failed'); }
    e.target.value = '';
  };

  const handleRemoveAvatar = async () => {
    try {
      await api('/me/avatar', { method: 'DELETE' });
      setLocalAvatar(null);
      home.reload();
      setRemoveConfirmOpen(false);
      setToast('Profile photo removed');
    } catch (err) { setToast(err.message || 'Failed to remove photo'); }
  };

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
    if (coachMem.data?.memory) {
      const map = {};
      for (const m of coachMem.data.memory) { map[m.key] = typeof m.value === 'object' ? JSON.stringify(m.value) : String(m.value ?? ''); }
      setCoachPrefs(map);
    }
  }, [coachMem.data]);

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

  // ── Profile section renderers ──

  const renderSection = (sectionId) => {
    const goBack = () => setActiveSection(null);

    switch (sectionId) {
      case 'goal':
        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />
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
            {/* goal editor */}
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
                  <button className="btn-primary w-full" onClick={saveGoal} disabled={savingG}>{savingG ? 'Saving…' : 'Save my goal'}</button>
                </div>
              )}
            </div>
          </div>
        );

      case 'equipment':
        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />
            <div className="card p-4">
              <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-3">My Equipment</div>
              {gForm ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {EQUIPMENT.map((eq) => (
                      <button key={eq.id} onClick={() => toggleEq(eq.id)}
                        className={`chip ${gForm.equipment.includes(eq.id) ? '!border-cyanx/50 !text-cyanx bg-cyanx/10' : ''}`}>
                        {gForm.equipment.includes(eq.id) ? '✓ ' : ''}{eq.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] text-faint">Select the equipment you have access to. This helps your coach plan your workouts.</div>
                  <button className="btn-primary w-full" onClick={saveGoal} disabled={savingG}>{savingG ? 'Saving…' : 'Save equipment'}</button>
                </div>
              ) : (
                <div className="text-xs text-mute py-3 text-center">Loading equipment data…</div>
              )}
            </div>
          </div>
        );

      case 'metrics':
        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />
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
                      <MiniSpark values={vals} color={m.color || 'var(--accent)'} />
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
          </div>
        );

      case 'coach':
        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />
            {/* adherence breakdown */}
            <div className="card p-4">
              <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-3">This week</div>
              <AdherenceBreakdown components={data.adherenceComponents} />
            </div>
            {/* coach message */}
            <div className="rounded-2xl p-4" style={{ background: 'var(--accent-soft)', border: '1px solid var(--line)' }}>
              <div className="text-[10px] uppercase tracking-wider text-ember font-grotesk mb-1.5">Coach message</div>
              <p className="text-sm leading-relaxed">{data.coachMessage}</p>
            </div>
            {/* coach preferences */}
            <div className="card p-4">
              <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-3">Coach preferences</div>
              <div className="space-y-2">
                {[['training_time', 'Preferred training time', 'text'], ['workout_duration', 'Workout duration (min)', 'number'],
                  ['equipment_pref', 'Equipment preference', 'text'], ['liked_foods', 'Liked foods', 'text'],
                  ['disliked_exercises', 'Disliked exercises', 'text'], ['note', 'Note for coach', 'text']
                ].map(([key, label, type]) => (
                  <label key={key} className="block">
                    <span className="text-[10px] text-faint font-grotesk">{label.toUpperCase()}</span>
                    <input type={type} className="input mt-1" placeholder={label} value={coachPrefs[key] ?? ''}
                      onChange={(e) => setCoachPrefs((p) => ({ ...p, [key]: e.target.value }))} />
                  </label>
                ))}
              </div>
              <button className="btn-primary w-full mt-3" disabled={savingPrefs2} onClick={async () => {
                setSavingPrefs2(true);
                try {
                  const entries = Object.entries(coachPrefs)
                    .filter(([, v]) => v !== '' && v != null)
                    .map(([key, value]) => ({ key, value }));
                  await api('/intel/coach/memory', { method: 'PUT', body: JSON.stringify({ entries }) });
                  coachMem.reload();
                  setToast('Coach preferences saved');
                } catch (e) { setToast(e.message); }
                setSavingPrefs2(false);
              }}>{savingPrefs2 ? 'Saving…' : 'Save coach preferences'}</button>
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

      case 'dashboard':
        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />
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
          </div>
        );

      default:
        return null;
    }
  };

  // ── Main Profile View ──

  return (
    <div className="space-y-4">
      {toast && <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 rounded-xl border border-gold/40 px-4 py-2 text-sm shadow-card anim-fadeUp" style={{ background: 'var(--panel)', color: 'var(--ink)' }}>{toast}</div>}

      {/* Profile header — always visible */}
      <div className="card p-5 flex items-center gap-4">
        {/* Avatar with photo menu */}
        <div className="relative shrink-0">
          <button onClick={() => setAvatarMenuOpen(!avatarMenuOpen)} className="w-14 h-14 rounded-full grid place-items-center font-grotesk font-bold text-lg border transition-all hover:scale-105 active:scale-95" style={{ background: (localAvatar || c.avatar) ? 'none' : 'linear-gradient(135deg, var(--accent-soft), rgba(200,169,138,.08))', borderColor: 'var(--line)', overflow: 'hidden' }} title="Change profile photo">
            {(localAvatar || c.avatar) ? (
              <img src={localAvatar || c.avatar} alt="Profile" className="w-full h-full object-cover" />
            ) : (
              <span>{c.name[0]}</span>
            )}
          </button>
          {/* X/remove button when photo exists */}
          {(localAvatar || c.avatar) && (
            <button onClick={(e) => { e.stopPropagation(); setRemoveConfirmOpen(true); }} className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full grid place-items-center text-[8px] font-bold border transition-all hover:scale-110" style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--mute)' }} title="Remove photo">✕</button>
          )}
          {/* Photo menu */}
          {avatarMenuOpen && (
            <div className="absolute top-full left-0 mt-2 z-30 rounded-xl overflow-hidden anim-scaleIn" style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}>
              <button onClick={() => { setAvatarMenuOpen(false); document.getElementById('avatar-camera').click(); }} className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors" style={{ color: 'var(--ink)' }} onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surfaceHover)'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <span className="text-base">📷</span>
                <span className="font-grotesk text-sm font-semibold">Camera</span>
              </button>
              <button onClick={() => { setAvatarMenuOpen(false); document.getElementById('avatar-gallery').click(); }} className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors" style={{ color: 'var(--ink)' }} onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surfaceHover)'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <span className="text-base">🖼️</span>
                <span className="font-grotesk text-sm font-semibold">Gallery</span>
              </button>
              <button onClick={() => setAvatarMenuOpen(false)} className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-t" style={{ borderColor: 'var(--line)', color: 'var(--mute)' }} onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surfaceHover)'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <span className="font-grotesk text-sm font-semibold">Cancel</span>
              </button>
            </div>
          )}
        </div>
        {/* Hidden file inputs */}
        <input id="avatar-camera" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden" onChange={handleAvatarUpload} />
        <input id="avatar-gallery" type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleAvatarUpload} />
        {/* Remove photo confirmation */}
        {removeConfirmOpen && (
          <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) setRemoveConfirmOpen(false); }} style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}>
            <div className="w-full max-w-xs rounded-2xl p-5 anim-scaleIn" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
              <div className="text-center mb-4">
                <div className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>Remove profile photo?</div>
                <div className="text-[11px] mt-1" style={{ color: 'var(--mute)' }}>Your initial letter will be shown instead.</div>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setRemoveConfirmOpen(false)} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-semibold" style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--mute)' }}>Cancel</button>
                <button onClick={handleRemoveAvatar} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold" style={{ background: 'var(--bad)', color: '#fff' }}>Remove</button>
              </div>
            </div>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-display font-bold text-lg" style={{ color: 'var(--ink)' }}>{c.name}</div>
          <div className="text-xs" style={{ color: 'var(--mute)' }}>{c.goal.replace(/_/g, ' ')} · {c.currentWeight} kg now</div>
        </div>
        <Ring value={data.adherence} max={100} size={72} stroke={7} label={<span className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>{data.adherence}%</span>} sub={<span className="text-[7px]" style={{ color: 'var(--mute)' }}>adh.</span>} />
      </div>

      {/* Theme toggle */}
      <ThemeToggle />

      {/* Active section or section list */}
      {activeSection === 'help' ? (
        <div className="anim-fadeUp">
          <BackButton onClick={() => setActiveSection(null)} />
          <HelpInline />
        </div>
      ) : activeSection ? (
        renderSection(activeSection)
      ) : (
        <div className="space-y-2 anim-fadeUp">
          {PROFILE_SECTIONS.map((section) => (
            <button
              key={section.id}
              onClick={() => {
                if (section.id === 'help') { window.location.href = '/app/client/help'; return; }
                if (section.id === 'nutrition-tracker') { window.location.href = '/app/client/nutrition-tracker'; return; }
                setActiveSection(section.id);
              }}
              className="w-full card p-4 flex items-center gap-4 text-left hover:border-gold/40 transition-colors group"
            >
              <span className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name={section.icon} size={22} /></span>
              <div className="flex-1 min-w-0">
                <div className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>{section.label}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>{section.desc}</div>
              </div>
              <svg className="w-4 h-4 group-hover:text-gold transition-colors shrink-0" viewBox="0 0 16 16" fill="none" stroke="var(--faint)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 3L11 8L6 13" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
