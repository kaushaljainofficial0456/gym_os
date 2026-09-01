import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import AIEstimateCard from './AIEstimateCard.jsx';

const EMPTY_CUSTOM = { name: '', calories: '', protein: '', carbs: '', fat: '', fiber: '', sugar: '', sodium: '' };
// Required for a valid submission (Part 14); fiber/sugar/sodium are
// optional extras, tucked behind a disclosure so the primary 4-field
// flow stays uncluttered.
const REQUIRED_MACROS = ['calories', 'protein', 'carbs', 'fat'];
const OPTIONAL_MACROS = ['fiber', 'sugar', 'sodium'];
const r1 = (n) => Math.round((n || 0) * 10) / 10;

/**
 * ONE independent food-entry row inside the meal-builder workspace
 * (Parts 18-21). Owns only its OWN transient input state (search query/
 * results, AI preview, custom-macros form) -- the actual API calls that
 * turn a selection into a real meal_items row live in the PARENT
 * (CustomizeMealSheet owns `mealId`/`items`/`totals`, the single source
 * of truth every row writes into), passed down as three callbacks:
 * `onAddFood(food)`, `onAddCustom({name,calories,protein,carbs,fat})`,
 * `onAddAI(aiPreview, gramsString)`. Each is awaited and expected to
 * throw on failure so this row can show its own inline error without
 * the parent needing to know which row is showing what. On success the
 * row resets itself to blank, ready for the next food in the SAME slot
 * (Part 21 -- "search, add, search next, add", no reset of the whole
 * workspace) -- multiple rows existing side by side (Part 18) is what
 * lets several of these run independently instead of one shared row
 * forcing everything through single file.
 */
