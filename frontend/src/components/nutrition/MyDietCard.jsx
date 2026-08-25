import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SavingOverlay from './SavingOverlay.jsx';

/**
 * MY DIET — Saved Foods + Saved Meals, a REUSABLE library distinct from
 * Today's Eaten Meals (the actual log). Backed by existing, already-
 * working routes: GET/POST/PUT/DELETE /me/foods (client-owned rows) and
 * GET/POST/PUT/DELETE /me/meals (+ /me/meals/:id/items) for
 * client_meal_templates -- both existed before this redesign, just had
 * no reachable UI. Nothing new on the read/write side except the two
 * additive routes this redesign added (PUT /me/foods/:id for permanent
 * edits, and `servings` on POST /me/meals/:id/log for quick-log quantity).
 *
 * THREE DISTINCT STATES, never conflated (per spec):
 *  - the quantity typed into a row here, BEFORE checking it, is a
 *    ONE-TIME logging amount (does not touch the saved template)
 *  - checking a row logs it into TODAY'S log at that amount
 *  - Edit mode's [-] permanently removes the saved template itself
 */
export default function MyDietCard({ clientId, onLogged, t, toast }) {
  const [foods, setFoods] = useState(null);
  const [meals, setMeals] = useState(null);
  const [foodsExpanded, setFoodsExpanded] = useState(false);
  const [mealsExpanded, setMealsExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState({}); // id -> string, the one-time log amount
  const [logging, setLogging] = useState({}); // id -> true while a quick-log animation is running
  const [checked, setChecked] = useState({}); // id -> true briefly, for the check-draw animation
  const [savingEdit, setSavingEdit] = useState(false);
  const [saveStage, setSaveStage] = useState(null);

  const load = () => {
    api('/me/foods').then((r) => setFoods(r.mine || [])).catch(() => setFoods([]));
    api('/me/meals').then((r) => setMeals(r.meals || [])).catch(() => setMeals([]));
  };
  useEffect(load, [clientId]);

  if (foods === null || meals === null) {
    return (
      <div className="rounded-3xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <div className="h-5 w-24 rounded-full anim-pulse-soft" style={{ background: t.glass }} />
        <div className="mt-4 space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-12 rounded-xl anim-pulse-soft" style={{ background: t.glass }} />)}
        </div>
      </div>
    );
  }

  const qtyFor = (kind, item) => {
    const key = `${kind}_${item.id}`;
    if (qty[key] !== undefined) return qty[key];
    return kind === 'food' ? String(Number(item.serving) || 100) : '1';
  };
  const setQtyFor = (kind, item, v) => setQty((q) => ({ ...q, [`${kind}_${item.id}`]: v }));

  const quickLogFood = async (food) => {
    const key = `food_${food.id}`;
    const amount = Math.max(0.1, Number(qtyFor('food', food)) || 100);
    // foods.calories/etc are already PER-SERVING (whatever `serving` says,
    // typically "100 g") -- scale by amount / that base, same grams/100
    // linear scaling used everywhere else in this app (scaleNutrition()).
    const base = Number(food.serving) || 100;
    const factor = amount / base;
    setLogging((s) => ({ ...s, [key]: true }));
    setChecked((s) => ({ ...s, [key]: true }));
    try {
      await onLogged({
        name: food.name,
        calories: Math.round((food.calories || 0) * factor),
        protein: Math.round((food.protein || 0) * factor * 10) / 10,
        carbs: Math.round((food.carbs || 0) * factor * 10) / 10,
        fat: Math.round((food.fat || 0) * factor * 10) / 10,
        source: 'manual',
      });
      toast(`+ ${food.name} added`);
    } catch (e) {
      toast(e.message || 'Could not log that food');
    }
    setTimeout(() => setChecked((s) => ({ ...s, [key]: false })), 700);
    setLogging((s) => ({ ...s, [key]: false }));
  };

  const quickLogMeal = async (meal) => {
    const key = `meal_${meal.id}`;
    const servings = Math.max(0.1, Number(qtyFor('meal', meal)) || 1);
    setLogging((s) => ({ ...s, [key]: true }));
    setChecked((s) => ({ ...s, [key]: true }));
    try {
      await api(`/me/meals/${meal.id}/log`, { method: 'POST', body: JSON.stringify({ servings }) });
      onLogged(null); // signal "reload today's data" without inserting via the generic path -- this route already wrote the log row itself
      toast(`+ ${meal.name} added`);
    } catch (e) {
      toast(e.message || 'Could not log that meal');
    }
    setTimeout(() => setChecked((s) => ({ ...s, [key]: false })), 700);
    setLogging((s) => ({ ...s, [key]: false }));
  };

  const removeFood = async (food) => {
    setFoods((fs) => fs.filter((f) => f.id !== food.id));
    try { await api(`/me/foods/${food.id}`, { method: 'DELETE' }); } catch { load(); }
  };
  const removeMeal = async (meal) => {
    setMeals((ms) => ms.filter((m) => m.id !== meal.id));
    try { await api(`/me/meals/${meal.id}`, { method: 'DELETE' }); } catch { load(); }
  };

  const finishEditing = async () => {
    setSavingEdit(true);
    setSaveStage('saving');
    // Removals in edit mode already persisted immediately (per-action, see
    // removeFood/removeMeal) -- this is the confirming flourish the spec
    // asks for on "Save Changes", not a second write.
    await new Promise((r) => setTimeout(r, 350));
    setSaveStage('success');
    setTimeout(() => { setSavingEdit(false); setSaveStage(null); setEditing(false); }, 700);
  };

  const Row = ({ kind, item, label, sub }) => {
    const key = `${kind}_${item.id}`;
    const isChecked = !!checked[key];
    return (
      <div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-all duration-200" style={{
        background: isChecked ? t.accentDim : t.glass, border: `1px solid ${isChecked ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : t.border}`,
      }}>
        {editing ? (
          <button
            onClick={() => (kind === 'food' ? removeFood(item) : removeMeal(item))}
            aria-label={`Remove ${item.name}`}
            className="w-7 h-7 rounded-lg grid place-items-center text-sm font-bold shrink-0 transition-transform active:scale-90"
            style={{ background: `${t.danger}12`, color: t.danger, border: `1px solid ${t.danger}30` }}
          >−</button>
        ) : (
          <button
            onClick={() => (kind === 'food' ? quickLogFood(item) : quickLogMeal(item))}
            disabled={!!logging[key]}
            aria-label={`Quick-log ${item.name}`}
            className="w-6 h-6 rounded-md grid place-items-center shrink-0 transition-all duration-200"
            style={{
              background: isChecked ? t.accent : 'transparent',
              border: `2px solid ${isChecked ? t.accent : t.border}`,
              transform: isChecked ? 'scale(1.08)' : 'scale(1)',
            }}
          >
            {isChecked && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-contrast)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"
                   style={{ animation: 'checkPop .3s cubic-bezier(.22,.8,.3,1) both' }}>
                <path d="M20 6 9 17l-5-5" />
              </svg>
            )}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-grotesk text-sm font-semibold truncate" style={{ color: t.ink }}>{label}</div>
          <div className="font-grotesk text-[10px]" style={{ color: t.faint }}>{sub}</div>
        </div>
        {!editing && (
          <input
            type="number" min="0" step={kind === 'food' ? 10 : 1} value={qtyFor(kind, item)}
            onChange={(e) => setQtyFor(kind, item, e.target.value)}
            aria-label={`${item.name} quantity`}
            className="w-14 text-right text-[11px] rounded-lg px-1.5 py-1 tabular-nums shrink-0"
            style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }}
          />
        )}
      </div>
    );
  };

  const visibleFoods = foodsExpanded ? foods : foods.slice(0, 2);
  const visibleMeals = mealsExpanded ? meals : meals.slice(0, 2);

  return (
    <div className="relative rounded-3xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
      <div className="flex items-end justify-between mb-4">
        <div>
          <div className="font-grotesk text-[11px] font-semibold uppercase tracking-[.16em] flex items-center gap-2" style={{ color: t.mute }}>
            <span className="inline-block w-1 h-1 rounded-full" style={{ background: t.accent }} />
            My Diet
          </div>
          <div className="font-grotesk text-[10px] mt-0.5" style={{ color: t.faint }}>{foods.length} saved foods · {meals.length} saved meals</div>
        </div>
        <button
          onClick={() => (editing ? finishEditing() : setEditing(true))}
          disabled={savingEdit}
          className="px-3 py-1.5 rounded-xl font-grotesk text-[10px] font-bold transition-all active:scale-95"
          style={{ background: editing ? t.accent : t.glass, color: editing ? 'var(--accent-contrast)' : t.mute, border: `1px solid ${editing ? t.accent : t.border}` }}
        >
          {editing ? 'Save Changes' : 'Edit'}
        </button>
      </div>

      {foods.length === 0 && meals.length === 0 && (
        <div className="text-center py-6">
          <div className="font-grotesk text-[12px]" style={{ color: t.mute }}>Nothing saved yet</div>
          <div className="font-grotesk text-[10px] mt-1" style={{ color: t.faint }}>Log a food or build a meal to see it here</div>
        </div>
      )}

      {foods.length > 0 && (
        <div className="mb-4">
          <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2" style={{ color: t.mute }}>Saved Foods</div>
          <div className="space-y-1.5">
            {visibleFoods.map((f) => (
              <Row key={f.id} kind="food" item={f} label={f.name} sub={f.serving || `${Math.round(f.calories || 0)} kcal`} />
            ))}
          </div>
          {foods.length > 2 && (
            <button onClick={() => setFoodsExpanded(!foodsExpanded)} className="w-full mt-2 py-1.5 text-center font-grotesk text-[11px] font-semibold rounded-xl transition-colors" style={{ color: t.accent, background: t.accentDim }}>
              {foodsExpanded ? 'Show less' : `See more (${foods.length - 2} more)`}
            </button>
          )}
        </div>
      )}

      {meals.length > 0 && (
        <div>
          <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2" style={{ color: t.mute }}>Saved Meals</div>
          <div className="space-y-1.5">
            {visibleMeals.map((m) => (
              <Row key={m.id} kind="meal" item={m} label={m.name} sub={`${Math.round(m.calories || 0)} kcal · ${m.item_count || 0} items`} />
            ))}
          </div>
          {meals.length > 2 && (
            <button onClick={() => setMealsExpanded(!mealsExpanded)} className="w-full mt-2 py-1.5 text-center font-grotesk text-[11px] font-semibold rounded-xl transition-colors" style={{ color: t.accent, background: t.accentDim }}>
              {mealsExpanded ? 'Show less' : `See more (${meals.length - 2} more)`}
            </button>
          )}
        </div>
      )}

      <SavingOverlay open={savingEdit} stage={saveStage} label={saveStage === 'success' ? 'Saved' : 'Saving changes'} mode="overlay" size="sm" />
    </div>
  );
}
