import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SavingOverlay from './SavingOverlay.jsx';

const r1 = (n) => Math.round((n || 0) * 10) / 10;

/**
 * CUSTOMIZE MY MEALS — build a reusable meal from individual foods.
 * Reuses the EXISTING client_meal_templates/meal_items backend (already
 * live before this redesign, just unreachable) and the EXISTING food
 * search (/me/foods/search, same measured-database + model + AI-fallback
 * pipeline every other search in the app goes through -- no second
 * nutrition engine here). The template is created lazily on the first
 * food added (needs a name first); if the sheet is closed before that,
 * nothing is left behind in My Diet.
 */
export default function CustomizeMealSheet({ open, onClose, onLogged, t, toast }) {
  const [name, setName] = useState('');
  const [mealId, setMealId] = useState(null);
  const [items, setItems] = useState([]);
  const [totals, setTotals] = useState({ calories: 0, protein: 0, carbs: 0, fat: 0 });
  const [servings, setServings] = useState(1);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saveStage, setSaveStage] = useState(null); // null | 'saving' | 'success'
  const [saveLabel, setSaveLabel] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(''); setMealId(null); setItems([]); setTotals({ calories: 0, protein: 0, carbs: 0, fat: 0 });
    setServings(1); setQ(''); setResults([]); setSaveStage(null);
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setSearching(false); return undefined; }
    setSearching(true);
    let dead = false;
    const h = setTimeout(() => {
      api(`/me/foods/search?q=${encodeURIComponent(term)}`)
        .then((r) => { if (!dead) setResults((r.foods || []).slice(0, 8)); })
        .catch(() => { if (!dead) setResults([]); })
        .finally(() => { if (!dead) setSearching(false); });
    }, 220);
    return () => { dead = true; clearTimeout(h); };
  }, [q]);

  if (!open) return null;

  const refreshItems = async (id) => {
    const r = await api(`/me/meals/${id}/items`);
    setItems(r.items || []);
    setTotals({ calories: r.meal.calories || 0, protein: r.meal.protein || 0, carbs: r.meal.carbs || 0, fat: r.meal.fat || 0 });
  };

  const addFood = async (food) => {
    if (!name.trim()) { toast('Name your meal first'); return; }
    setAdding(true);
    try {
      let id = mealId;
      if (!id) {
        const created = await api('/me/meals', { method: 'POST', body: JSON.stringify({ name: name.trim(), slot: 'Meal' }) });
        id = created.id;
        setMealId(id);
      }
      await api(`/me/meals/${id}/items`, { method: 'POST', body: JSON.stringify({ food_id: food.source_id || food.id, name: food.name, quantity: 1 }) });
      await refreshItems(id);
      setQ(''); setResults([]);
      toast(`+ ${food.name} added`);
    } catch (e) {
      toast(e.message || 'Could not add that food');
    }
    setAdding(false);
  };

  const updateItemQty = async (item, quantity) => {
    const qty = Math.max(0.01, Number(quantity) || item.quantity);
    setItems((its) => its.map((it) => (it.id === item.id ? { ...it, quantity: qty } : it)));
    try {
      await api(`/me/meals/${mealId}/items/${item.id}`, { method: 'PUT', body: JSON.stringify({ quantity: qty }) });
      await refreshItems(mealId);
    } catch (e) { toast(e.message || 'Could not update that item'); }
  };

  const removeItem = async (item) => {
    setItems((its) => its.filter((it) => it.id !== item.id));
    try { await api(`/me/meals/${mealId}/items/${item.id}`, { method: 'DELETE' }); await refreshItems(mealId); }
    catch (e) { toast(e.message || 'Could not remove that item'); }
  };

  const canSave = !!mealId && items.length > 0;

  const runSave = async (label, action) => {
    setSaveStage('saving'); setSaveLabel(label);
    try {
      await action();
      setSaveStage('success');
      setTimeout(() => { setSaveStage(null); onClose(); }, 900);
    } catch (e) {
      toast(e.message || 'Could not save');
      setSaveStage(null);
    }
  };

  const logToday = () => runSave('Save Meal', async () => {
    await api(`/me/meals/${mealId}/log`, { method: 'POST', body: JSON.stringify({ servings }) });
    onLogged();
    toast(`${name} logged ✓`);
  });
  const saveOnly = () => runSave('Save Meal', async () => { toast(`${name} saved to My Diet ✓`); });
  const saveAndLog = () => runSave('Save Meal', async () => {
    await api(`/me/meals/${mealId}/log`, { method: 'POST', body: JSON.stringify({ servings }) });
    onLogged();
    toast(`${name} saved & logged ✓`);
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center anim-fadeIn"
         style={{ background: 'rgb(var(--bg-rgb) / .72)', backdropFilter: 'blur(4px)' }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full sm:max-w-md max-h-[88vh] overflow-y-auto rounded-b-none sm:rounded-2xl anim-scaleIn">
        <div className="sticky top-0 z-10 px-4 pt-4 pb-3" style={{ background: 'var(--panel)' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Create New Meal</div>
            <button onClick={onClose} aria-label="Close" style={{ color: 'var(--mute)' }}>✕</button>
          </div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Meal name, e.g. Post Workout Bowl"
                 className="input w-full !py-2.5 text-[14px] font-semibold" />
        </div>

        <div className="px-4 pb-4 space-y-3">
          <div className="relative">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="+ Add food…" className="input w-full !py-2.5 text-[13px]" />
            {(searching || results.length > 0) && (
              <div className="mt-1.5 space-y-1">
                {searching && !results.length && <div className="text-[11px] py-1" style={{ color: t.faint }}>Searching…</div>}
                {results.map((f) => (
                  <button key={f.id || f.source_id} onClick={() => addFood(f)} disabled={adding}
                          className="w-full text-left rounded-xl px-3 py-2 flex items-center justify-between gap-2" style={{ border: `1px solid ${t.border}` }}>
                    <span className="min-w-0 truncate font-grotesk text-[12px] font-semibold" style={{ color: t.ink }}>{f.name}</span>
                    <span className="shrink-0 font-grotesk text-[10px]" style={{ color: t.mute }}>{f.calories == null ? '—' : Math.round(f.calories)} kcal/100g</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {items.length > 0 && (
            <div className="space-y-1.5">
              {items.map((it) => (
                <div key={it.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                  <span className="min-w-0 flex-1 font-grotesk text-[12px] font-semibold" style={{ color: t.ink }}>
                    <span className="block truncate">{it.name}</span>
                    {/* meal_items.quantity is a SERVINGS multiplier, not grams
                        (see database/schema.sql's own comment on that column)
                        -- it.unit carries what ONE serving actually is (e.g.
                        "100 g" for a catalogue food), so this reads as
                        "1 x 100 g" rather than mislabeling the multiplier
                        itself as if it were a gram value. */}
                    {it.unit && <span className="block text-[9px] font-normal" style={{ color: t.faint }}>× {it.unit} each</span>}
                  </span>
                  <input type="number" min="0" step="0.5" defaultValue={it.quantity} onBlur={(e) => updateItemQty(it, e.target.value)}
                         aria-label={`${it.name} servings`}
                         className="w-14 text-right text-[11px] rounded-lg px-1.5 py-1 tabular-nums" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} />
                  <span className="w-14 text-right shrink-0 font-grotesk text-[11px] font-bold tabular-nums" style={{ color: t.mute }}>{Math.round(it.calories)} kcal</span>
                  <button onClick={() => removeItem(it)} aria-label={`Remove ${it.name}`} className="shrink-0 opacity-60 hover:opacity-100" style={{ color: t.danger }}>✕</button>
                </div>
              ))}
            </div>
          )}

          {items.length > 0 && (
            <div className="rounded-xl p-3.5" style={{ background: t.accentDim, border: `1px solid ${t.border}` }}>
              <div className="grid grid-cols-2 gap-y-2 gap-x-3 text-[11px]">
                <div style={{ color: t.mute }}>Ingredients</div><div className="text-right font-bold tabular-nums" style={{ color: t.ink }}>{items.length}</div>
                <div style={{ color: t.mute }}>Calories</div><div className="text-right font-bold tabular-nums" style={{ color: t.ink }}>{Math.round(totals.calories)} kcal</div>
                <div style={{ color: t.mute }}>Protein</div><div className="text-right font-bold tabular-nums" style={{ color: t.ink }}>{r1(totals.protein)} g</div>
                <div style={{ color: t.mute }}>Carbs</div><div className="text-right font-bold tabular-nums" style={{ color: t.ink }}>{r1(totals.carbs)} g</div>
                <div style={{ color: t.mute }}>Fat</div><div className="text-right font-bold tabular-nums" style={{ color: t.ink }}>{r1(totals.fat)} g</div>
              </div>
              <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: `1px solid ${t.border}` }}>
                <span className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.mute }}>Servings</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setServings((s) => Math.max(1, s - 1))} className="w-7 h-7 rounded-lg grid place-items-center font-bold" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}>−</button>
                  <span className="w-6 text-center font-grotesk text-sm font-bold tabular-nums" style={{ color: t.ink }}>{servings}</span>
                  <button onClick={() => setServings((s) => s + 1)} className="w-7 h-7 rounded-lg grid place-items-center font-bold" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}>+</button>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button onClick={logToday} disabled={!canSave} className="py-2.5 rounded-xl font-grotesk text-[12px] font-bold transition-all active:scale-[.97]"
                    style={{ background: canSave ? t.glass : t.surface, border: `1px solid ${t.border}`, color: canSave ? t.ink : t.mute, opacity: canSave ? 1 : .5 }}>Log Today</button>
            <button onClick={saveOnly} disabled={!canSave} className="py-2.5 rounded-xl font-grotesk text-[12px] font-bold transition-all active:scale-[.97]"
                    style={{ background: canSave ? t.glass : t.surface, border: `1px solid ${t.border}`, color: canSave ? t.ink : t.mute, opacity: canSave ? 1 : .5 }}>Save Meal</button>
          </div>
          <button onClick={saveAndLog} disabled={!canSave} className="w-full py-3 rounded-xl font-grotesk text-[13px] font-bold transition-all active:scale-[.98]"
                  style={{ background: canSave ? t.accent : t.surface, color: canSave ? 'var(--accent-contrast)' : t.mute, opacity: canSave ? 1 : .5 }}>Save & Log</button>
        </div>
      </div>

      <SavingOverlay open={!!saveStage} stage={saveStage} label={saveStage === 'success' ? 'Meal Saved' : saveLabel} mode="overlay" />
    </div>
  );
}
