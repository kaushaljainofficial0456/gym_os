import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SavingOverlay from './SavingOverlay.jsx';

// foods.serving is a free-text description ("150 g", "1 bowl", "1 slice") --
// the LEADING number is the actual quantity, whatever the unit turns out to
// be. Scaling that number linearly and re-deriving macros by the same ratio
// is valid regardless of unit (2 slices really is 2x the nutrition of 1
// slice, the same way 300g is 3x 100g) -- this is the SAME grams/100-style
// linear scaling used everywhere else in this app, just generalized to
// whatever unit the food's own serving string uses.
function parseServing(serving) {
  const s = String(serving || '100 g').trim();
  const m = s.match(/^([\d.]+)\s*(.*)$/);
  if (m && Number(m[1]) > 0) return { amount: Number(m[1]), suffix: m[2].trim() || 'g' };
  return { amount: 1, suffix: s || 'g' }; // no leading number (e.g. just "bowl") -- treat as "1 of these"
}

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
  // ONE combined expand toggle, not one per kind -- Saved Foods and Saved
  // Meals used to be two independent always-visible subsections (each with
  // its own "See more"), which meant the default state could show a food
  // AND a meal AND both their headers simultaneously. Now there's one
  // unified list (see `combined` below) and one item shows by default,
  // full stop.
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState({}); // id -> string, the one-time log amount
  const [logging, setLogging] = useState({}); // id -> true while a quick-log animation is running
  const [checked, setChecked] = useState({}); // id -> true briefly, for the check-draw animation
  const [savingEdit, setSavingEdit] = useState(false);
  const [saveStage, setSaveStage] = useState(null);
  // Pending default-quantity edits, id -> typed string.
  //
  // The quantity field used to be uncontrolled (defaultValue + onBlur) and
  // "Save Changes" wrote NOTHING -- it waited 350ms and showed "Saved"
  // regardless. So typing a new quantity and tapping Save Changes raced
  // the blur against finishEditing's setEditing(false), which unmounts the
  // input; when blur lost that race the value was never written, and the
  // UI still said "Saved". A success state for a write that never
  // happened is worse than an error.
  //
  // Edits are now held here and FLUSHED by Save Changes, which awaits the
  // writes and only then reports success.
  const [qtyDraft, setQtyDraft] = useState({});
  const [saveError, setSaveError] = useState(null);

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

  // `serving` is a STRING ("100 g", "1 bowl"), so Number() on it is NaN for
  // anything but a bare number -- which silently became 100 and made every
  // non-gram food quick-log as if its base were 100 g. parseServing (right
  // above, and already used by the edit-mode input) is the one correct
  // reader of this field; nothing here may re-derive it a second way.
  const qtyFor = (kind, item) => {
    const key = `${kind}_${item.id}`;
    if (qty[key] !== undefined) return qty[key];
    return kind === 'food' ? String(parseServing(item.serving).amount) : '1';
  };
  const setQtyFor = (kind, item, v) => setQty((q) => ({ ...q, [`${kind}_${item.id}`]: v }));

  const quickLogFood = async (food) => {
    const key = `food_${food.id}`;
    // foods.calories/etc are already PER-SERVING (whatever `serving` says:
    // "100 g" for a weighed food, "1 bowl" for a countable one) -- scale by
    // amount / that base, the same linear scaling used everywhere else in
    // this app (scaleNutrition()). Reading the base with Number() instead
    // of parseServing() made "2" mean 2/100 of a bowl rather than 2 bowls.
    const { amount: base, suffix: unit } = parseServing(food.serving);
    const amount = Math.max(0.1, Number(qtyFor('food', food)) || base);
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
        // The unit the food is actually measured in -- hardcoding 'g' here
        // labelled every bowl/piece/serving log as grams.
        source: 'manual', quantity: amount, unit,
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
    // Was `catch { load(); }` -- on a failed delete the food silently
    // reappeared a moment later (via load()) with no explanation, same
    // "the app randomly undid my tap" bug already fixed for toggleMeal/
    // addWater in Nutrition.jsx. saveFoodQuantity below already gets this
    // right; removeFood/removeMeal were the two spots that didn't.
    try { await api(`/me/foods/${food.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message || 'Could not remove that food'); load(); }
  };

  // PERMANENT quantity edit -- the saved template only. Never touches
  // today's already-logged entries or any past log: those were written
  // with their own snapshot values at log time and stay that way (see
  // meal_logs, which stores calories/protein/etc directly, not a live
  // reference to this food row).
  /** Writes ONE food's new default quantity. Throws on failure so the
   *  caller (the Save Changes flush) can report it rather than swallow it. */
  const saveFoodQuantity = async (food, rawAmount) => {
    const { amount: oldAmount, suffix } = parseServing(food.serving);
    const newAmount = Math.max(0.1, Number(rawAmount) || oldAmount);
    if (newAmount === oldAmount) return false; // no real change -- nothing to write
    const ratio = newAmount / oldAmount;
    const updated = {
      serving: `${newAmount} ${suffix}`,
      calories: Math.round((food.calories || 0) * ratio),
      protein: Math.round((food.protein || 0) * ratio * 10) / 10,
      carbs: Math.round((food.carbs || 0) * ratio * 10) / 10,
      fat: Math.round((food.fat || 0) * ratio * 10) / 10,
    };
    await api(`/me/foods/${food.id}`, { method: 'PUT', body: JSON.stringify(updated) });
    setFoods((fs) => fs.map((f) => (f.id === food.id ? { ...f, ...updated } : f)));
    return true;
  };
  /** A saved MEAL has no `serving` string to rewrite -- its stored macros
   *  simply ARE one serving of it. So its edit control is a multiplier:
   *  "this saved meal is really twice what I recorded" scales the template
   *  and it becomes the new one serving. Deliberately not modelled as a
   *  servings count, because there is nowhere to persist that and a
   *  half-persisted quantity is exactly the class of bug this pass is
   *  closing -- the number would read back as 1 on the next load while the
   *  macros stayed scaled, quietly doubling the meal on every edit. */
  const saveMealScale = async (meal, rawScale) => {
    const scale = Number(rawScale);
    if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return false; // nothing to write
    const updated = {
      calories: Math.round((meal.calories || 0) * scale),
      protein: Math.round((meal.protein || 0) * scale * 10) / 10,
      carbs: Math.round((meal.carbs || 0) * scale * 10) / 10,
      fat: Math.round((meal.fat || 0) * scale * 10) / 10,
    };
    await api(`/me/meals/${meal.id}`, { method: 'PUT', body: JSON.stringify(updated) });
    setMeals((ms) => ms.map((m) => (m.id === meal.id ? { ...m, ...updated } : m)));
    return true;
  };

  const removeMeal = async (meal) => {
    setMeals((ms) => ms.filter((m) => m.id !== meal.id));
    // Same fix as removeFood above.
    try { await api(`/me/meals/${meal.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message || 'Could not remove that meal'); load(); }
  };

  /** Save Changes: actually FLUSHES every pending quantity edit, waits for
   *  the server, and only then reports success. Removals already persisted
   *  when they happened (see removeFood/removeMeal); quantities did not,
   *  which is the bug this replaces. */
  const finishEditing = async () => {
    setSavingEdit(true);
    setSaveError(null);
    setSaveStage('saving');
    try {
      // Foods and meals share one draft map (ids are prefixed and globally
      // unique). Looking only in `foods` here is what left every meal edit
      // unsaved while the button still reported success.
      const pending = Object.entries(qtyDraft);
      for (const [itemId, rawAmount] of pending) {
        const food = (foods || []).find((f) => f.id === itemId);
        if (food) { await saveFoodQuantity(food, rawAmount); continue; }
        const meal = (meals || []).find((m) => m.id === itemId);
        if (meal) await saveMealScale(meal, rawAmount);
      }
      setQtyDraft({});
      setSaveStage('success');
      setTimeout(() => { setSavingEdit(false); setSaveStage(null); setEditing(false); }, 700);
    } catch (e) {
      // Stay in edit mode with the drafts intact, so the user's typing is
      // not thrown away by a failed request.
      setSaveStage(null);
      setSavingEdit(false);
      setSaveError(e.message || "Couldn't save changes. Try again.");
      load();
    }
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
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-grotesk text-sm font-semibold truncate" style={{ color: t.ink }}>{label}</span>
            {/* Compact kind badge -- the ONLY thing distinguishing a food
                row from a meal row now that they share one list. */}
            <span className="font-grotesk text-[8px] font-bold uppercase tracking-[.08em] px-1.5 py-0.5 rounded-full shrink-0" style={{ background: t.accentDim, color: t.accent }}>
              {kind === 'food' ? 'Food' : 'Meal'}
            </span>
          </div>
          {editing && kind === 'food' ? (
            <div className="font-grotesk text-[10px] mt-0.5" style={{ color: t.faint }}>Default quantity</div>
          ) : (
            <div className="font-grotesk text-[10px]" style={{ color: t.faint }}>{sub}</div>
          )}
        </div>
        {!editing && (() => {
          // Grams step in tens; you do not eat 10 bowls more. The unit is
          // shown because it is no longer always grams -- without it the
          // field reads as "2" with no way to tell 2 g from 2 bowls.
          const unit = kind === 'food' ? parseServing(item.serving).suffix : 'x';
          const measured = unit === 'g' || unit === 'ml';
          return (
            <>
              <input
                type="number" min="0" step={kind === 'food' ? (measured ? 10 : 0.5) : 1}
                value={qtyFor(kind, item)}
                onChange={(e) => setQtyFor(kind, item, e.target.value)}
                aria-label={`${item.name} quantity`}
                className="w-14 text-right text-[11px] rounded-lg px-1.5 py-1 tabular-nums shrink-0"
                style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }}
              />
              <span className="text-[9px] shrink-0 w-8" style={{ color: t.faint }}>
                {kind === 'food' ? unit : 'serv'}
              </span>
            </>
          );
        })()}
        {editing && kind === 'food' && (
          <input
            type="number" min="0.1" step="any"
            // Controlled: the typed value lives in qtyDraft so tapping
            // "Save Changes" cannot lose it to an unmount/blur race.
            value={qtyDraft[item.id] ?? String(parseServing(item.serving).amount)}
            onChange={(e) => setQtyDraft((d) => ({ ...d, [item.id]: e.target.value }))}
            aria-label={`${item.name} default quantity`}
            className="w-16 text-right text-[11px] rounded-lg px-1.5 py-1 tabular-nums shrink-0"
            style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }}
          />
        )}
        {editing && kind === 'food' && (
          <span className="text-[9px] shrink-0 w-8" style={{ color: t.faint }}>{parseServing(item.serving).suffix}</span>
        )}
        {editing && kind === 'meal' && (
          <>
            <input
              type="number" min="0.1" step="0.5"
              // Same controlled-draft pattern as the food input: the typed
              // value lives in qtyDraft so "Save Changes" cannot lose it.
              value={qtyDraft[item.id] ?? '1'}
              onChange={(e) => setQtyDraft((d) => ({ ...d, [item.id]: e.target.value }))}
              aria-label={`Scale ${item.name}`}
              title="Resize this saved meal — 2 makes it twice the food"
              className="w-16 text-right text-[11px] rounded-lg px-1.5 py-1 tabular-nums shrink-0"
              style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }}
            />
            <span className="text-[9px] shrink-0 w-8" style={{ color: t.faint }}>x size</span>
          </>
        )}
      </div>
    );
  };

  // Unified list -- foods and meals interleaved into ONE array instead of
  // two independent always-both-visible subsections. Order is stable
  // (every food, then every meal) rather than re-sorted by recency, since
  // neither GET /me/foods nor GET /me/meals carries a reliable shared
  // timestamp to interleave by, and a stable order matters more here than
  // a "which was saved most recently" ordering neither list actually
  // guarantees today.
  const combined = [
    ...foods.map((f) => ({ kind: 'food', item: f })),
    ...meals.map((m) => ({ kind: 'meal', item: m })),
  ];
  // Default compact state shows exactly ONE saved item total, food or
  // meal -- not one of each. "See more" reveals the rest of the SAME
  // unified list.
  const visible = expanded ? combined : combined.slice(0, 1);

  return (
    <div className="relative rounded-3xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
      {/* A failed save has to be VISIBLE and has to keep the user's typing
          -- the previous version could not fail at all, because it never
          wrote anything. */}
      {saveError && (
        <div
          role="alert"
          className="mb-3 rounded-xl px-3 py-2 text-[11px]"
          style={{ background: 'rgb(var(--bad-rgb) / .10)', border: '1px solid rgb(var(--bad-rgb) / .35)', color: 'var(--bad)' }}
        >
          {saveError}
        </div>
      )}
      <div className="flex items-end justify-between mb-4">
        <div>
          <div className="font-grotesk text-base font-bold" style={{ color: t.ink }}>Saved Foods & Meals</div>
          <div className="font-grotesk text-[10px] mt-0.5" style={{ color: t.faint }}>{foods.length} foods · {meals.length} meals</div>
        </div>
        <button
          onClick={() => (editing ? finishEditing() : setEditing(true))}
          disabled={savingEdit}
          className="px-3 py-1.5 rounded-xl font-grotesk text-[10px] font-bold transition-all active:scale-95"
          style={{ background: editing ? t.accent : t.glass, color: editing ? 'var(--accent-contrast)' : t.mute, border: `1px solid ${editing ? t.accent : t.border}` }}
        >
          {editing ? (savingEdit ? 'Saving…' : 'Save Changes') : 'Edit'}
        </button>
      </div>

      {combined.length === 0 ? (
        <div className="text-center py-6">
          <div className="font-grotesk text-[12px]" style={{ color: t.mute }}>Nothing saved yet</div>
          <div className="font-grotesk text-[10px] mt-1" style={{ color: t.faint }}>Log a food or build a meal to see it here</div>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {visible.map(({ kind, item }) => (
              <Row key={`${kind}_${item.id}`} kind={kind} item={item}
                   label={item.name}
                   sub={kind === 'food' ? (item.serving || `${Math.round(item.calories || 0)} kcal`) : `${Math.round(item.calories || 0)} kcal · ${item.item_count || 0} items`} />
            ))}
          </div>
          {combined.length > 1 && (
            <button onClick={() => setExpanded(!expanded)} className="w-full mt-2 py-1.5 text-center font-grotesk text-[11px] font-semibold rounded-xl transition-colors" style={{ color: t.accent, background: t.accentDim }}>
              {expanded ? 'Show less' : `See more (${combined.length - 1})`}
            </button>
          )}
        </>
      )}

      <SavingOverlay open={savingEdit} stage={saveStage} label={saveStage === 'success' ? 'Saved' : 'Saving changes'} mode="overlay" size="sm" />
    </div>
  );
}
