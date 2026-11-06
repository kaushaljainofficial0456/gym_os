/**
 * NUTRITION -- meal-plan templates.
 *
 * A trainer describes each meal the way they would say it: a name, then
 * its items with quantities ("2 roti", "150 g dal", "100 g paneer"). The
 * food model (skos-food-v1, via POST /nutrition/estimate-items) works out
 * every item's calories and macros, the meal totals follow, and the plan
 * shows how it lands against its targets. Macros used to be typed by hand
 * into five unlabelled boxes per meal.
 *
 * Saved shape is unchanged: each meal stores its totals, and its items as
 * text in `foods` ("2 roti, 150 g dal"), which is also what clients see.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryAction } from '../../components/trainer/useQueryAction.js';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, ErrorState, Modal, Empty, PageSkeleton } from '../../components/UI.jsx';
import Select from '../../components/Select.jsx';
import Icon from '../../components/Icon.jsx';

const SLOTS = ['Breakfast', 'Mid-morning', 'Lunch', 'Snack', 'Pre-workout', 'Post-workout', 'Dinner', 'Before bed'];
let seq = 0;
const key = () => `k${(seq += 1)}`;
const emptyItem = () => ({ key: key(), name: '', quantity: '' });
const emptyMeal = (slot = 'Breakfast') => ({ key: key(), slot, name: '', time: '', items: [emptyItem()], legacy: null });

/* "2 roti, 150 g dal" -> rows. Older plans stored free text ("Foods: roti,
   dal"), which comes back as names without quantities. */
