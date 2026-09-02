import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import SavingOverlay from './SavingOverlay.jsx';
import MealFoodRow from './MealFoodRow.jsx';
import CustomFoodBadge from './CustomFoodBadge.jsx';

const r1 = (n) => Math.round((n || 0) * 10) / 10;
const makeRowId = () => `row_${Math.random().toString(36).slice(2)}`;

/**
 * CUSTOMIZE MY MEALS — build a reusable meal from individual foods.
 * Reuses the EXISTING client_meal_templates/meal_items backend (already
 * live before this redesign, just unreachable) and the EXISTING food
 * search (/me/foods/search, same measured-database + model + AI-fallback
 * pipeline every other search in the app goes through -- no second
 * nutrition engine here). The template is created lazily on the first
 * food added (needs a name first); if the sheet is closed before that,
 * nothing is left behind in My Diet.
 *
 * ONE-ACTIVE-BLOCK WORKSPACE (follow-up hardening pass, Sections 8-11 --
 * supersedes the old always-open multi-row design, Parts 18/21-22): at
 * most ONE <MealFoodRow> is ever mounted as a live search/custom-macros
 * form (`rowIds` holds 0 or 1 ids). The moment a row successfully adds a
 * food, it's dropped from `rowIds` (see handleRowAdded) -- its
 * contribution is already visible as a compact "name · qty · kcal
 * [Edit][Remove]" card in the `items` list right below, so there is
 * nothing left for the row itself to show. "+ Add another food" always
 * REPLACES whatever's in `rowIds` with exactly one fresh id (never
 * appends), so tapping it while an earlier, not-yet-completed block is
 * still half-typed discards that half-typed state rather than stacking a
 * second simultaneously-active search field -- "only one search field
 * actively focused at a time" is an invariant of `rowIds`'s shape, not
 * something enforced by extra render logic. Every row calls back up to
 * the THREE functions below (addFoodItem / addCustomFoodItem /
 * addAIItem), which stay the single place that talks to
 * mealId/items/totals -- exactly one source of truth for the meal being
 * built no matter how many blocks have been completed so far.
 */