export default function MealFoodRow({ onAddFood, onAddCustom, onAddAI, t }) {
  const [mode, setMode] = useState('search'); // 'search' | 'custom'
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  // Distinct from "zero results" (Part 46: no silent failures) -- a
  // network/server error while searching used to look identical to a
  // genuine no-match.
  const [searchErr, setSearchErr] = useState('');
  const [searchRetryNonce, setSearchRetryNonce] = useState(0);
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState('');
  // Recent foods (Part 40), reused here too -- same GET /me/foods/recent
  // FoodLogSheet.jsx's idle screen uses. A recent entry is a reconstructed
  // log SNAPSHOT (no food_id to look up), so adding one here routes
  // through onAddCustom -- exactly what Custom Macros already does,
  // just pre-filled from history instead of hand-typed.
  const [recentFoods, setRecentFoods] = useState([]);

  useEffect(() => {
    let dead = false;
    api('/me/foods/recent?limit=5').then((r) => { if (!dead) setRecentFoods(r.recent || []); }).catch(() => {});
    return () => { dead = true; };
  }, []);
  const [customForm, setCustomForm] = useState(EMPTY_CUSTOM);
  const [customErr, setCustomErr] = useState('');
  const [showMoreMacros, setShowMoreMacros] = useState(false);
  // Duplicate-name handling (Part 39, ported from FoodLogSheet.jsx's own
  // Custom Macros mode): holds the client's OWN already-saved food when
  // the typed name exactly (case-insensitively) matches one, pending the
  // user's choice between reusing it or genuinely creating a second food
  // that happens to share a name (e.g. two different "Curry"s).
  const [customDuplicate, setCustomDuplicate] = useState(null);
  // AI fallback -- same Tier-4 estimator every other food-AI entry point
  // uses (POST /me/foods/ai-estimate), never a second nutrition engine.
  const [aiEstimating, setAiEstimating] = useState(false);
  const [aiPreview, setAiPreview] = useState(null);
  const [aiGrams, setAiGrams] = useState('100');
  const [aiErr, setAiErr] = useState('');

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setSearching(false); return undefined; }
    setSearching(true); setSearchErr('');
    let dead = false;
    const h = setTimeout(() => {
      api(`/me/foods/search?q=${encodeURIComponent(term)}`)
        .then((r) => { if (!dead) setResults((r.foods || []).slice(0, 8)); })
        .catch((e) => { if (!dead) { setResults([]); setSearchErr(e.message || 'Could not search right now — check your connection and try again.'); } })
        .finally(() => { if (!dead) setSearching(false); });
    }, 220);
    return () => { dead = true; clearTimeout(h); };
  }, [q, searchRetryNonce]);

  const resetToBlank = () => {
    setQ(''); setResults([]); setAiPreview(null); setAiErr(''); setAddErr(''); setSearchErr('');
  };

  const handleAddFood = async (food) => {
    setAdding(true); setAddErr('');
    try { await onAddFood(food); resetToBlank(); }
    catch (e) { setAddErr(e.message || 'Could not add that food'); }
    setAdding(false);
  };

  // Adds a Recent entry to the meal at its own last-known macros, via the
  // SAME private-food path Custom Macros uses (there's no food_id to add
  // it by directly). Preserves the original name/values faithfully;
  // doesn't reset the row afterward since nothing in the idle screen
  // needs clearing (the Recent list itself just stays put, ready for the
  // next quick-add).
  const quickAddRecent = async (r) => {
    setAdding(true); setAddErr('');
    try {
      await onAddCustom({ name: r.name, calories: Math.round(r.calories || 0), protein: r.protein || 0, carbs: r.carbs || 0, fat: r.fat || 0 });
    } catch (e) { setAddErr(e.message || 'Could not add that food'); }
    setAdding(false);
  };

  // `skipDuplicateCheck` -- true only when called from "Create another"
  // below, after the user has already been shown and dismissed the
  // duplicate-name notice for THIS name; every other call re-checks.
  const handleAddCustom = async (skipDuplicateCheck = false) => {
    setCustomErr('');
    const cf = customForm;
    const foodName = cf.name.trim();
    if (!foodName) { setCustomErr('Name this food first'); return; }
    const nums = { calories: Number(cf.calories), protein: Number(cf.protein), carbs: Number(cf.carbs), fat: Number(cf.fat) };
    for (const key of REQUIRED_MACROS) {
      const v = nums[key];
      if (!Number.isFinite(v) || v < 0) { setCustomErr(`Enter a valid, non-negative ${key === 'calories' ? 'calorie' : key} value`); return; }
    }
    // fiber/sugar/sodium are OPTIONAL -- blank means "not tracked", never
    // coerced to 0 (a real 0g fiber and "didn't enter one" are different
    // facts). Only sent if the user actually typed something.
    for (const key of OPTIONAL_MACROS) {
      const raw = cf[key];
      if (raw === '' || raw == null) continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) { setCustomErr(`Enter a valid, non-negative ${key} value`); return; }
      nums[key] = v;
    }
    if (!skipDuplicateCheck) {
      try {
        const { mine } = await api('/me/foods');
        const dup = (mine || []).find((f) => f.name.trim().toLowerCase() === foodName.toLowerCase());
        if (dup) { setCustomDuplicate(dup); return; }
      } catch { /* lookup failure -- fall through and create normally rather than block on it */ }
    }
    setAdding(true);
    try { await onAddCustom({ name: foodName, ...nums }); setCustomForm(EMPTY_CUSTOM); setCustomDuplicate(null); setShowMoreMacros(false); }
    catch (e) { setCustomErr(e.message || 'Could not add that food'); }
    setAdding(false);
  };

  // "Use existing" -- add the ALREADY-SAVED food (by its real food_id, via
  // the same onAddFood path a search result uses) instead of creating a
  // duplicate `foods` row; its own stored macros are the source, never
  // whatever the user just typed into the form.
  const useDuplicateCustomFood = async () => {
    if (!customDuplicate) return;
    setAdding(true);
    try {
      await onAddFood({ id: customDuplicate.id, name: customDuplicate.name });
      setCustomForm(EMPTY_CUSTOM);
      setCustomDuplicate(null);
    } catch (e) { setCustomErr(e.message || 'Could not add that food'); }
    setAdding(false);
  };

  // Editing the form after a duplicate notice appears dismisses it -- the
  // notice was a judgment about the PREVIOUS name, not a permanent lock.
  const setCustomField = (key, value) => { setCustomForm((f) => ({ ...f, [key]: value })); setCustomErr(''); setCustomDuplicate(null); };

  const estimateWithAI = async () => {
    const query = q.trim();
    if (!query) return;
    setAiEstimating(true); setAiErr(''); setAiPreview(null);
    try {
      const res = await api('/me/foods/ai-estimate', { method: 'POST', body: JSON.stringify({ query }) });
      if (!res.ok) { setAiErr(res.reason || 'Could not produce an AI estimate.'); return; }
      setAiPreview(res);
      setAiGrams(String(res.serving?.estimated_weight_g || 100));
    } catch (e) {
      setAiErr(e.message || 'Could not produce an AI estimate.');
    }
    setAiEstimating(false);
  };

  const handleAddAI = async () => {
    if (!aiPreview) return;
    setAdding(true);
    try { await onAddAI(aiPreview, aiGrams); resetToBlank(); }
    catch (e) { setAiErr(e.message || 'Could not add that estimate'); }
    setAdding(false);
  };

  return (
    <div className="rounded-xl p-2.5 space-y-2" style={{ border: `1px solid ${t.border}` }}>
      <div className="flex gap-1.5 rounded-lg p-0.5" style={{ background: t.bg }}>
        {[['search', 'Search Food'], ['custom', 'Custom Macros']].map(([key, label]) => (
          <button key={key} onClick={() => { setMode(key); setCustomErr(''); setAddErr(''); setCustomDuplicate(null); setShowMoreMacros(false); }}
                  aria-pressed={mode === key}
                  className="flex-1 py-1 rounded-md font-grotesk text-[10px] font-semibold transition-colors"
                  style={mode === key ? { background: t.accent, color: 'var(--accent-contrast)' } : { color: t.mute }}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'custom' ? (
        <div className="space-y-2">
          <input value={customForm.name} onChange={(e) => setCustomField('name', e.target.value)}
                 placeholder="What's this food called?" className="input w-full !py-2 text-[12px]" />
          <div className="grid grid-cols-2 gap-1.5">
            {[['calories', 'Calories'], ['protein', 'Protein (g)'], ['carbs', 'Carbs (g)'], ['fat', 'Fat (g)']].map(([key, label]) => (
              <input key={key} type="number" min="0" step="any" value={customForm[key]}
                     onChange={(e) => setCustomField(key, e.target.value)}
                     placeholder={label} aria-label={label}
                     className="input w-full !py-1.5 text-[11px] tabular-nums" />
            ))}
          </div>
          {showMoreMacros ? (
            <div className="grid grid-cols-3 gap-1.5">
              {[['fiber', 'Fiber (g)'], ['sugar', 'Sugar (g)'], ['sodium', 'Sodium (mg)']].map(([key, label]) => (
                <input key={key} type="number" min="0" step="any" value={customForm[key]}
                       onChange={(e) => setCustomField(key, e.target.value)}
                       placeholder={label} aria-label={label}
                       className="input w-full !py-1.5 text-[10px] tabular-nums" />
              ))}
            </div>
          ) : (
            <button type="button" onClick={() => setShowMoreMacros(true)}
                    className="text-[10px] font-semibold underline-offset-2 hover:underline" style={{ color: t.mute }}>
              + Fiber, sugar, sodium (optional)
            </button>
          )}
          {customErr && <div className="text-[10px]" style={{ color: t.danger }}>{customErr}</div>}
          {customDuplicate ? (
            <div className="rounded-lg p-2.5 space-y-2" style={{ background: t.accentDim, border: `1px solid ${t.border}` }}>
              <div className="text-[10px]" style={{ color: t.ink }}>
                You already have a custom food named "{customDuplicate.name}".
              </div>
              <div className="flex gap-1.5">
                <button onClick={useDuplicateCustomFood} disabled={adding}
                        className="flex-1 py-1.5 rounded-lg font-grotesk text-[10px] font-bold" style={{ border: `1px solid ${t.border}`, color: t.ink }}>
                  Use existing
                </button>
                <button onClick={() => handleAddCustom(true)} disabled={adding}
                        className="flex-1 py-1.5 rounded-lg font-grotesk text-[10px] font-bold" style={{ background: t.accent, color: 'var(--accent-contrast)' }}>
                  {adding ? 'Adding…' : 'Create another'}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => handleAddCustom(false)} disabled={adding || !customForm.name.trim()}
                    className="w-full py-2 rounded-lg font-grotesk text-[11px] font-bold"
                    style={{ background: t.accent, color: 'var(--accent-contrast)', opacity: (adding || !customForm.name.trim()) ? 0.5 : 1 }}>
              {adding ? 'Adding…' : '+ Add to Meal'}
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <input value={q} onChange={(e) => { setQ(e.target.value); setAiPreview(null); setAiErr(''); setAddErr(''); }}
                 placeholder="Search food…" className="input w-full !py-2 text-[12px]" />
          {addErr && <div className="text-[10px] mt-1" style={{ color: t.danger }}>{addErr}</div>}
          {/* Recent (Part 40) -- only on this row's idle screen, before
              anything's typed, so it never competes with live results. */}
          {q.trim().length === 0 && recentFoods.length > 0 && (
            <div className="mt-1.5 space-y-1">
              <div className="text-[9px] uppercase tracking-[.14em]" style={{ color: t.faint }}>Recent</div>
              {recentFoods.map((r) => (
                <button key={r.name} onClick={() => quickAddRecent(r)} disabled={adding}
                        className="w-full text-left rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2" style={{ border: `1px dashed ${t.border}` }}>
                  <span className="min-w-0 truncate font-grotesk text-[11px] font-semibold" style={{ color: t.ink }}>{r.name}</span>
                  <span className="shrink-0 font-grotesk text-[9px]" style={{ color: t.mute }}>{Math.round(r.calories)} kcal</span>
                </button>
              ))}
            </div>
          )}
          {(searching || results.length > 0 || (!searching && q.trim().length >= 2)) && !aiPreview && (
            <div className="mt-1.5 space-y-1">
              {searching && !results.length && <div className="text-[10px] py-1" style={{ color: t.faint }}>Searching…</div>}
              {!searching && searchErr && (
                <div className="py-1 space-y-1">
                  <div className="text-[10px]" style={{ color: t.danger }}>{searchErr}</div>
                  <button onClick={() => setSearchRetryNonce((n) => n + 1)} className="text-[10px] font-semibold underline-offset-2 hover:underline" style={{ color: t.accent }}>
                    Try again
                  </button>
                </div>
              )}
              {!searching && !searchErr && !results.length && q.trim().length >= 2 && (
                <div className="text-[10px] py-1" style={{ color: t.faint }}>No close match found in SK OS for "{q.trim()}".</div>
              )}
              {results.map((f) => (
                <button key={f.id || f.source_id} onClick={() => handleAddFood(f)} disabled={adding}
                        className="w-full text-left rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2" style={{ border: `1px solid ${t.border}` }}>
                  <span className="min-w-0 truncate font-grotesk text-[11px] font-semibold" style={{ color: t.ink }}>{f.name}</span>
                  <span className="shrink-0 font-grotesk text-[9px]" style={{ color: t.mute }}>{f.calories == null ? '—' : Math.round(f.calories)} kcal/100g</span>
                </button>
              ))}
              {/* AI fallback in BOTH branches -- has-matches and zero-matches
                  -- exact original query, never the top result's name. */}
              {!searching && q.trim().length >= 2 && (
                <button onClick={estimateWithAI} disabled={aiEstimating}
                        className="w-full text-left rounded-lg px-2.5 py-1.5 flex items-center gap-2 font-grotesk text-[10px] font-semibold"
                        style={{ border: `1px dashed ${t.border}`, color: t.accent }}>
                  ✨ {aiEstimating ? 'Estimating…' : `Estimate "${q.trim()}" with AI`}
                </button>
              )}
              {aiErr && <div className="text-[10px]" style={{ color: t.danger }}>{aiErr}</div>}
            </div>
          )}

          {aiPreview && (
            <AIEstimateCard preview={aiPreview} grams={aiGrams} onGramsChange={setAiGrams}
                            onCancel={() => setAiPreview(null)} onAdd={handleAddAI} disabled={adding} t={t} />
          )}
        </div>
      )}
    </div>
  );
}

export { r1 };