const QTY = /^((?:\d+(?:[.,]\d+)?|\d+\/\d+|½|¼|¾)\s*(?:x\s*)?(?:g|gm|gms|grams?|kg|ml|l|ltr|litres?|cups?|bowls?|katoris?|tbsp|tsp|pieces?|pcs?|slices?|scoops?|glass(?:es)?|plates?|servings?|nos?|small|medium|large)?\.?)\s+(.+)$/i;
function parseFoods(text) {
  const parts = String(text || '').replace(/^\s*foods?\s*:\s*/i, '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return [emptyItem()];
  return parts.map((p) => {
    const m = p.match(QTY);
    return { key: key(), name: (m ? m[2] : p).trim(), quantity: m ? m[1].trim() : '' };
  });
}
const itemKey = (it) => `${String(it.quantity || '').trim().toLowerCase()}|${String(it.name || '').trim().toLowerCase()}`;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const fmtKcal = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');

/* Estimates for every item on screen, batched and debounced: typing
   "paneer" costs one request after a pause, not six. */
function useEstimates(meals) {
  const [cache, setCache] = useState(() => new Map());
  const [pending, setPending] = useState(() => new Set());
  const inflight = useRef(new Set());
  const wanted = useMemo(() => {
    const out = new Map();
    for (const m of meals || []) for (const it of m.items) {
      if (it.ai) continue;
      if (String(it.name || '').trim().length >= 2) out.set(itemKey(it), { name: it.name.trim(), quantity: String(it.quantity || '').trim() });
    }
    return out;
  }, [meals]);

  useEffect(() => {
    const missing = [...wanted.entries()].filter(([k]) => !cache.has(k) && !inflight.current.has(k)).slice(0, 40);
    if (!missing.length) return undefined;
    setPending(new Set(missing.map(([k]) => k)));
    const h = setTimeout(async () => {
      missing.forEach(([k]) => inflight.current.add(k));
      try {
        const r = await api('/nutrition/estimate-items', { method: 'POST', body: JSON.stringify({ items: missing.map(([, v]) => v) }) });
        setCache((c) => {
          const next = new Map(c);
          missing.forEach(([k], i) => next.set(k, r.items[i]));
          return next;
        });
      } catch (e) {
        setCache((c) => {
          const next = new Map(c);
          missing.forEach(([k]) => next.set(k, { ok: false, reason: e.message || 'Could not calculate right now.', retry: true }));
          return next;
        });
      } finally {
        missing.forEach(([k]) => inflight.current.delete(k));
        setPending(new Set());
      }
    }, 450);
    return () => clearTimeout(h);
  }, [wanted, cache]);

  const forget = (k) => setCache((c) => { const next = new Map(c); next.delete(k); return next; });
  return { get: (it) => cache.get(itemKey(it)), isPending: (it) => pending.has(itemKey(it)) || inflight.current.has(itemKey(it)), busy: pending.size > 0 || inflight.current.size > 0, forget };
}

/* What an item counts as. An item added by "Describe with AI" keeps the
   AI's figure -- the AI estimator has already matched each part against
   the food database, and re-reading its wordy names through the food
   model mis-matches them. Everything a trainer types (or edits, which
   drops the AI figure) goes through the food model. */
function resolveItem(it, est) {
  if (it.ai) return { ok: true, fromAI: true, matched: 'AI estimate', grams: it.ai.grams, calories: it.ai.calories, protein: it.ai.protein, carbs: it.ai.carbs, fat: it.ai.fat };
  return est.get(it);
}

function mealTotals(meal, est) {
  const named = meal.items.filter((it) => String(it.name || '').trim());
  const resolved = named.map((it) => resolveItem(it, est));
  const results = resolved.filter((r) => r?.ok);
  const unknownNow = resolved.filter((r) => r && r.ok === false).length;
  const sum = {
    calories: results.reduce((s, r) => s + r.calories, 0),
    protein: round1(results.reduce((s, r) => s + r.protein, 0)),
    carbs: round1(results.reduce((s, r) => s + r.carbs, 0)),
    fat: round1(results.reduce((s, r) => s + r.fat, 0)),
    unknown: unknownNow,
  };
  /* A saved meal nobody has touched shows what was saved -- the figures
     the client actually sees. Opening a plan must never quietly rewrite
     them (a hand-entered old plan, or an AI item that comes back from
     storage as plain text). Editing the meal recalculates it. */
  if (!meal.dirty && meal.legacy) {
    const off = Math.abs(sum.calories - meal.legacy.calories) > Math.max(25, meal.legacy.calories * 0.05);
    return { ...meal.legacy, fromLegacy: true, differs: off || unknownNow > 0 || !results.length };
  }
  return sum;
}

function MacroLine({ t }) {
  return (
    <span className="tabular-nums">
      <b style={{ color: 'var(--ink)' }}>{fmtKcal(t.calories)} kcal</b>
      <span style={{ color: 'var(--mute)' }}> · Protein {round1(t.protein)} g · Carbs {round1(t.carbs)} g · Fat {round1(t.fat)} g</span>
    </span>
  );
}

function Target({ label, unit, planned, target }) {
  const pct = target > 0 ? Math.min(100, (planned / target) * 100) : 0;
  const over = target > 0 && planned > target * 1.05;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold" style={{ color: 'var(--mute)' }}>{label}</span>
        <span className="text-[13px] tabular-nums" style={{ color: over ? 'var(--warn)' : 'var(--mute)' }}>
          <b style={{ color: 'var(--ink)' }}>{unit === 'kcal' ? fmtKcal(planned) : round1(planned)}</b> / {unit === 'kcal' ? fmtKcal(target) : round1(target)} {unit}
        </span>
      </div>
      <div className="mt-1.5 h-2 rounded-full overflow-hidden" style={{ background: 'rgb(var(--tint-rgb) / .1)' }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: over ? 'var(--warn)' : 'var(--accent)', transition: 'width .3s ease' }} />
      </div>
    </div>
  );
}

