import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import FoodLogSheet from '../../components/FoodLogSheet.jsx';
import { useFetch } from '../../utils.js';
import { Spinner, ErrorState, Ring, Bar } from '../../components/UI.jsx';

export default function Nutrition() {
  const home = useFetch(() => api('/tracking/me/home'));
  const [meals, setMeals] = useState(null);
  const [water, setWater] = useState(null);
  const [supTaken, setSupTaken] = useState({});
  const [aiText, setAiText] = useState('');
  const [aiResult, setAiResult] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [logging, setLogging] = useState(false);
  const [toast, setToast] = useState('');
  const [supList, setSupList] = useState(null);
  const foods = useFetch(() => api('/me/foods'));
  const myMeals = useFetch(() => api('/me/meals'));
  const [foodForm, setFoodForm] = useState({ name: '', unit: '', serving: '', calories: '', protein: '', carbs: '', fat: '' });
  const [mealForm, setMealForm] = useState({ slot: 'Meal', name: '', time: '', calories: '', protein: '', carbs: '', fat: '', foods: '' });
  const [saving, setSaving] = useState(false);
  const [openSection, setOpenSection] = useState(null); // 'foods' | 'meals'
  const [supForm, setSupForm] = useState({ name: '', dose: '', schedule_time: '' });
  const [savingSup, setSavingSup] = useState(false);
  // meal composer — build a meal from foods with quantities
  const [composing, setComposing] = useState(null); // meal object being composed
  const [items, setItems] = useState([]);
  const [foodSearch, setFoodSearch] = useState('');
  const [foodQty, setFoodQty] = useState(1);
  // Server-side search results. The picker used to filter a CLIENT-SIDE
  // array built from /me/foods, which is capped at 100 gym + 200 global
  // rows -- so ordinary foods (maggi, avocado, oreo) were simply not in it
  // and the miss rendered as 0 kcal. Search now runs against the
  // 21,353-food catalogue on the server.
  const [foodResults, setFoodResults] = useState([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [chosenFood, setChosenFood] = useState(null);

  const data = home.data;
  const clientId = data?.client?.id;

  useEffect(() => {
    if (clientId) api(`/tracking/clients/${clientId}/supplements`).then((r) => setSupList(r.supplements || [])).catch(() => {});
  }, [clientId]);
  const plan = data?.nutrition?.plan;
  const mealState = meals || data?.nutrition?.meals || [];
  const waterState = water ?? (data ? data.water.litres : 0);

  const eaten = mealState.filter((m) => m.eaten).reduce((s, m) => ({
    calories: s.calories + m.calories, protein: s.protein + m.protein,
    carbs: s.carbs + m.carbs, fat: s.fat + m.fat
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(h);
  }, [toast]);

  /* MUST sit above the early returns below. Hooks have to run in the same
     order on every render; this effect was originally placed further down,
     next to the code that uses it, which put it AFTER
     `if (home.loading) return ...`. The first render (loading) then ran
     fewer hooks than the second (loaded), and React aborted the whole page
     with "Rendered more hooks than during the previous render" -- the
     Nutrition screen rendered completely blank. */
  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const q = foodSearch.trim();
    if (q.length < 2) { setFoodResults([]); setSearching(false); return undefined; }
    setSearching(true);
    let cancelled = false;
    const h = setTimeout(() => {
      api(`/me/foods/search?q=${encodeURIComponent(q)}`)
        .then((r) => { if (!cancelled) setFoodResults(r.foods || []); })
        .catch(() => { if (!cancelled) setFoodResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(h); };
  }, [foodSearch]);

  if (home.loading) return <Spinner label="Loading your fuel plan…" />;
  if (home.error) return <ErrorState error={home.error} onRetry={home.reload} />;

  const toggleMeal = async (m) => {
    const next = !m.eaten;
    setMeals(mealState.map((x) => (x.id === m.id ? { ...x, eaten: next } : x)));
    await api(`/nutrition/clients/${clientId}/meals/toggle`, { method: 'POST', body: JSON.stringify({ meal_id: m.id, eaten: next }) }).catch(() => home.reload());
  };

  const addWater = async (litres = 0.25) => {
    const next = Math.min(data.water.target, Math.round((waterState + litres) * 100) / 100);
    setWater(next);
    await api(`/tracking/clients/${clientId}/water`, { method: 'POST', body: JSON.stringify({ litres: next }) }).catch(() => home.reload());
  };

  const estimate = async () => {
    if (!aiText.trim()) return;
    setEstimating(true);
    try {
      const res = await api(`/nutrition/clients/${clientId}/meals/ai-estimate`, { method: 'POST', body: JSON.stringify({ text: aiText }) });
      setAiResult(res);
    } catch (e) { setToast(e.message); }
    setEstimating(false);
  };

  const logAi = async () => {
    if (!aiResult) return;
    setLogging(true);
    try {
      await api(`/nutrition/clients/${clientId}/meals/log`, {
        method: 'POST',
        body: JSON.stringify({
          name: aiText.slice(0, 100), slot: 'Snack',
          calories: aiResult.total.calories, protein: aiResult.total.protein,
          carbs: aiResult.total.carbs, fat: aiResult.total.fat,
          source: 'ai', estimate: true, eaten: true
        })
      });
      setToast('Meal logged (AI estimate)');
      setAiText(''); setAiResult(null);
      home.reload();
    } catch (e) { setToast(e.message); }
    setLogging(false);
  };

  const supplements = [];

  const openComposer = async (m) => {
    setComposing(m); setFoodSearch(''); setFoodQty(1); setChosenFood(null);
    try { const r = await api(`/me/meals/${m.id}/items`); setItems(r.items || []); }
    catch (e) { setToast(e.message || 'Could not open meal'); }
  };

  const reloadItems = async () => {
    try { const r = await api(`/me/meals/${composing.id}/items`); setItems(r.items || []); myMeals.reload(); }
    catch (e) { setToast(e.message); }
  };

  const setItemQty = async (it, q) => {
    const n = Number(q);
    if (!n || n <= 0) return;
    try {
      await api(`/me/meals/${composing.id}/items/${it.id}`, { method: 'PUT', body: JSON.stringify({ quantity: n }) });
      await reloadItems();
    } catch (e) { setToast(e.message); }
  };

  const addItem = async (f) => {
    try {
      // A catalogue result has no `id` yet -- it is not a row. Materialise
      // it first so meal_items.food_id keeps pointing at something real.
      let foodId = f.id;
      if (!foodId) {
        const r = await api('/me/foods/from-model', {
          method: 'POST',
          body: JSON.stringify({ source_id: f.source_id, name: f.name }),
        });
        foodId = r.food?.id;
        if (!foodId) throw new Error('Could not add that food');
        foods.reload();
      }
      await api(`/me/meals/${composing.id}/items`, { method: 'POST', body: JSON.stringify({ food_id: foodId, quantity: Number(foodQty) || 1 }) });
      setChosenFood(null); setFoodQty(1); setFoodSearch('');
      await reloadItems();
      setToast(`${f.name} added`);
    } catch (e) { setToast(e.message); }
  };

  const allFoods = [
    ...(foods.data?.mine || []).map((f) => ({ ...f, scope: 'MY FOOD' })),
    ...(foods.data?.gym || []).map((f) => ({ ...f, scope: 'GYM' })),
    ...(foods.data?.global || []).map((f) => ({ ...f, scope: 'GLOBAL' }))
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-grotesk font-bold text-xl">Today's fuel</h1>
        <div className="text-xs text-mute mt-0.5">{plan ? `${plan.calories} kcal · P${plan.protein} / C${plan.carbs} / F${plan.fat}` : 'No plan assigned'}</div>
      </div>

      {/* live ring + macros */}
      <div className="card p-4">
        <div className="flex items-center gap-4">
          <Ring value={eaten.calories} max={plan?.calories || 1} size={116} stroke={10}
            label={<span className="font-grotesk font-bold text-base">{eaten.calories}</span>}
            sub={<span className="text-[8px] text-mute">kcal</span>} />
          <div className="flex-1 space-y-2.5">
            <Bar label="Protein" value={eaten.protein} max={plan?.protein || 1} color="linear-gradient(92deg,#8C6A4D,#A07855)" right={`${eaten.protein}/${plan?.protein || 0} g`} height="h-1.5" />
            <Bar label="Carbs" value={eaten.carbs} max={plan?.carbs || 1} color="linear-gradient(92deg,#A07855,#C4A882)" right={`${eaten.carbs}/${plan?.carbs || 0} g`} height="h-1.5" />
            <Bar label="Fat" value={eaten.fat} max={plan?.fat || 1} color="linear-gradient(92deg,#C4A882,#D4C4B0)" right={`${eaten.fat}/${plan?.fat || 0} g`} height="h-1.5" />
          </div>
        </div>
      </div>

      {/* meals — trainer/gym plan + client's own templates */}
      <div className="space-y-2">
        {mealState.map((m) => (
          <button key={m.id} onClick={() => toggleMeal(m)}
            className={`w-full card p-3.5 flex items-center gap-3 text-left transition-colors ${m.eaten ? 'border-gold/40' : ''}`}>
            <span className={`w-6 h-6 rounded-lg border grid place-items-center text-xs shrink-0 transition-all ${m.eaten ? 'bg-gradient-to-br from-ember to-gold text-bg border-transparent shadow shadow-ember/30 anim-pop' : 'border-line text-faint'}`}>{m.eaten ? '✓' : ''}</span>
            <span className="flex-1 min-w-0">
              <span className="block font-grotesk text-sm font-semibold">{m.name}</span>
              <span className="text-[10px] text-mute">{m.slot}{m.time ? ` · ${m.time}` : ''} · {m.calories} kcal · P{m.protein} C{m.carbs} F{m.fat}</span>
              {m.foods && <span className="block text-[10px] text-faint mt-0.5 truncate">{m.foods}</span>}
            </span>
          </button>
        ))}
        {!mealState.length && <div className="card p-6 text-center text-sm text-mute">No meals logged yet.</div>}
      </div>

      {/* customize — my foods & my meals (progressive disclosure) */}
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-1">Customize your nutrition</div>
        <p className="text-[11px] text-faint mb-3">Build your own meal structure and food list — plan or no plan, SK OS works for you.</p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button className={`btn !py-2 !text-xs ${openSection === 'foods' ? 'btn-primary' : ''}`} onClick={() => setOpenSection(openSection === 'foods' ? null : 'foods')}>
            {foods.data?.mine?.length ? `${foods.data.mine.length} my foods` : 'My foods'}
          </button>
          <button className={`btn !py-2 !text-xs ${openSection === 'meals' ? 'btn-primary' : ''}`} onClick={() => setOpenSection(openSection === 'meals' ? null : 'meals')}>
            {myMeals.data?.meals?.length ? `${myMeals.data.meals.length} my meals` : 'My meals'}
          </button>
        </div>

        {openSection === 'foods' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-line bg-white/[.03] p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input className="input" placeholder="Food name (e.g. Home Poha)" value={foodForm.name} onChange={(e) => setFoodForm((f) => ({ ...f, name: e.target.value }))} />
                <input className="input" placeholder="Serving (e.g. 150 g)" value={foodForm.serving} onChange={(e) => setFoodForm((f) => ({ ...f, serving: e.target.value }))} />
              </div>
              <div className="grid grid-cols-4 gap-2">
                <input className="input" placeholder="kcal" type="number" value={foodForm.calories} onChange={(e) => setFoodForm((f) => ({ ...f, calories: e.target.value }))} />
                <input className="input" placeholder="P" type="number" value={foodForm.protein} onChange={(e) => setFoodForm((f) => ({ ...f, protein: e.target.value }))} />
                <input className="input" placeholder="C" type="number" value={foodForm.carbs} onChange={(e) => setFoodForm((f) => ({ ...f, carbs: e.target.value }))} />
                <input className="input" placeholder="F" type="number" value={foodForm.fat} onChange={(e) => setFoodForm((f) => ({ ...f, fat: e.target.value }))} />
              </div>
              <button className="btn-primary w-full" disabled={saving || !foodForm.name.trim()} onClick={async () => {
                setSaving(true);
                try {
                  await api('/me/foods', { method: 'POST', body: JSON.stringify({ ...foodForm, calories: Number(foodForm.calories) || 0, protein: Number(foodForm.protein) || 0, carbs: Number(foodForm.carbs) || 0, fat: Number(foodForm.fat) || 0 }) });
                  setFoodForm({ name: '', unit: '', serving: '', calories: '', protein: '', carbs: '', fat: '' });
                  foods.reload(); setToast('Food saved to My Foods');
                } catch (e) { setToast(e.message); }
                setSaving(false);
              }}>Save to my foods</button>
            </div>
            {!!foods.data?.mine?.length && (
              <div className="space-y-1.5">
                <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider">MY FOODS</div>
                {foods.data.mine.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 rounded-xl border border-line bg-white/[.02] px-3 py-2">
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-grotesk font-semibold">{f.name}</span>
                      <span className="text-[10px] text-mute">{f.serving || f.unit || ''} · {f.calories} kcal · P{f.protein} C{f.carbs} F{f.fat}</span>
                    </span>
                    <button className="btn !py-1 !px-2.5 !text-[10px] shrink-0" onClick={async () => {
                      try {
                        await api(`/nutrition/clients/${clientId}/meals/log`, { method: 'POST', body: JSON.stringify({
                          name: f.name, slot: 'Snack', calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, source: 'custom', eaten: true
                        }) });
                        setToast('Logged ' + f.name); home.reload();
                      } catch (e) { setToast(e.message); }
                    }}>Log</button>
                    <button className="text-[10px] text-bad/70 hover:text-bad shrink-0" onClick={async () => { try { await api(`/me/foods/${f.id}`, { method: 'DELETE' }); foods.reload(); } catch (e) { setToast(e.message); } }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {openSection === 'meals' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-line bg-white/[.03] p-3 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <input className="input" placeholder="Slot (Meal 1, Snack…)" value={mealForm.slot} onChange={(e) => setMealForm((f) => ({ ...f, slot: e.target.value }))} />
                <input className="input" placeholder="Meal name" value={mealForm.name} onChange={(e) => setMealForm((f) => ({ ...f, name: e.target.value }))} />
                <input className="input" placeholder="Time (08:00)" value={mealForm.time} onChange={(e) => setMealForm((f) => ({ ...f, time: e.target.value }))} />
              </div>
              <div className="grid grid-cols-4 gap-2">
                <input className="input" placeholder="kcal" type="number" value={mealForm.calories} onChange={(e) => setMealForm((f) => ({ ...f, calories: e.target.value }))} />
                <input className="input" placeholder="P" type="number" value={mealForm.protein} onChange={(e) => setMealForm((f) => ({ ...f, protein: e.target.value }))} />
                <input className="input" placeholder="C" type="number" value={mealForm.carbs} onChange={(e) => setMealForm((f) => ({ ...f, carbs: e.target.value }))} />
                <input className="input" placeholder="F" type="number" value={mealForm.fat} onChange={(e) => setMealForm((f) => ({ ...f, fat: e.target.value }))} />
              </div>
              <input className="input" placeholder="Foods (e.g. 50g oats · 200ml milk)" value={mealForm.foods} onChange={(e) => setMealForm((f) => ({ ...f, foods: e.target.value }))} />
              <button className="btn-primary w-full" disabled={saving || !mealForm.name.trim()} onClick={async () => {
                setSaving(true);
                try {
                  await api('/me/meals', { method: 'POST', body: JSON.stringify({ ...mealForm, calories: Number(mealForm.calories) || 0, protein: Number(mealForm.protein) || 0, carbs: Number(mealForm.carbs) || 0, fat: Number(mealForm.fat) || 0 }) });
                  setMealForm({ slot: 'Meal', name: '', time: '', calories: '', protein: '', carbs: '', fat: '', foods: '' });
                  myMeals.reload(); setToast('Meal template saved');
                } catch (e) { setToast(e.message); }
                setSaving(false);
              }}>Save meal template</button>
            </div>
            {!!myMeals.data?.meals?.length && (
              <div className="space-y-1.5">
                <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider">MY MEALS</div>
                {myMeals.data.meals.map((m) => (
                  <div key={m.id}>
                    <div className="flex items-center gap-2 rounded-xl border border-line bg-white/[.02] px-3 py-2">
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-grotesk font-semibold">{m.name}</span>
                        <span className="text-[10px] text-mute">{m.slot}{m.time ? ` · ${m.time}` : ''} · {m.calories} kcal · P{m.protein} C{m.carbs} F{m.fat}{m.item_count ? ` · ${m.item_count} items` : ''}</span>
                      </span>
                      <button className="btn !py-1 !px-2 !text-[10px] shrink-0" onClick={() => openComposer(m)}>Compose</button>
                      <button className="btn !py-1 !px-2.5 !text-[10px] shrink-0" onClick={async () => {
                        try {
                          await api(`/me/meals/${m.id}/log`, { method: 'POST' });
                          setToast('Logged ' + m.name); home.reload();
                        } catch (e) { setToast(e.message); }
                      }}>Eaten</button>
                      <button className="text-[10px] text-bad/70 hover:text-bad shrink-0" onClick={async () => { try { await api(`/me/meals/${m.id}`, { method: 'DELETE' }); myMeals.reload(); } catch (e) { setToast(e.message); } }}>✕</button>
                    </div>
                    {/* composer panel */}
                    {composing?.id === m.id && (
                      <div className="mt-2 rounded-xl border border-gold/30 bg-gold/5 p-3 space-y-2.5">
                        <div className="text-[10px] text-gold font-grotesk uppercase tracking-wider">BUILD {m.name.toUpperCase()}</div>
                        {items.length > 0 && (
                          <div className="space-y-1.5">
                            {items.map((it) => (
                              <div key={it.id} className="flex items-center gap-2 rounded-lg border border-line bg-bg/60 px-2.5 py-1.5">
                                <span className="flex-1 min-w-0">
                                  <span className="block text-[12px] font-grotesk font-semibold truncate">{it.name}</span>
                                  <span className="text-[9px] text-mute">{it.quantity}× {it.unit || 'serving'} · {it.calories} kcal · P{it.protein} C{it.carbs} F{it.fat}</span>
                                </span>
                                <div className="flex items-center gap-1 shrink-0">
                                  <input type="number" min="0.1" step="0.1" className="input !py-1 !px-1.5 !text-[10px] w-14" value={it.quantity} aria-label={`${it.name} quantity`} onChange={(e) => setItemQty(it, e.target.value)} />
                                  <button className="text-[11px] text-bad/70 hover:text-bad" onClick={async () => { try { await api(`/me/meals/${m.id}/items/${it.id}`, { method: 'DELETE' }); await reloadItems(); } catch (e) { setToast(e.message); } }} aria-label={`Remove ${it.name}`}>✕</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <input className="input flex-1" placeholder="Search foods…" value={foodSearch} onChange={(e) => setFoodSearch(e.target.value)} />
                          <input type="number" min="0.1" step="0.1" className="input w-16 !text-xs" value={foodQty} onChange={(e) => setFoodQty(e.target.value)} aria-label="Quantity (servings)" />
                        </div>
                        {!!foodSearch && (
                          <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                            {searching && !foodResults.length && (
                              <div className="text-[10px] text-faint px-1 py-2">Searching…</div>
                            )}
                            {!searching && !foodResults.length && (
                              <div className="text-[10px] text-faint px-1 py-2">No food matched “{foodSearch}”.</div>
                            )}
                            {foodResults.slice(0, 15).map((f) => (
                              <button key={f.id || f.source_id} onClick={() => addItem(f)}
                                disabled={f.trustworthy === false}
                                className="w-full flex items-center justify-between gap-2 rounded-lg border border-line bg-white/[.03] px-2.5 py-1.5 text-left disabled:opacity-50"
                                title={f.trustworthy === false ? (f.data_quality_flag || 'This entry failed a data-quality check') : undefined}>
                                <span className="min-w-0">
                                  <span className="block text-[12px] font-grotesk font-semibold truncate">{f.name}</span>
                                  <span className="text-[9px] text-mute">
                                    {/* A null nutrient means NOT MEASURED. Never render it as 0. */}
                                    {f.trustworthy === false
                                      ? (f.data_quality_flag || 'Data quality flagged')
                                      : `${f.calories == null ? '—' : Math.round(f.calories)} kcal / 100 g · P${f.protein ?? '—'} C${f.carbs ?? '—'} F${f.fat ?? '—'}`}
                                  </span>
                                </span>
                                <span className="flex items-center gap-1.5 shrink-0">
                                  {/* Confidence is calibrated server-side; the UI honours it
                                      rather than presenting every match as equally firm. */}
                                  {f.confidence && f.confidence !== 'high' && (
                                    <span className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
                                      {f.confidence}
                                    </span>
                                  )}
                                  <span className="text-[10px]" style={{ color: 'var(--accent)' }}>+ Add</span>
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="text-[9px] text-faint">Nutrition is calculated automatically from the foods and quantities. Tap + Add to add a food (search first).</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* AI logger */}
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2">Log what you ate</div>
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="e.g. 2 rotis, dal and curd" value={aiText} onChange={(e) => setAiText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && estimate()} />
          <button className="btn-primary shrink-0" onClick={estimate} disabled={estimating || !aiText.trim()}>{estimating ? '…' : 'Estimate'}</button>
        </div>
        {aiResult && (
          <div className="mt-3 rounded-xl border border-gold/30 bg-gold/5 p-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="font-grotesk text-sm font-bold">~{aiResult.total.calories} kcal · P{aiResult.total.protein} · C{aiResult.total.carbs} · F{aiResult.total.fat}</div>
              <div className="flex gap-2">
                <button className="btn !py-1.5 !px-3 !text-[11px]" onClick={() => setAiResult(null)}>Edit</button>
                <button className="btn-primary !py-1.5 !px-3 !text-[11px]" onClick={logAi} disabled={logging}>{logging ? '…' : 'Log it'}</button>
              </div>
            </div>
            {aiResult.items?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {aiResult.items.map((it, i) => <span key={i} className="chip border-line text-[10px]">{it.qty}× {it.name} (~{it.calories} kcal)</span>)}
              </div>
            )}
            <div className="text-[10px] text-faint mt-2">⚠️ {aiResult.disclaimer}</div>
          </div>
        )}
      </div>

      {/* water */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">Water</div>
          <div className="font-grotesk text-sm font-bold text-cyanx">{waterState.toFixed(1)} / {data.water.target} L</div>
        </div>
        <div className="flex gap-1.5">
          {Array.from({ length: Math.ceil(data.water.target / 0.25) }).map((_, i) => {
            const filled = waterState >= (i + 1) * 0.25;
            return (
              <button key={i} onClick={() => addWater(filled ? -0.25 : 0.25)} aria-label={`Water glass ${i + 1}`}
                className="relative flex-1 h-16 rounded-lg border overflow-hidden grid place-items-center transition-all duration-200"
                style={filled
                  ? { borderColor: 'rgba(53,215,255,.55)', boxShadow: '0 0 14px rgba(53,215,255,.25)' }
                  : { borderColor: 'rgba(255,255,255,.12)' }}>
                <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(53,215,255,.25), rgba(53,215,255,.8))', transition: 'transform .5s cubic-bezier(.22,.8,.3,1)', transform: filled ? 'translateY(0)' : 'translateY(101%)' }} />
        <span className="relative text-[9px] font-grotesk z-10" style={{ color: filled ? 'var(--accent-contrast)' : 'rgba(244,246,251,.32)' }}>{filled ? '' : '·'}</span>
              </button>
            );
          })}
        </div>
        <div className="text-[10px] text-faint mt-2">Tap a glass to fill it · tap a filled glass to remove</div>
      </div>

      {/* supplements */}
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2.5">Supplements</div>
        {supList?.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {supList.map((s) => {
              const taken = !!supTaken[s.id];
              return (
                <button key={s.id} onClick={() => setSupTaken((t) => ({ ...t, [s.id]: !taken }))}
                  className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${taken ? 'border-violetx/40 bg-violetx/10' : 'border-line bg-white/[.02]'}`}>
                  <span className={`w-5 h-5 rounded-md border grid place-items-center text-[10px] ${taken ? 'bg-violetx text-bg border-transparent' : 'border-line'}`}>{taken ? '✓' : ''}</span>
                  <span className="flex-1 font-grotesk text-sm font-semibold">{s.name}</span>
                  <span className="text-[10px] text-mute">{s.dose || ''}{s.schedule_time ? ` · ${s.schedule_time}` : ''}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="rounded-xl border border-line bg-white/[.03] p-3 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <input className="input" placeholder="Name" value={supForm.name} onChange={(e) => setSupForm((f) => ({ ...f, name: e.target.value }))} />
            <input className="input" placeholder="Dose" value={supForm.dose} onChange={(e) => setSupForm((f) => ({ ...f, dose: e.target.value }))} />
            <input className="input" type="time" placeholder="Time" value={supForm.schedule_time} onChange={(e) => setSupForm((f) => ({ ...f, schedule_time: e.target.value }))} />
          </div>
          <button className="btn-primary w-full" disabled={savingSup || !supForm.name.trim()} onClick={async () => {
            setSavingSup(true);
            try {
              await api(`/tracking/clients/${clientId}/supplements`, { method: 'POST', body: JSON.stringify({ name: supForm.name.trim(), dose: supForm.dose || undefined, schedule_time: supForm.schedule_time || undefined }) });
              setSupForm({ name: '', dose: '', schedule_time: '' });
              api(`/tracking/clients/${clientId}/supplements`).then((r) => setSupList(r.supplements || [])).catch(() => {});
              setToast('Supplement added');
            } catch (e) { setToast(e.message); }
            setSavingSup(false);
          }}>Add supplement</button>
        </div>
      </div>

      {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
      {/* Full logging flow: search -> portion -> oil -> add. Replaces the
          bare name-only picker, which silently assumed one serving. */}
      <FoodLogSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onAdd={async ({ food, resolved }) => {
          const r = await api('/me/foods/from-model', {
            method: 'POST',
            body: JSON.stringify({ source_id: food.source_id, name: food.name }),
          });
          const foodId = r.food?.id;
          if (!foodId) throw new Error('Could not add that food');
          if (composing?.id) {
            // Quantity is expressed in servings of the stored 100 g row, so
            // grams/100 is the multiplier that reproduces the resolved macros.
            await api(`/me/meals/${composing.id}/items`, {
              method: 'POST',
              body: JSON.stringify({ food_id: foodId, quantity: (resolved.grams || 100) / 100 }),
            });
            await reloadItems();
          }
          foods.reload();
          setToast(`${food.name} added`);
        }}
      />
    </div>
  );
}
