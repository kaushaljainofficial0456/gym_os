import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, Kicker, Spinner, ErrorState, Modal, Empty, MacroPill } from '../../components/UI.jsx';

const SLOTS = ['Breakfast', 'Lunch', 'Pre-workout', 'Post-workout', 'Dinner', 'Before bed'];
const emptyMeal = () => ({ slot: 'Breakfast', name: '', time: '', calories: 400, protein: 25, carbs: 45, fat: 10, foods: '' });

export default function NutritionBuilder() {
  const plans = useFetch(() => api('/nutrition/plans'));
  const clients = useFetch(() => api('/clients?sort=name'));

  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignClient, setAssignClient] = useState('');
  const [toast, setToast] = useState('');

  const list = plans.data?.plans || [];
  const clientList = clients.data?.clients || [];

  const selected = useMemo(() => list.find((p) => p.id === selectedId) || null, [list, selectedId]);

  useEffect(() => { if (!selectedId && list.length) setSelectedId(list[0].id); }, [list, selectedId]);
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(h);
  }, [toast]);

  if (plans.loading || clients.loading) return <Spinner label="Loading nutrition builder…" />;
  if (plans.error) return <ErrorState error={plans.error} onRetry={plans.reload} />;

  const startNew = () => {
    setSelectedId(null);
    setEditing({ id: null, name: '', calories: 2550, protein: 180, carbs: 230, fat: 80, meals: [emptyMeal()] });
  };

  const openPlan = (p) => {
    setSelectedId(p.id);
    setEditing({
      id: p.id, name: p.name, calories: p.calories, protein: p.protein, carbs: p.carbs, fat: p.fat,
      meals: (p.meals || []).map((m) => ({ ...m, foods: m.foods || '' }))
    });
  };

  const patch = (k, v) => setEditing((e) => ({ ...e, [k]: v }));
  const patchMeal = (i, k, v) => setEditing((e) => {
    const meals = e.meals.map((m, j) => (j === i ? { ...m, [k]: v } : m));
    return { ...e, meals };
  });

  const savePlan = async () => {
    if (!editing?.meals?.length) return setToast('Add at least one meal');
    setSaving(true);
    try {
      await api('/nutrition/plans', { method: 'POST', body: JSON.stringify(payload()) });
      setToast('Plan saved');
      // silent: true -- this page gates its whole render on
      // `plans.loading || clients.loading` (above); a bare reload()
      // would unmount everything for the duration of the refetch, same
      // class of bug already fixed for Nutrition.jsx.
      await plans.reload({ silent: true });
      setEditing(null);
    } catch (e) { setToast(e.message); }
    setSaving(false);
  };

  const payload = () => ({
    name: editing.name || 'Untitled plan',
    calories: Number(editing.calories) || 0,
    protein: Number(editing.protein) || 0,
    carbs: Number(editing.carbs) || 0,
    fat: Number(editing.fat) || 0,
    meals: editing.meals.map((m) => ({
      slot: m.slot, name: m.name, time: m.time || undefined,
      calories: Number(m.calories) || 0, protein: Number(m.protein) || 0,
      carbs: Number(m.carbs) || 0, fat: Number(m.fat) || 0, foods: m.foods || undefined
    }))
  });

  const assign = async () => {
    if (!assignClient || !selectedId) return setToast('Pick a client and a plan');
    setSaving(true);
    try {
      await api(`/nutrition/clients/${assignClient}/plan/assign`, { method: 'POST', body: JSON.stringify({ plan_id: selectedId }) });
      setToast('Plan assigned');
      setAssignOpen(false);
    } catch (e) { setToast(e.message); }
    setSaving(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-grotesk font-bold text-2xl">Nutrition builder</h1>
          <p className="text-mute text-sm">Calorie-targeted plans with realistic Indian meals — assignable to any client.</p>
        </div>
        <button className="btn-primary" onClick={startNew}>+ New plan</button>
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-2 self-start" data-tour="trainer-nutrition-plans">
          <Kicker>Your plans</Kicker>
          <div className="space-y-1.5">
            {list.map((p) => (
              <div key={p.id} className={`rounded-xl border transition-colors ${selectedId === p.id ? 'border-gold/50 bg-white/[.05]' : 'border-line bg-white/[.02]'}`}>
                <button className="w-full text-left px-3.5 py-3 flex items-center gap-3" onClick={() => openPlan(p)}>
                  <div className="flex-1 min-w-0">
                    <div className="font-grotesk text-sm font-semibold truncate">{p.name}</div>
                    <div className="text-[11px] text-mute">{p.calories} kcal · {p.meals?.length || 0} meals</div>
                  </div>
                  <span className="text-mute">›</span>
                </button>
                <div className="px-3.5 pb-2.5">
                  <button className="btn !py-1 !px-2.5 !text-[10px]" onClick={() => { openPlan(p); setAssignOpen(true); }}>✉ Assign to client</button>
                </div>
              </div>
            ))}
            {!list.length && <Empty title="No plans yet" hint="Create a nutrition plan to assign it to clients." />}
          </div>
        </Card>

        <Card className="lg:col-span-3">
          <Kicker>{editing?.id ? 'Edit plan' : 'New plan'}</Kicker>
          {editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Plan name</label>
                  <input className="input" value={editing.name} onChange={(e) => patch('name', e.target.value)} placeholder="Cut 2550 · Non-veg Indian" />
                </div>
                {[['calories', 'Calories'], ['protein', 'Protein g'], ['carbs', 'Carbs g'], ['fat', 'Fat g']].map(([k, l]) => (
                  <div key={k}>
                    <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">{l}</label>
                    <input type="number" className="input" value={editing[k]} onChange={(e) => patch(k, e.target.value)} />
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                {editing.meals.map((m, i) => (
                  <div key={i} className="rounded-xl border border-line bg-white/[.02] p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <select className="input !py-2 w-36" value={m.slot} onChange={(e) => patchMeal(i, 'slot', e.target.value)}>
                        {SLOTS.map((s) => <option key={s}>{s}</option>)}
                      </select>
                      <input className="input !py-2 flex-1" value={m.name} onChange={(e) => patchMeal(i, 'name', e.target.value)} placeholder="e.g. 2 roti + dal + sabzi" />
                      <button className="btn !px-2 !py-1.5 !text-xs !text-bad" onClick={() => setEditing((e) => ({ ...e, meals: e.meals.filter((_, j) => j !== i) }))} aria-label="Remove">✕</button>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {[['time', 'Time'], ['calories', 'Kcal'], ['protein', 'P'], ['carbs', 'C'], ['fat', 'F']].map(([k, l]) => (
                        <label key={k} className="block">
                          <span className="text-[9px] uppercase tracking-wider text-faint font-grotesk">{l}</span>
                          <input className="input !py-1.5" value={m[k]} onChange={(e) => patchMeal(i, k, e.target.value)} />
                        </label>
                      ))}
                    </div>
                    <input className="input !py-1.5 text-xs" value={m.foods} onChange={(e) => patchMeal(i, 'foods', e.target.value)} placeholder="Foods: roti, dal, sabzi…" />
                  </div>
                ))}
                <button className="btn w-full !border-dashed" onClick={() => setEditing((e) => ({ ...e, meals: [...e.meals, emptyMeal()] }))}>+ Add meal</button>
              </div>

              <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
                <MacroPill p={editing.meals.reduce((s, m) => s + (Number(m.protein) || 0), 0)}
                  c={editing.meals.reduce((s, m) => s + (Number(m.carbs) || 0), 0)}
                  f={editing.meals.reduce((s, m) => s + (Number(m.fat) || 0), 0)} />
                <div className="flex gap-2">
                  <button className="btn-primary" onClick={savePlan} disabled={saving}>{saving ? 'Saving…' : 'Save plan'}</button>
                  <button className="btn-ghost !text-mute" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-mute text-sm">
              Select a plan on the left, or press <span className="text-gold">+ New plan</span> to build one.
            </div>
          )}
        </Card>
      </div>

      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title={`Assign "${selected?.name || editing?.name || 'plan'}"`}>
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Client</label>
            <select className="input" value={assignClient} onChange={(e) => setAssignClient(e.target.value)}>
              <option value="">Choose client…</option>
              {clientList.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.goal}</option>)}
            </select>
          </div>
          <button className="btn-primary w-full" onClick={assign} disabled={saving}>{saving ? 'Assigning…' : 'Assign plan'}</button>
        </div>
      </Modal>

      {toast && <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
    </div>
  );
}