export default function CustomizeMealSheet({ open, onClose, onLogged, t, toast }) {
  const [name, setName] = useState('');
  const [mealId, setMealId] = useState(null);
  const [items, setItems] = useState([]);
  const [totals, setTotals] = useState({ calories: 0, protein: 0, carbs: 0, fat: 0 });
  const [servings, setServings] = useState(1);
  const [rowIds, setRowIds] = useState(() => [makeRowId()]);
  const [saveStage, setSaveStage] = useState(null); // null | 'saving' | 'success'
  const [saveLabel, setSaveLabel] = useState('');
  const nameRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setName(''); setMealId(null); setItems([]); setTotals({ calories: 0, protein: 0, carbs: 0, fat: 0 });
    setServings(1); setSaveStage(null); setRowIds([makeRowId()]);
    setTimeout(() => nameRef.current?.focus(), 120);
  }, [open]);

  // Escape exits the whole sheet -- there's no nested "screen" here to
  // step back through one level at a time (unlike FoodLogSheet's portion
  // picker/AI review/barcode confirm); each MealFoodRow's own local state
  // is transient entry-in-progress, not a navigation level.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Always replaces, never appends -- see the file-header comment on why
  // at most one row is ever live at once.
  const addRow = () => setRowIds(() => [makeRowId()]);
  // Cancel the (only) active, not-yet-completed block -- leaves zero rows
  // live until "+ Add another food" is tapped again, same end state as a
  // completed block.
  const removeRow = (id) => setRowIds((ids) => ids.filter((x) => x !== id));
  // A block successfully added its one food -- collapse it. Its
  // contribution is already a compact card in `items` below, so there is
  // nothing left for the row to render; no separate "collapsed" visual
  // state needs to exist for it.
  const handleRowAdded = (id) => setRowIds((ids) => ids.filter((x) => x !== id));

  const refreshItems = async (id) => {
    const r = await api(`/me/meals/${id}/items`);
    setItems(r.items || []);
    setTotals({ calories: r.meal.calories || 0, protein: r.meal.protein || 0, carbs: r.meal.carbs || 0, fat: r.meal.fat || 0 });
  };

  // Ensures the template exists (lazy-create on first item, named first),
  // shared by both the database-match path and the AI-estimate path below.
  const ensureMeal = async () => {
    if (mealId) return mealId;
    const created = await api('/me/meals', { method: 'POST', body: JSON.stringify({ name: name.trim(), slot: 'Meal' }) });
    setMealId(created.id);
    return created.id;
  };

  // The three callbacks every <MealFoodRow> below calls into. Each is
  // awaited by the row and expected to THROW on failure (rather than
  // toast-and-swallow) so the row that triggered it can show its own
  // inline error -- these stay the single place that talks to
  // mealId/items/totals no matter how many rows are open at once.
  const addFoodItem = async (food) => {
    if (!name.trim()) throw new Error('Name your meal first');
    const id = await ensureMeal();
    // food.id (this row's own real `foods` primary key) FIRST, never
    // food.source_id -- source_id only means anything to a MODEL lookup,
    // and preferring it here was the exact mechanism behind a real bug:
    // a custom/library food's `id` is always the correct, unambiguous
    // identifier once it's a real row; only a bare, never-yet-materialized
    // model search result (no `id` at all) has nothing but a name/
    // source_id for the backend's own materialize-on-add fallback to use.
    await api(`/me/meals/${id}/items`, { method: 'POST', body: JSON.stringify({ food_id: food.id || undefined, name: food.name, quantity: 1 }) });
    await refreshItems(id);
    toast(`+ ${food.name} added`);
  };

  // Custom Macros row: create a private "MY FOODS" row (same route My
  // Diet's own editor and FoodLogSheet's Custom Macros mode both use),
  // then add IT to the meal via the ordinary food_id path -- so it lands
  // as a real, correctly-sourced ('database') item, not something faked
  // up as an AI estimate just to fit that shape.
  const addCustomFoodItem = async ({ name: foodName, servingGrams, ...nums }) => {
    if (!name.trim()) throw new Error('Name your meal first');
    const created = await api('/me/foods', { method: 'POST', body: JSON.stringify({ name: foodName, ...nums }) });
    const id = await ensureMeal();
    // POST /me/meals/:id/items multiplies quantity directly against the
    // food's own stored (per-100g) macros -- quantity:1 always flat here
    // used to mean "100 g regardless of what was actually typed" once
    // MealFoodRow started converting Custom Macros to per-100g (a real
    // bug this closes). servingGrams/100 is the multiplier that gets
    // back to the real entered amount -- e.g. a 250g bowl -> 2.5.
    const quantity = servingGrams > 0 ? servingGrams / 100 : 1;
    await api(`/me/meals/${id}/items`, { method: 'POST', body: JSON.stringify({ food_id: created.id, name: foodName, quantity }) });
    await refreshItems(id);
    toast(`+ ${foodName} added`);
  };

  // AI fallback for a food the database search couldn't (well enough)
  // match -- the row passes back its OWN preview + grams; this stays the
  // only place that turns it into a real meal_items row.
  const addAIItem = async (aiPreview, aiGrams) => {
    if (!name.trim()) throw new Error('Name your meal first');
    const grams = Math.max(1, Number(aiGrams) || aiPreview.serving?.estimated_weight_g || 100);
    const baseGrams = aiPreview.serving?.estimated_weight_g || 100;
    const factor = grams / baseGrams;
    const id = await ensureMeal();
    await api(`/me/meals/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({
        ai_estimate: {
          name: aiPreview.food_name, grams,
          calories: Math.round((aiPreview.totals.calories || 0) * factor),
          protein_g: r1((aiPreview.totals.protein || 0) * factor),
          carbs_g: r1((aiPreview.totals.carbs || 0) * factor),
          fat_g: r1((aiPreview.totals.fat || 0) * factor),
          confidence: aiPreview.confidence,
          provider: aiPreview.ai?.provider,
          model: aiPreview.ai?.model,
        },
      }),
    });
    await refreshItems(id);
    toast(`+ ${aiPreview.food_name} added`);
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

  // Portal straight to <body> -- see FoodLogSheet.jsx's own comment on
  // why: ClientLayout.jsx's page wrapper carries `.anim-fadeUp` (a
  // fill-mode 'both' animation whose end-state transform never clears),
  // which silently makes this sheet's "fixed inset-0" relative to that
  // ancestor instead of the true viewport. A portal sidesteps the whole
  // containing-block question without touching the shared animation CSS.
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center anim-fadeIn"
         style={{ background: 'rgb(var(--bg-rgb) / .72)', backdropFilter: 'blur(4px)' }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
         role="dialog" aria-modal="true" aria-label="Create new meal">
      <div className="card w-full sm:max-w-md max-h-[88vh] overflow-y-auto rounded-b-none sm:rounded-2xl anim-scaleIn">
        <div className="sticky top-0 z-10 px-4 pt-4 pb-3" style={{ background: 'var(--panel)' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Create New Meal</div>
            <button onClick={onClose} aria-label="Close"
                    className="shrink-0 -mr-2.5 w-11 h-11 rounded-full grid place-items-center text-[15px]" style={{ color: 'var(--mute)' }}>✕</button>
          </div>
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Meal name, e.g. Post Workout Bowl"
                 aria-label="Meal name" className="input w-full !py-2.5 text-[14px] font-semibold" />
        </div>

        <div className="px-4 pb-4 space-y-3">
          <div className="space-y-2">
            {rowIds.map((id) => (
              <div key={id} className="relative">
                <MealFoodRow t={t} onAddFood={addFoodItem} onAddCustom={addCustomFoodItem} onAddAI={addAIItem}
                             onAdded={() => handleRowAdded(id)} />
                {/* Outer button is a real 32x32 tap target (Part 33); the
                    visible badge stays a small 20x20 circle inside it so
                    the corner-badge look doesn't change. Always shown now
                    (not just when >1 row) -- cancelling the sole active
                    block is a legitimate action, same end state as
                    completing it. */}
                <button onClick={() => removeRow(id)} aria-label="Cancel this food entry"
                        className="absolute -top-2.5 -right-2.5 w-8 h-8 rounded-full grid place-items-center">
                  <span className="w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold leading-none"
                        style={{ background: t.surface, border: `1px solid ${t.border}`, color: t.mute }}>✕</span>
                </button>
              </div>
            ))}
            {/* At most one block is ever live (see file-header comment) --
                once it's completed or cancelled, "+ Add another food" is
                the only way back in, and always opens exactly one fresh
                block. */}
            {rowIds.length === 0 && (
              <button onClick={addRow}
                      className="w-full py-2 rounded-xl font-grotesk text-[11px] font-semibold"
                      style={{ border: `1px dashed ${t.border}`, color: t.accent }}>
                + Add another food
              </button>
            )}
          </div>

          {items.length > 0 && (
            <div className="space-y-1.5">
              {items.map((it) => {
                const isAI = it.source === 'ai_estimated';
                return (
                <div key={it.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                  <span className="min-w-0 flex-1 font-grotesk text-[12px] font-semibold" style={{ color: t.ink }}>
                    <span className="flex items-center gap-1.5">
                      {/* A completed block's own compact card (Sections
                          8-11) -- this list IS that card format, once a
                          row's MealFoodRow collapses out of `rowIds`. */}
                      <span className="shrink-0" style={{ color: 'var(--good)' }} aria-hidden="true">✓</span>
                      <span className="truncate">{it.name}</span>
                      <CustomFoodBadge source={it.source} t={t} />
                    </span>
                    {/* AI items store quantity as GRAMS directly (the AI's own
                        natural unit); database items store a SERVINGS
                        multiplier against it.unit's own descriptive serving
                        (see database/schema.sql's column comment) -- "1 x
                        100 g" for the latter, plain grams for the former. */}
                    {!isAI && it.unit && <span className="block text-[9px] font-normal" style={{ color: t.faint }}>× {it.unit} each</span>}
                  </span>
                  <input type="number" min="0" step={isAI ? 10 : 0.5} defaultValue={it.quantity} onBlur={(e) => updateItemQty(it, e.target.value)}
                         aria-label={`${it.name} ${isAI ? 'grams' : 'servings'}`}
                         className="w-14 text-right text-[11px] rounded-lg px-1.5 py-1 tabular-nums" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} />
                  {isAI && <span className="text-[9px] shrink-0" style={{ color: t.faint }}>g</span>}
                  <span className="w-14 text-right shrink-0 font-grotesk text-[11px] font-bold tabular-nums" style={{ color: t.mute }}>{Math.round(it.calories)} kcal</span>
                  <button onClick={() => removeItem(it)} aria-label={`Remove ${it.name}`} className="shrink-0 opacity-60 hover:opacity-100" style={{ color: t.danger }}>✕</button>
                </div>
                );
              })}
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
  ), document.body);
}