function ItemRow({ item, result, pending, onChange: change, onRemove, onEnter, canRemove, autoFocus }) {
  // Editing an AI-suggested item drops the AI's figure: it described the
  // old line, not the new one.
  const onChange = (next) => change({ ...next, ai: undefined });
  return (
    <div className="py-2.5" style={{ borderTop: '1px solid var(--line)' }}>
      <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_120px_76px_auto] gap-2 items-center">
        <input className="input" placeholder="Food, e.g. paneer" aria-label="Food" value={item.name} autoFocus={autoFocus}
          onChange={(e) => onChange({ ...item, name: e.target.value })} />
        <button type="button" className="ws-icon-btn sm:order-last" onClick={onRemove} disabled={!canRemove} aria-label="Remove this item" title="Remove">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
        <input className="input" placeholder="Qty, e.g. 100 g" aria-label="Quantity" value={item.quantity}
          onChange={(e) => onChange({ ...item, quantity: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }} />
        <div className="text-right text-[15px] font-bold tabular-nums" style={{ color: result?.ok ? 'var(--ink)' : 'var(--faint)' }}>
          {pending ? '…' : result?.ok ? `${fmtKcal(result.calories)}` : '—'}<span className="text-[12px] font-medium" style={{ color: 'var(--faint)' }}> kcal</span>
        </div>
      </div>
      {String(item.name).trim().length >= 2 && !pending && result && (
        <div className="text-[13px] mt-1.5" style={{ color: result.ok ? 'var(--mute)' : 'var(--warn)' }}>
          {result.ok
            ? <>{result.fromAI && <Icon name="sparkle" size={13} className="inline -mt-0.5 mr-1" />}{result.matched}{result.grams ? ` · ${result.grams} g` : ''} · P {round1(result.protein)} · C {round1(result.carbs)} · F {round1(result.fat)}{result.assumed ? ' · typical portion assumed' : ''}</>
            : result.reason}
        </div>
      )}
    </div>
  );
}

export default function NutritionBuilder() {
  const plans = useFetch(() => api('/nutrition/plans'));
  const clients = useFetch(() => api('/clients?sort=name'));
  // ?new=1 (Home's "New meal plan") opens a blank plan once the page has loaded.
  useQueryAction('new', () => startNew(), !plans.loading && !clients.loading);

  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignClient, setAssignClient] = useState('');
  const [toast, setToast] = useState('');
  const [focusKey, setFocusKey] = useState(null);
  // Per meal: { open, text, busy, result, error } for "Describe with AI".
  const [aiBox, setAiBox] = useState({});
  const ai = (mk) => aiBox[mk] || {};
  const setAi = (mk, patch) => setAiBox((b) => ({ ...b, [mk]: { ...(b[mk] || {}), ...patch } }));
  const runAI = async (mk) => {
    const text = String(ai(mk).text || '').trim();
    if (text.length < 2) return;
    setAi(mk, { busy: true, error: '', result: null });
    try {
      const r = await api('/nutrition/ai-estimate', { method: 'POST', body: JSON.stringify({ text }) });
      setAi(mk, { busy: false, result: r });
    } catch (e) {
      setAi(mk, { busy: false, error: e.message || 'The AI could not estimate that just now.' });
    }
  };
  const applyAI = (mk) => {
    const r = ai(mk).result;
    if (!r?.components?.length) return;
    patchMeal(mk, (m) => ({
      ...m,
      name: String(m.name || '').trim() ? m.name : (r.food_name || m.name),
      items: [
        ...m.items.filter((it) => String(it.name || '').trim()),
        ...r.components.map((c) => ({
          key: key(), name: c.name, quantity: c.grams ? `${c.grams} g` : '',
          ai: { grams: c.grams, calories: c.calories, protein: c.protein, carbs: c.carbs, fat: c.fat },
        })),
      ],
    }));
    setAiBox((b) => ({ ...b, [mk]: {} }));
  };
  const est = useEstimates(editing?.meals);

  const list = plans.data?.plans || [];
  const clientList = clients.data?.clients || [];
  const selected = useMemo(() => list.find((p) => p.id === selectedId) || null, [list, selectedId]);

  useEffect(() => {
    if (!toast) return undefined;
    const h = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(h);
  }, [toast]);

  if (plans.loading || clients.loading) return <PageSkeleton variant="split" label="Loading nutrition" />;
  if (plans.error) return <ErrorState error={plans.error} onRetry={plans.reload} />;

  const startNew = () => {
    setSelectedId(null);
    setEditing({ id: null, name: '', calories: 2200, protein: 150, carbs: 220, fat: 70, meals: [emptyMeal('Breakfast'), emptyMeal('Lunch'), emptyMeal('Dinner')] });
  };
  const openPlan = (p) => {
    setSelectedId(p.id);
    setEditing({
      id: p.id, name: p.name, calories: p.calories, protein: p.protein, carbs: p.carbs, fat: p.fat,
      meals: (p.meals || []).map((m) => ({
        key: key(), slot: m.slot || 'Breakfast', name: m.name || '', time: m.time || '',
        items: parseFoods(m.foods),
        legacy: { calories: Number(m.calories) || 0, protein: Number(m.protein) || 0, carbs: Number(m.carbs) || 0, fat: Number(m.fat) || 0 },
      })),
    });
  };

  const patch = (k, v) => setEditing((e) => ({ ...e, [k]: v }));
  const patchMeal = (mk, fn) => setEditing((e) => ({ ...e, meals: e.meals.map((m) => (m.key === mk ? { ...fn(m), dirty: true } : m)) }));
  const addItem = (mk) => { const it = emptyItem(); setFocusKey(it.key); patchMeal(mk, (m) => ({ ...m, items: [...m.items, it] })); };

  const totals = editing ? editing.meals.map((m) => mealTotals(m, est)) : [];
  const planned = totals.reduce((s, t) => ({
    calories: s.calories + (t.calories || 0), protein: s.protein + (t.protein || 0), carbs: s.carbs + (t.carbs || 0), fat: s.fat + (t.fat || 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const unknown = totals.reduce((s, t) => s + (t.unknown || 0), 0);

  const savePlan = async () => {
    if (!String(editing.name || '').trim()) return setToast('Give the plan a name');
    if (!editing.meals.length) return setToast('Add at least one meal');
    const empty = editing.meals.findIndex((m, i) => !m.items.some((it) => String(it.name).trim()) && !totals[i].fromLegacy);
    if (empty !== -1) return setToast(`${editing.meals[empty].name || editing.meals[empty].slot} has no items yet`);
    if (est.busy) return setToast('Still calculating, one moment');
    if (saving) return;          // a second tap must not create a second plan
    setSaving(true);
    const body = {
      name: editing.name.trim(),
      calories: Number(editing.calories) || Math.round(planned.calories) || 1,
      protein: Number(editing.protein) || 0, carbs: Number(editing.carbs) || 0, fat: Number(editing.fat) || 0,
      meals: editing.meals.map((m, i) => ({
        slot: m.slot, name: String(m.name || '').trim() || m.slot, time: m.time || undefined,
        calories: Math.round(totals[i].calories || 0), protein: round1(totals[i].protein), carbs: round1(totals[i].carbs), fat: round1(totals[i].fat),
        foods: m.items.filter((it) => String(it.name).trim()).map((it) => `${String(it.quantity || '').trim()} ${it.name.trim()}`.trim()).join(', ') || undefined,
      })),
    };
    try {
      if (editing.id) {
        await api(`/nutrition/plans/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
        setToast('Plan updated');
      } else {
        const r = await api('/nutrition/plans', { method: 'POST', body: JSON.stringify(body) });
        if (r?.id) setSelectedId(r.id);
        setToast('Plan saved');
      }
      await plans.reload({ silent: true });
      setEditing(null);
    } catch (e) { setToast(e.message); }
    setSaving(false);
  };

  const assign = async () => {
    if (!assignClient || !selectedId) return setToast('Pick a client');
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
          <h1 className="t-title">Nutrition</h1>
          <p className="t-sub mt-1.5">Write the meals; we work out the calories and macros.</p>
        </div>
        <button className="btn-primary" onClick={startNew}>+ New plan</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] gap-6 items-start">
        <Card className="!p-0 overflow-hidden" data-tour="trainer-nutrition-plans">
          <div className="px-5 pt-5 pb-3"><h2 className="ws-section-title">Meal plans</h2></div>
          {list.length ? list.map((p) => (
            <button key={p.id} type="button" onClick={() => openPlan(p)}
              className="w-full text-left flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-[var(--bg2)]"
              style={{ borderTop: '1px solid var(--line)', background: selectedId === p.id ? 'rgb(var(--accent-rgb) / .1)' : undefined }}>
              <span className="ws-action-icon shrink-0" style={{ width: 38, height: 38, borderRadius: 11 }}><Icon name="plate" size={18} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{p.name}</span>
                <span className="block text-[13px] tabular-nums" style={{ color: 'var(--mute)' }}>{fmtKcal(p.calories)} kcal · {p.meals?.length || 0} meals</span>
              </span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          )) : <div className="px-5 pb-5"><Empty icon="plate" title="No meal plans yet" hint="Build one once, assign it to any client." /></div>}
        </Card>

        {editing ? (
          <div className="space-y-4">
            <Card className="p-5 sm:p-6 space-y-5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <label className="block flex-1 min-w-[220px]">
                  <span className="field-label">Plan name</span>
                  <input className="input mt-1.5 !text-[18px] !font-semibold" value={editing.name} onChange={(e) => patch('name', e.target.value)} placeholder="Fat loss · 2,200 kcal · Veg" />
                </label>
                <div className="flex gap-2 sm:mt-6">
                  {editing.id && <button type="button" className="btn" onClick={() => setAssignOpen(true)}>Assign to client</button>}
                  <button type="button" className="btn-ghost sm:hidden" style={{ color: 'var(--mute)' }} onClick={() => setEditing(null)}>Close</button>
                </div>
              </div>
              <div>
                <div className="field-label mb-1.5">Daily targets</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {[['calories', 'Calories', 'kcal'], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g']].map(([k, l, u]) => (
                    <label key={k} className="block">
                      <span className="text-[13px]" style={{ color: 'var(--mute)' }}>{l}</span>
                      <span className="relative block mt-1">
                        <input type="number" min="0" inputMode="numeric" className="input !pr-12 tabular-nums" value={editing[k]} onChange={(e) => patch(k, e.target.value)} />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[13px] pointer-events-none" style={{ color: 'var(--faint)' }}>{u}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl p-4 space-y-3" style={{ background: 'rgb(var(--tint-rgb) / .045)' }}>
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <span className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Planned so far</span>
                  <span className="text-[13px]" style={{ color: 'var(--mute)' }}>{est.busy ? 'Calculating…' : 'Estimated by the Barbell food model'}</span>
                </div>
                <Target label="Calories" unit="kcal" planned={planned.calories} target={Number(editing.calories) || 0} />
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Target label="Protein" unit="g" planned={planned.protein} target={Number(editing.protein) || 0} />
                  <Target label="Carbs" unit="g" planned={planned.carbs} target={Number(editing.carbs) || 0} />
                  <Target label="Fat" unit="g" planned={planned.fat} target={Number(editing.fat) || 0} />
                </div>
              </div>
            </Card>

            {editing.meals.map((m, i) => (
              <Card key={m.key} className="p-5 sm:p-6">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="w-[170px]">
                    <Select aria-label="Meal" value={m.slot} options={SLOTS.map((s) => ({ value: s, label: s }))} onChange={(v) => patchMeal(m.key, (x) => ({ ...x, slot: v }))} />
                  </div>
                  <input type="time" className="input !w-[130px]" aria-label="Time (optional)" value={m.time || ''} onChange={(e) => patchMeal(m.key, (x) => ({ ...x, time: e.target.value }))} />
                  <button type="button" className="ws-icon-btn ml-auto" aria-label={`Remove ${m.name || m.slot}`} title="Remove meal"
                    onClick={() => setEditing((e) => ({ ...e, meals: e.meals.filter((x) => x.key !== m.key) }))}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                  </button>
                </div>
                <input className="input mt-3 !text-[16px] !font-semibold" placeholder={`Meal name, e.g. ${m.slot === 'Breakfast' ? 'Oats and eggs' : 'Dal, roti and sabzi'}`} aria-label="Meal name"
                  value={m.name} onChange={(e) => patchMeal(m.key, (x) => ({ ...x, name: e.target.value }))} />

                <div className="mt-4">
                  <div className="hidden sm:grid grid-cols-[1fr_120px_76px_38px] gap-2 pb-1.5 text-[13px] font-semibold" style={{ color: 'var(--mute)' }}>
                    <span>Item</span><span>Quantity</span><span className="text-right">Energy</span><span />
                  </div>
                  {m.items.map((it) => (
                    <ItemRow key={it.key} item={it} result={resolveItem(it, est)} pending={est.isPending(it)} autoFocus={focusKey === it.key}
                      canRemove={m.items.length > 1}
                      onChange={(next) => patchMeal(m.key, (x) => ({ ...x, items: x.items.map((y) => (y.key === it.key ? next : y)) }))}
                      onRemove={() => patchMeal(m.key, (x) => ({ ...x, items: x.items.filter((y) => y.key !== it.key) }))}
                      onEnter={() => addItem(m.key)} />
                  ))}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <button type="button" className="btn btn-sm" onClick={() => addItem(m.key)}>+ Add item</button>
                    {!ai(m.key).open && (
                      <button type="button" className="btn btn-sm" onClick={() => setAi(m.key, { open: true })}>
                        <Icon name="sparkle" size={15} /> Describe with AI
                      </button>
                    )}
                  </div>

                  {/* "Describe it" -- the client app's AI estimate, for a
                      trainer: one sentence in, items with portions out. */}
                  {ai(m.key).open && (
                    <div className="mt-3 rounded-2xl p-4 space-y-3" style={{ background: 'var(--m-training-bg)', border: '1px solid var(--line)' }}>
                      <div className="flex items-center gap-2 text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
                        <Icon name="sparkle" size={16} style={{ color: 'var(--m-training)' }} /> Describe the meal
                      </div>
                      <div className="flex gap-2 flex-wrap sm:flex-nowrap">
                        <input className="input basis-full sm:basis-auto flex-1 min-w-0" maxLength={150} autoFocus aria-label="Describe the meal"
                          placeholder="e.g. 2 aloo parathas with curd and pickle"
                          value={ai(m.key).text || ''} onChange={(e) => setAi(m.key, { text: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runAI(m.key); } }} />
                        <button type="button" className="btn-primary shrink-0 w-full sm:w-auto" disabled={ai(m.key).busy || String(ai(m.key).text || '').trim().length < 2} onClick={() => runAI(m.key)}>
                          {ai(m.key).busy ? 'Estimating…' : 'Estimate'}
                        </button>
                      </div>
                      {ai(m.key).error && <div className="text-[13px]" role="alert" style={{ color: 'var(--warn)' }}>{ai(m.key).error}</div>}
                      {ai(m.key).result && (
                        <div className="space-y-2">
                          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
                            {ai(m.key).result.components.map((c, ci) => (
                              <div key={ci} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[14px]" style={ci ? { borderTop: '1px solid var(--line)' } : undefined}>
                                <span className="min-w-0 leading-snug" style={{ color: 'var(--ink)' }}>{c.name} <span style={{ color: 'var(--faint)' }}>· {c.grams} g</span></span>
                                <span className="tabular-nums shrink-0" style={{ color: 'var(--mute)' }}>{fmtKcal(c.calories)} kcal</span>
                              </div>
                            ))}
                          </div>
                          <div className="text-[13px]" style={{ color: 'var(--mute)' }}>
                            About {fmtKcal(ai(m.key).result.totals?.calories)} kcal. You can change any item afterwards and it is recalculated.
                          </div>
                          <div className="flex gap-2">
                            <button type="button" className="btn-primary" onClick={() => applyAI(m.key)}>Add to meal</button>
                            <button type="button" className="btn" onClick={() => setAiBox((b) => ({ ...b, [m.key]: {} }))}>Discard</button>
                          </div>
                        </div>
                      )}
                      {!ai(m.key).result && !ai(m.key).busy && (
                        <button type="button" className="text-[13px] font-semibold" style={{ color: 'var(--mute)' }} onClick={() => setAiBox((b) => ({ ...b, [m.key]: {} }))}>Cancel</button>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-4 pt-3.5 flex items-center justify-between gap-2 flex-wrap text-[14px]" style={{ borderTop: '1px solid var(--line)' }}>
                  <MacroLine t={totals[i]} />
                  {totals[i].differs && <span className="text-[13px]" style={{ color: 'var(--faint)' }}>Saved figures · edit an item to recalculate</span>}
                </div>
              </Card>
            ))}

            <button type="button" className="btn w-full !border-dashed" onClick={() => setEditing((e) => ({ ...e, meals: [...e.meals, emptyMeal(SLOTS[Math.min(SLOTS.length - 1, e.meals.length)])] }))}>
              + Add meal
            </button>

            {/* The plan's totals and its save, always within reach. */}
            <div className="sticky bottom-24 lg:bottom-4 z-10">
              <Card className="!px-4 !py-3 flex items-center justify-between gap-3" style={{ boxShadow: '0 12px 32px -12px rgb(0 0 0 / .45)' }}>
                <div className="text-[14px] min-w-0">
                  {/* A phone gets the one number that matters; the full line from sm up. */}
                  <span className="sm:hidden tabular-nums"><b style={{ color: 'var(--ink)' }}>{fmtKcal(planned.calories)} kcal</b><span style={{ color: 'var(--mute)' }}> planned</span></span>
                  <span className="hidden sm:inline"><MacroLine t={planned} /></span>
                  {unknown > 0 && <div className="text-[13px] mt-0.5 truncate" style={{ color: 'var(--warn)' }}>{unknown} item{unknown > 1 ? 's' : ''} not recognised</div>}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button className="btn hidden sm:inline-flex" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="btn-primary" onClick={savePlan} disabled={saving || est.busy}>
                    {saving ? 'Saving…' : est.busy ? 'Calculating…' : editing.id ? 'Save changes' : 'Save plan'}
                  </button>
                </div>
              </Card>
            </div>
          </div>
        ) : (
          <Card>
            <Empty icon="plate" title={selected ? selected.name : 'Pick a meal plan'}
              hint={selected ? `${fmtKcal(selected.calories)} kcal · ${selected.meals?.length || 0} meals` : 'Choose one from the list to edit it, or start fresh.'}
              action={selected
                ? <div className="flex gap-2 justify-center flex-wrap"><button className="btn-primary" onClick={() => openPlan(selected)}>Edit plan</button><button className="btn" onClick={() => setAssignOpen(true)}>Assign to client</button></div>
                : <button className="btn-primary" onClick={startNew}>+ New plan</button>} />
          </Card>
        )}
      </div>

      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title={`Assign "${selected?.name || editing?.name || 'plan'}"`}>
        <div className="space-y-4">
          <div>
            <label className="field-label block mb-1.5" id="assign-client-label">Client</label>
            {/* A client list that failed to load is not a gym with no clients. */}
            {clients.error ? <ErrorState error={clients.error} onRetry={clients.reload} /> : (
              <Select aria-labelledby="assign-client-label" value={assignClient} onChange={setAssignClient} placeholder="Choose a client"
                options={clientList.map((c) => ({ value: c.id, label: c.name, hint: String(c.goal || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase()) }))} />
            )}
          </div>
          <button className="btn-primary w-full" onClick={assign} disabled={saving || !assignClient}>{saving ? 'Assigning…' : 'Assign plan'}</button>
        </div>
      </Modal>

      {toast && <div className="toast anim-toast">{toast}</div>}
    </div>
  );
}
