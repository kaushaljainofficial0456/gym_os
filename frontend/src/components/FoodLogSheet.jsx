/**
 * FOOD LOG SHEET — search → choose portion → (oil) → add.
 *                  OR barcode scan → confirm product → choose quantity → add.
 *
 * WHY A SHEET RATHER THAN MORE ROWS IN THE PICKER:
 * Logging a food is three decisions (which food, how much, how it was
 * cooked) and the old picker only asked the first, defaulting the rest
 * silently. Portion size is the single largest error source after picking
 * the wrong food entirely — "1 katori dal" is 150 g and "1 bowl" is 250 g,
 * a 66% difference on the same dish — so it deserves a real control, not
 * an assumption.
 *
 * WHAT IS DELIBERATELY *NOT* COMPUTED HERE:
 * grams, macros and the oil adjustment all come from the server
 * (`/me/foods/resolve`, or `/intel/foods/barcode/:code` for a scanned
 * product). Portion→grams depends on the food's own density and measured
 * serving weight, and the oil model applies the chosen level as a DELTA
 * from the dish's own recipe oil — so picking "low" on an already-oily
 * dish correctly *reduces* calories. Re-implementing either here is how
 * the UI and the model start disagreeing, which is exactly the class of
 * bug that made the old estimator untrustworthy.
 *
 * BARCODE PATH: a scanned/looked-up product is an EXACT match (CONTRACT
 * §3.6) with no portion catalogue of its own — it defines its own serving.
 * It therefore gets its own confirm screen (image/brand/serving/full
 * macros incl. fiber/sugar/sodium/ingredients) rather than being forced
 * through the name-search portion picker below, which does not understand
 * a barcode's `source_id` shape and would silently mis-resolve it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Pressable } from '../design/index.js';
import Icon from './Icon.jsx';
import BarcodeScanner from './BarcodeScanner.jsx';

const OIL_LEVELS = [
  ['none', 'None'],
  ['low', 'Low'],
  ['moderate', 'Moderate'],
  ['high', 'High'],
  ['very_high', 'Very high'],
];

/** Portion groups, in the order a person actually reaches for them. */
const GROUP_ORDER = ['count', 'bowl', 'plate', 'glass', 'spoon', 'misc'];

const EMPTY_MANUAL = {
  name: '', brand: '', servingGrams: '', servingLabel: '',
  calories: '', protein: '', carbs: '', fat: '', fiber: '', sugar: '', sodium: '',
};

/** Round for display only — never re-used as an input to further math. */
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export default function FoodLogSheet({ open, onClose, onAdd, autoScan = false }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  // Tier 3 (kNN similarity fallback) -- GET /foods/search already includes
  // this alongside an empty `foods` array (see foodEstimator.js's
  // estimateFoodKnn); it's free, local and instant (no AI call), so it's
  // offered before "Estimate with AI" rather than only after. No source_id
  // (it's a synthesized estimate, not a real matched row) and no portion
  // catalogue, so quantity is a plain editable grams field, scaled
  // client-side from the SAME per-100g fields the backend already
  // computed -- identical math to scaleNutrition(), not a new formula.
  const [knnEstimate, setKnnEstimate] = useState(null);
  const [knnGrams, setKnnGrams] = useState('100');
  const [knnLogging, setKnnLogging] = useState(false);
  const [food, setFood] = useState(null);
  const [portionKey, setPortionKey] = useState(null);
  const [count, setCount] = useState(1);
  const [grams, setGrams] = useState('');
  const [oil, setOil] = useState(null);
  const [resolved, setResolved] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [listening, setListening] = useState(false);
  // Tier 4 (food-AI) -- reached only when the user explicitly asks for it
  // after a name search comes back empty, never automatically. See
  // backend/src/services/intelligence/foodAI.js for why: cost, latency and
  // trust all argue against calling AI on every miss while someone is
  // still typing.
  const [aiEstimating, setAiEstimating] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiErr, setAiErr] = useState('');
  const [aiLogging, setAiLogging] = useState(false);
  // User-adjustment flow: `aiEdits[i]` holds { estimated_weight_g?, removed? }
  // for component i, aligned by index to aiResult.components. `aiAdjusted` is
  // the backend's deterministic recompute of the edited components -- never
  // a second AI call. null means "no edits yet, show the AI's own totals".
  const [aiEdits, setAiEdits] = useState([]);
  const [aiAdjusted, setAiAdjusted] = useState(null);
  const [aiAdjusting, setAiAdjusting] = useState(false);
  const inputRef = useRef(null);

  // ── barcode scan state ──
  const [barcodeItem, setBarcodeItem] = useState(null);       // food-v1 envelope from a scan or a manual save
  const [barcodeGrams, setBarcodeGrams] = useState('');
  const [barcodeResolved, setBarcodeResolved] = useState(null); // re-scaled envelope as barcodeGrams changes
  const [barcodeErr, setBarcodeErr] = useState('');
  const [manualAdd, setManualAdd] = useState(false);
  const [manualBarcode, setManualBarcode] = useState('');
  const [manualForm, setManualForm] = useState(EMPTY_MANUAL);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualErr, setManualErr] = useState('');
  // AI/OCR label-read fallback (existing backend endpoint, POST
  // /intel/label-scan — previously built but never wired into any live
  // screen). Offered as a faster alternative to typing every field by
  // hand; every extracted value still lands in the same editable form
  // below and nothing is saved until the user reviews and submits it.
  const [labelScanning, setLabelScanning] = useState(false);
  const [labelNote, setLabelNote] = useState('');
  const labelFileRef = useRef(null);

  const startVoice = () => {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) { setErr('Voice input not available on this device'); return; }
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setListening(true);
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      setQ(text);
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  };

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 120);
      if (autoScan) setScanning(true);
    }
    if (!open) {
      setQ(''); setResults([]); setFood(null); setResolved(null);
      setPortionKey(null); setCount(1); setGrams(''); setOil(null); setErr('');
      setBarcodeItem(null); setBarcodeGrams(''); setBarcodeResolved(null); setBarcodeErr('');
      setManualAdd(false); setManualBarcode(''); setManualForm(EMPTY_MANUAL); setManualErr('');
      setLabelScanning(false); setLabelNote('');
      setAiResult(null); setAiErr(''); setAiEstimating(false);
      setKnnEstimate(null); setKnnGrams('100'); setKnnLogging(false);
    }
  }, [open, autoScan]);

  // Type-ahead. Debounced so a fast typist does not fire a request per key.
  useEffect(() => {
    const term = q.trim();
    if (food || term.length < 2) { setResults([]); setKnnEstimate(null); setSearching(false); return undefined; }
    setSearching(true);
    let dead = false;
    const h = setTimeout(() => {
      api(`/me/foods/search?q=${encodeURIComponent(term)}`)
        .then((r) => {
          if (dead) return;
          setResults(r.foods || []);
          setKnnEstimate(r.knn_estimate || null);
          setKnnGrams('100');
        })
        .catch(() => { if (!dead) { setResults([]); setKnnEstimate(null); } })
        .finally(() => { if (!dead) setSearching(false); });
    }, 200);
    return () => { dead = true; clearTimeout(h); };
  }, [q, food]);

  // Ask the server for grams + macros whenever the quantity changes.
  useEffect(() => {
    if (!food) { setResolved(null); return undefined; }
    let dead = false;
    const h = setTimeout(() => {
      api('/me/foods/resolve', {
        method: 'POST',
        body: JSON.stringify({
          source_id: food.source_id, name: food.name,
          portion_key: portionKey || undefined,
          count: Number(count) || 1,
          grams: grams ? Number(grams) : undefined,
          oil_level: oil || undefined,
        }),
      })
        .then((r) => { if (!dead) { setResolved(r); setErr(''); } })
        .catch((e) => { if (!dead) { setResolved(null); setErr(e.message || 'Could not price that quantity'); } });
    }, 120);
    return () => { dead = true; clearTimeout(h); };
  }, [food, portionKey, count, grams, oil]);

  // Re-scale a scanned/saved barcode product as its quantity (in grams)
  // changes. Hits the SAME lookup endpoint with a `servings` multiplier
  // derived from the product's own serving size -- the product is already
  // cached (this is the request that cached it, or a save that just wrote
  // it), so this is a single indexed DB read, never a second external call.
  useEffect(() => {
    if (!barcodeItem) { setBarcodeResolved(null); return undefined; }
    const g = Number(barcodeGrams);
    if (!(g > 0)) { setBarcodeResolved(null); return undefined; }
    let dead = false;
    const perServing = barcodeItem.quantity.serving_grams_each || 100;
    const servings = g / perServing;
    const h = setTimeout(() => {
      api(`/intel/foods/barcode/${encodeURIComponent(barcodeItem.food.barcode)}?servings=${servings}`)
        .then((r) => { if (!dead) { setBarcodeResolved(r); setBarcodeErr(''); } })
        .catch((e) => { if (!dead) { setBarcodeResolved(null); setBarcodeErr(e.message || 'Could not price that quantity'); } });
    }, 150);
    return () => { dead = true; clearTimeout(h); };
  }, [barcodeItem, barcodeGrams]);

  const groups = useMemo(() => {
    const ps = food?.portions || [];
    const by = {};
    for (const p of ps) (by[p.group] ||= []).push(p);
    return GROUP_ORDER.filter((g) => by[g]?.length).map((g) => [g, by[g]]);
  }, [food]);

  // Total logged weight for the AI estimate -- sums CURRENT (post-edit,
  // server-recomputed) component grams, the same values already driving
  // each row's own grams input, so this always matches what "Log it" will
  // actually save. serving.description alone ("1 plate") never told the
  // user how much that plate now weighs after they'd doubled the rice.
  const aiTotalGrams = useMemo(() => {
    if (!aiResult?.components?.length) return 0;
    return aiResult.components.reduce((sum, c, i) => {
      if (aiEdits[i]?.removed) return sum;
      const shown = aiAdjusted?.components?.[i] || c;
      return sum + (Number(shown.estimated_weight_g) || 0);
    }, 0);
  }, [aiResult, aiAdjusted, aiEdits]);

  if (!open) return null;

  const pick = (f) => {
    setFood(f);
    setResults([]);
    setKnnEstimate(null);
    // Default to the food's own serving when it has one, else grams entry.
    const first = (f.portions || []).find((p) => p.basis === 'serving')
      || (f.portions || []).find((p) => p.group === 'bowl')
      || (f.portions || [])[0];
    setPortionKey(first?.key || null);
    if (!first) setGrams('100');
  };

  const backToSearch = () => {
    setFood(null); setResolved(null);
    setBarcodeItem(null); setBarcodeResolved(null); setBarcodeErr('');
  };

  const commit = async () => {
    const isBarcode = !!barcodeItem;
    const totals = isBarcode ? (barcodeResolved?.totals || barcodeItem.totals) : resolved?.totals;
    const name = isBarcode ? barcodeItem.food.food_name : food?.name;
    // The backend already refuses to hand back a barcode "hit" with no
    // verified energy value (see barcodeLookup.js) -- this is a second,
    // independent check, not a trust of that guarantee: without it, a
    // totals object whose fields are all null would still pass the
    // `!totals` check below (it's a truthy object) and silently log as
    // 0 kcal / 0g everything, which is indistinguishable from an
    // accurate zero-calorie entry.
    if (!totals || !name || totals.energy_kcal == null) {
      if (isBarcode && totals && totals.energy_kcal == null) {
        setBarcodeErr('No verified nutrition data for this product — use "Add manually" instead.');
      }
      return;
    }
    setBusy(true);
    try {
      await onAdd({
        name,
        calories: Math.round(totals.energy_kcal ?? 0),
        protein: totals.protein_g ?? 0,
        carbs: totals.carb_g ?? 0,
        fat: totals.fat_g ?? 0,
      });
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not add that food');
    }
    setBusy(false);
  };

  // Tier 3: log the kNN estimate at the user's chosen grams. Purely local
  // arithmetic -- no server round-trip needed, since the response already
  // carries per-100g values and this is the SAME grams/100 scaling
  // scaleNutrition() does everywhere else, not a new formula.
  const commitKnn = async () => {
    if (!knnEstimate) return;
    const g = Number(knnGrams);
    if (!(g > 0)) { setErr('Enter a valid amount in grams'); return; }
    const factor = g / 100;
    setKnnLogging(true);
    try {
      await onAdd({
        name: knnEstimate.food_name,
        calories: Math.round((knnEstimate.energy_kcal || 0) * factor),
        protein: Math.round((knnEstimate.protein_g || 0) * factor * 10) / 10,
        carbs: Math.round((knnEstimate.carb_g || 0) * factor * 10) / 10,
        fat: Math.round((knnEstimate.fat_g || 0) * factor * 10) / 10,
        source: 'knn_estimated',
      });
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not add that food');
    }
    setKnnLogging(false);
  };

  const estimateWithAI = async () => {
    const query = q.trim();
    if (!query) return;
    setAiEstimating(true); setAiErr(''); setAiResult(null); setAiEdits([]); setAiAdjusted(null);
    try {
      const res = await api('/me/foods/ai-estimate', { method: 'POST', body: JSON.stringify({ query }) });
      if (!res.ok) { setAiErr(res.reason || 'Could not produce an AI estimate.'); return; }
      setAiResult(res);
      setAiEdits((res.components || []).map(() => null));
    } catch (e) {
      setAiErr(e.message || 'Could not produce an AI estimate.');
    }
    setAiEstimating(false);
  };

  // Deterministic recompute after a user edit -- NEVER a second AI call.
  // Debounced per-keystroke via the caller (onBlur/onChange with a small
  // delay) so it doesn't fire a request per digit typed.
  const recomputeAI = async (nextEdits) => {
    if (!aiResult?.components?.length) return;
    setAiAdjusting(true);
    try {
      const res = await api('/me/foods/ai-estimate/adjust', {
        method: 'POST',
        body: JSON.stringify({
          components: aiResult.components,
          edits: nextEdits,
          is_branded_or_restaurant: !!aiResult.is_branded_or_restaurant,
        }),
      });
      setAiAdjusted(res);
    } catch (e) {
      setAiErr(e.message || 'Could not recalculate that change');
    }
    setAiAdjusting(false);
  };

  const editComponentGrams = (i, value) => {
    const next = aiEdits.slice();
    const grams = value === '' ? null : Number(value);
    next[i] = { ...(next[i] || {}), estimated_weight_g: Number.isFinite(grams) ? grams : undefined };
    setAiEdits(next);
  };

  const commitComponentEdit = (i) => {
    // Only send a real recompute once the field actually differs from what
    // was last sent, so tabbing through untouched inputs doesn't fire
    // requests. `null` estimated_weight_g/undefined -> falls back to no-op.
    const edit = aiEdits[i];
    if (edit && edit.estimated_weight_g != null) recomputeAI(aiEdits);
  };

  const removeComponent = (i) => {
    const next = aiEdits.slice();
    next[i] = { ...(next[i] || {}), removed: true };
    setAiEdits(next);
    recomputeAI(next);
  };

  const resetAIAdjustments = () => {
    setAiEdits((aiResult?.components || []).map(() => null));
    setAiAdjusted(null);
  };

  const commitAI = async () => {
    if (!aiResult) return;
    const adjusted = !!aiAdjusted;
    const totals = adjusted ? aiAdjusted.totals : aiResult.totals;
    setAiLogging(true);
    try {
      await onAdd({
        name: aiResult.food_name,
        calories: Math.round(totals.calories ?? 0),
        protein: totals.protein ?? 0,
        carbs: totals.carbs ?? 0,
        fat: totals.fat ?? 0,
        // Provenance: never "measured", never plain "manual" -- see the
        // source enum in backend/src/validate.js. Nutrition.jsx's onAdd
        // must pass these through rather than hardcoding source: 'manual'.
        // A user-edited quantity gets its own source value so it's visibly
        // distinct from an unmodified AI estimate, per the adjustment-flow
        // provenance rule.
        source: adjusted ? 'ai_estimated_user_adjusted' : 'ai_estimated',
        ai_provider: aiResult.ai?.provider || null,
        ai_model: aiResult.ai?.model || null,
        ai_confidence: adjusted ? aiAdjusted.confidence : aiResult.confidence,
      });
      onClose();
    } catch (e) {
      setAiErr(e.message || 'Could not add that food');
    }
    setAiLogging(false);
  };

  const setManualField = (key, value) => setManualForm((f) => ({ ...f, [key]: value }));

  const submitManual = async () => {
    setManualErr('');
    const mf = manualForm;
    if (!mf.name.trim()) { setManualErr('Product name is required'); return; }
    if (!(Number(mf.servingGrams) > 0)) { setManualErr('Serving size (in grams) is required'); return; }
    if (!(Number(mf.calories) >= 0)) { setManualErr('Calories are required'); return; }
    setManualBusy(true);
    try {
      const item = await api(`/intel/foods/barcode/${encodeURIComponent(manualBarcode)}/manual`, {
        method: 'POST',
        body: JSON.stringify({
          name: mf.name.trim(),
          brand: mf.brand.trim() || undefined,
          serving_grams: Number(mf.servingGrams),
          serving_label: mf.servingLabel.trim() || undefined,
          calories: Number(mf.calories) || 0,
          protein: Number(mf.protein) || 0,
          carbs: Number(mf.carbs) || 0,
          fat: Number(mf.fat) || 0,
          fiber: mf.fiber !== '' ? Number(mf.fiber) : undefined,
          sugar: mf.sugar !== '' ? Number(mf.sugar) : undefined,
          sodium: mf.sodium !== '' ? Number(mf.sodium) : undefined,
        }),
      });
      setManualAdd(false);
      setManualForm(EMPTY_MANUAL);
      setBarcodeItem(item);
      setBarcodeGrams(String(item.quantity.grams));
    } catch (e) {
      setManualErr(e.message || 'Could not save that product');
    }
    setManualBusy(false);
  };

  const openManualAdd = (code) => {
    setManualBarcode(code || '');
    setManualForm((f) => ({ ...f, name: '' }));
    setManualAdd(true);
  };

  // AI/OCR fallback for a barcode miss: read a photo of the label into the
  // SAME editable fields the fully-manual form below uses, via the
  // existing POST /intel/label-scan (vision-model extraction when an AI
  // provider is configured, otherwise an explicit "enter manually" note --
  // never a guess). Nothing is saved here; submitManual still owns that,
  // so every OCR'd value gets the same user review before it's persisted
  // or logged as this app's "Do not fabricate nutrition data" rule requires.
  const scanLabel = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(file.type)) { setLabelNote('Please choose a PNG, JPEG, WebP or GIF image'); return; }
    if (file.size > 5 * 1024 * 1024) { setLabelNote('Image too large (max 5 MB)'); return; }
    setLabelScanning(true);
    setLabelNote('');
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      const r = await api('/intel/label-scan', { method: 'POST', body: JSON.stringify({ image: b64 }) });
      const f = r.fields || {};
      // Only pre-fill grams when the label's own unit is actually a mass
      // unit -- OCR reading "1 bar" as the serving would otherwise silently
      // become "1 g", which is exactly the kind of fabricated number this
      // form exists to avoid. Anything else is left for the user to type.
      const massUnit = /^(g|gram|grams|gm|gms)$/i.test(f.unit || '');
      setManualForm((prev) => ({
        ...prev,
        name: f.name || prev.name,
        brand: f.brand || prev.brand,
        servingGrams: massUnit && f.serving_size ? f.serving_size : prev.servingGrams,
        servingLabel: f.serving_size ? `${f.serving_size} ${f.unit || ''}`.trim() : prev.servingLabel,
        calories: f.calories || prev.calories,
        protein: f.protein || prev.protein,
        carbs: f.carbs || prev.carbs,
        fat: f.fat || prev.fat,
        fiber: f.fiber || prev.fiber,
        sugar: f.sugar || prev.sugar,
        sodium: f.sodium || prev.sodium,
      }));
      setLabelNote(r.note || 'Extracted from the label — review every value before saving.');
    } catch (e) {
      setLabelNote(e.message || 'Could not read that label — enter the values manually.');
    }
    setLabelScanning(false);
  };

  const bc = barcodeResolved || barcodeItem;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
         style={{ background: 'rgb(var(--bg-rgb) / .72)', backdropFilter: 'blur(4px)' }}
         onClick={onClose}>
      <div className="card w-full sm:max-w-md max-h-[88vh] overflow-y-auto rounded-b-none sm:rounded-2xl"
           onClick={(e) => e.stopPropagation()}>

        <div className="sticky top-0 z-10 px-4 pt-4 pb-3" style={{ background: 'var(--panel)' }}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>
              {barcodeItem ? 'Confirm product' : manualAdd ? 'Add product manually' : food ? 'How much?' : aiResult ? 'AI estimate' : 'Add food'}
            </div>
            <button onClick={onClose} aria-label="Close" style={{ color: 'var(--mute)' }}>✕</button>
          </div>

          {!food && !barcodeItem && !manualAdd && !aiResult && (
            <>
            <div className="mt-2 flex gap-2">
              <input
                ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Search any food…" aria-label="Search foods"
                className="input flex-1 !py-2.5 text-[14px]" />
              <Pressable onClick={startVoice} aria-label="Voice input"
                         className={`btn !px-3 !py-2.5 shrink-0 ${listening ? 'btn-primary' : ''}`}>
                <Icon name="mic" size={17} />
              </Pressable>
              <Pressable onClick={() => setScanning(true)} aria-label="Scan barcode"
                         className="btn !px-3 !py-2.5 shrink-0">
                <Icon name="camera" size={17} />
              </Pressable>
            </div>
            {listening && <div className="text-[10px] mt-1.5 anim-pulse-soft" style={{ color: 'var(--accent)' }}>Listening…</div>}
            </>
          )}
        </div>

        <div className="px-4 pb-4">
          {/* ── search results ── */}
          {!food && !barcodeItem && !manualAdd && !aiResult && (
            <div className="space-y-1">
              {searching && !results.length && (
                <div className="text-[11px] py-3" style={{ color: 'var(--faint)' }}>Searching…</div>
              )}
              {!searching && q.trim().length >= 2 && !results.length && (
                <div className="py-3 space-y-2">
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
                    Nothing matched “{q.trim()}”.
                  </div>

                  {/* Tier 3 -- free, instant, no AI call. Offered first since
                      it costs nothing and needs no round-trip beyond the
                      search itself; "Estimate with AI" stays available right
                      below for when this isn't a good enough match. */}
                  {knnEstimate && (
                    <div className="rounded-xl px-3 py-2.5 space-y-2" style={{ border: '1px solid var(--line)' }}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{knnEstimate.food_name}</div>
                          <div className="text-[10px]" style={{ color: 'var(--faint)' }}>
                            similar to “{knnEstimate.matched_neighbor}” · {Math.round((knnEstimate.top_similarity || 0) * 100)}% match
                          </div>
                        </div>
                        <span className="text-[9px] uppercase tracking-[.14em] font-semibold px-2 py-1 rounded-full shrink-0"
                              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                          estimated
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number" min="0" step="1" value={knnGrams}
                            onChange={(e) => setKnnGrams(e.target.value)}
                            aria-label="Grams"
                            className="w-16 text-[12px] rounded px-1.5 py-1 tabular-nums"
                            style={{ background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--ink)' }}
                          />
                          <span className="text-[11px]" style={{ color: 'var(--faint)' }}>g</span>
                        </div>
                        <div className="text-right">
                          <div className="font-bold text-[15px] tabular-nums" style={{ color: 'var(--ink)' }}>
                            ~{Math.round((knnEstimate.energy_kcal || 0) * (Number(knnGrams) || 0) / 100)} kcal
                          </div>
                          <div className="text-[10px]" style={{ color: 'var(--mute)' }}>
                            P {r1((knnEstimate.protein_g || 0) * (Number(knnGrams) || 0) / 100)} ·
                            C {r1((knnEstimate.carb_g || 0) * (Number(knnGrams) || 0) / 100)} ·
                            F {r1((knnEstimate.fat_g || 0) * (Number(knnGrams) || 0) / 100)}
                          </div>
                        </div>
                      </div>
                      <div className="text-[10px] leading-relaxed" style={{ color: 'var(--faint)' }}>{knnEstimate.disclaimer}</div>
                      <Pressable onClick={commitKnn} disabled={knnLogging || !(Number(knnGrams) > 0)}
                                 className="btn-primary w-full !py-2 text-[12px] font-bold">
                        {knnLogging ? 'Adding…' : 'Log it'}
                      </Pressable>
                    </div>
                  )}

                  <Pressable onClick={estimateWithAI} disabled={aiEstimating}
                             className="btn w-full !py-2.5 text-[12px] font-semibold flex items-center justify-center gap-2">
                    <Icon name="robot" size={15} />
                    {aiEstimating ? 'Estimating…' : knnEstimate ? 'Not quite right? Estimate with AI' : 'Estimate with AI'}
                  </Pressable>
                  {aiErr && <div className="text-[11px]" style={{ color: 'var(--bad)' }}>{aiErr}</div>}
                </div>
              )}
              {results.map((f) => (
                <button key={f.id || f.source_id} onClick={() => pick(f)}
                        disabled={f.trustworthy === false}
                        className="w-full text-left rounded-xl px-3 py-2 flex items-center justify-between gap-2 disabled:opacity-45"
                        style={{ border: '1px solid var(--line)' }}>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{f.name}</span>
                    <span className="text-[10px]" style={{ color: 'var(--mute)' }}>
                      {f.trustworthy === false
                        ? (f.data_quality_flag || 'Data quality flagged')
                        : `${f.calories == null ? '—' : Math.round(f.calories)} kcal / 100 g`}
                      {f.brand ? ` · ${f.brand}` : ''}
                    </span>
                  </span>
                  {f.confidence && f.confidence !== 'high' && (
                    <span className="text-[8px] uppercase tracking-wider shrink-0" style={{ color: 'var(--faint)' }}>
                      {f.confidence}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* ── AI estimate (Tier 4) review ── */}
          {aiResult && (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[15px] font-bold truncate" style={{ color: 'var(--ink)' }}>{aiResult.food_name}</div>
                  {aiResult.cuisine && <div className="text-[11px]" style={{ color: 'var(--mute)' }}>{aiResult.cuisine}</div>}
                </div>
                <span className="text-[9px] uppercase tracking-[.14em] font-semibold px-2 py-1 rounded-full shrink-0"
                      style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                  AI estimate{aiResult.from_cache ? ' · reused' : ''}
                </span>
              </div>

              <div className="text-[11px] leading-relaxed" style={{ color: 'var(--mute)' }}>{aiResult.disclaimer}</div>

              {/* Totals + uncertainty range -- never a bare confident number.
                  Once the user edits a component, these are the DETERMINISTIC
                  recompute, not the AI's original total -- never blindly
                  trusted past an edit. */}
              <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--accent-soft)', border: '1px solid var(--line)' }}>
                <div className="flex items-baseline justify-between">
                  <span className="font-black text-[22px] tabular-nums" style={{ color: 'var(--ink)' }}>
                    ~{Math.round((aiAdjusted || aiResult).totals.calories)}
                  </span>
                  <span className="text-[11px] tabular-nums" style={{ color: 'var(--mute)' }}>
                    likely {Math.round((aiAdjusted || aiResult).uncertainty.calories_low)}–{Math.round((aiAdjusted || aiResult).uncertainty.calories_high)} kcal
                  </span>
                </div>
                <div className="text-[10px] mt-1" style={{ color: 'var(--mute)' }}>
                  P {r1((aiAdjusted || aiResult).totals.protein)} · C {r1((aiAdjusted || aiResult).totals.carbs)} · F {r1((aiAdjusted || aiResult).totals.fat)}
                  {' · '}
                  <span className="font-semibold" style={{ color: 'var(--ink)' }}>{Math.round(aiTotalGrams)}g total</span>
                  {aiResult.serving?.description ? ` (${aiResult.serving.description})` : ''}
                </div>
                {aiAdjusted && (
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[9px] uppercase tracking-[.12em]" style={{ color: 'var(--accent)' }}>
                      recalculated from your edits
                    </span>
                    <button onClick={resetAIAdjustments} className="text-[9px] underline" style={{ color: 'var(--mute)' }}>
                      reset to AI estimate
                    </button>
                  </div>
                )}
              </div>

              {/* Component breakdown -- shows how much of the estimate is
                  grounded in real measured data vs. an AI guess. Grams are
                  EDITABLE: serving size, an individual ingredient, or oil
                  quantity, per the adjustment-flow spec. A recompute is
                  deterministic (scaleNutrition against the real matched
                  food, or the component's own implied density) -- never a
                  second AI call. */}
              {aiResult.components?.length > 0 && (
                <div className="space-y-1">
                  {aiResult.components.map((c, i) => {
                    if (aiEdits[i]?.removed) return null;
                    const shown = aiAdjusted?.components?.[i] || c;
                    const editedValue = aiEdits[i]?.estimated_weight_g;
                    const gramsValue = editedValue != null ? editedValue : shown.estimated_weight_g;
                    return (
                      <div key={i} className="flex items-center gap-2 text-[11px] rounded-lg px-2.5 py-1.5" style={{ background: 'var(--glass, rgba(128,128,128,.05))' }}>
                        <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--ink)' }}>
                          {c.name}
                          {shown.db_grounded === false && (
                            <span className="ml-1" style={{ color: 'var(--faint)' }} title="Not matched to a measured food -- AI-guessed macros">*</span>
                          )}
                        </span>
                        <input
                          type="number" min="0" step="1" value={gramsValue}
                          onChange={(e) => editComponentGrams(i, e.target.value)}
                          onBlur={() => commitComponentEdit(i)}
                          aria-label={`${c.name} grams`}
                          className="w-14 text-right text-[11px] rounded px-1 py-0.5 tabular-nums"
                          style={{ background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--ink)' }}
                        />
                        <span className="shrink-0" style={{ color: 'var(--faint)' }}>g</span>
                        <span className="shrink-0 tabular-nums w-14 text-right" style={{ color: 'var(--mute)' }}>{Math.round(shown.calories)} kcal</span>
                        <button onClick={() => removeComponent(i)} aria-label={`Remove ${c.name}`}
                                className="shrink-0 opacity-50 hover:opacity-100" style={{ color: 'var(--bad)' }}>
                          ✕
                        </button>
                      </div>
                    );
                  })}
                  {aiAdjusting && <div className="text-[10px]" style={{ color: 'var(--faint)' }}>Recalculating…</div>}
                </div>
              )}

              {aiResult.assumptions?.length > 0 && (
                <div className="text-[10px] leading-relaxed" style={{ color: 'var(--faint)' }}>
                  <span className="uppercase tracking-[.12em]" style={{ color: 'var(--mute)' }}>Assumptions: </span>
                  {aiResult.assumptions.join(' · ')}
                </div>
              )}

              {aiErr && <div className="text-[11px]" style={{ color: 'var(--bad)' }}>{aiErr}</div>}

              <div className="flex gap-2">
                <button onClick={() => { setAiResult(null); setAiErr(''); setAiEdits([]); setAiAdjusted(null); }}
                        className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold" style={{ border: '1px solid var(--line)', color: 'var(--mute)' }}>
                  Close
                </button>
                <Pressable onClick={commitAI} disabled={aiLogging} className="flex-1 btn-primary !py-2.5 text-[12px] font-bold">
                  {aiLogging ? 'Adding…' : 'Log it'}
                </Pressable>
              </div>
            </div>
          )}

          {/* ── barcode product confirm ── */}
          {barcodeItem && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                {barcodeItem.food.image_url && (
                  <img src={barcodeItem.food.image_url} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0"
                       style={{ border: '1px solid var(--line)' }} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-bold truncate" style={{ color: 'var(--ink)' }}>{barcodeItem.food.food_name}</div>
                  {barcodeItem.food.brand && (
                    <div className="text-[11px] truncate" style={{ color: 'var(--mute)' }}>{barcodeItem.food.brand}</div>
                  )}
                  <div className="text-[10px] mt-1" style={{ color: 'var(--faint)' }}>
                    Serving: {barcodeItem.food.serving_size_label || `${barcodeItem.quantity.serving_grams_each} g`}
                  </div>
                  <button onClick={backToSearch} className="text-[10px] underline mt-1" style={{ color: 'var(--mute)' }}>
                    change food
                  </button>
                </div>
              </div>

              {barcodeItem.notes?.length > 0 && (
                <div className="text-[10px] rounded-lg px-3 py-2" style={{ background: 'var(--warn-soft, rgba(234,179,8,.1))', color: 'var(--warn, #b45309)' }}>
                  {barcodeItem.notes[0]}
                </div>
              )}

              {/* Per-serving reference numbers */}
              <div className="rounded-xl px-3 py-2.5 grid grid-cols-4 gap-2 text-center"
                   style={{ border: '1px solid var(--line)' }}>
                {[
                  ['kcal', barcodeItem.food.energy_kcal],
                  ['protein', barcodeItem.food.protein_g],
                  ['carbs', barcodeItem.food.carb_g],
                  ['fat', barcodeItem.food.fat_g],
                ].map(([label, v]) => (
                  <div key={label}>
                    <div className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{v == null ? '—' : r1(v)}</div>
                    <div className="text-[8px] uppercase tracking-[.12em]" style={{ color: 'var(--faint)' }}>{label}</div>
                  </div>
                ))}
              </div>
              {(barcodeItem.food.fiber_g != null || barcodeItem.food.sugar_g != null || barcodeItem.food.sodium_mg != null) && (
                <div className="text-[10px]" style={{ color: 'var(--mute)' }}>
                  {barcodeItem.food.fiber_g != null && <>Fiber {r1(barcodeItem.food.fiber_g)}g</>}
                  {barcodeItem.food.sugar_g != null && <>{barcodeItem.food.fiber_g != null ? ' · ' : ''}Sugar {r1(barcodeItem.food.sugar_g)}g</>}
                  {barcodeItem.food.sodium_mg != null && <>{(barcodeItem.food.fiber_g != null || barcodeItem.food.sugar_g != null) ? ' · ' : ''}Sodium {r1(barcodeItem.food.sodium_mg)}mg</>}
                  {' '}(per {barcodeItem.food.serving_size_label || `${barcodeItem.quantity.serving_grams_each}g`})
                </div>
              )}
              {barcodeItem.food.ingredients_text && (
                <div className="text-[10px] leading-relaxed" style={{ color: 'var(--faint)' }}>
                  <span className="uppercase tracking-[.12em]" style={{ color: 'var(--mute)' }}>Ingredients: </span>
                  {barcodeItem.food.ingredients_text}
                </div>
              )}

              <label className="block">
                <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Quantity (g)</span>
                <input type="number" min="1" step="1" value={barcodeGrams}
                       onChange={(e) => setBarcodeGrams(e.target.value)}
                       className="input w-full !py-2 mt-1 tabular-nums" aria-label="Quantity in grams" />
              </label>

              {/* Calculated totals for the entered quantity. */}
              <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--accent-soft)', border: '1px solid var(--line)' }}>
                {bc?.totals ? (
                  <>
                    <div className="flex items-baseline justify-between">
                      <span className="font-black text-[22px] tabular-nums" style={{ color: 'var(--ink)' }}>
                        {bc.totals.energy_kcal == null ? '—' : Math.round(bc.totals.energy_kcal)}
                      </span>
                      <span className="text-[11px] tabular-nums" style={{ color: 'var(--mute)' }}>
                        {bc.quantity.grams} g
                      </span>
                    </div>
                    <div className="text-[10px] mt-1" style={{ color: 'var(--mute)' }}>
                      P {r1(bc.totals.protein_g) ?? '—'} · C {r1(bc.totals.carb_g) ?? '—'} · F {r1(bc.totals.fat_g) ?? '—'}
                    </div>
                  </>
                ) : (
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>{barcodeErr || 'Working it out…'}</div>
                )}
              </div>

              <Pressable onClick={commit} disabled={!bc?.totals || bc.totals.energy_kcal == null || busy}
                         className="btn-primary w-full !py-3.5 text-[13px] font-bold">
                {busy ? 'Adding…' : 'Log Food'}
              </Pressable>
            </div>
          )}

          {/* ── add product manually (barcode not found) ── */}
          {manualAdd && (
            <div className="space-y-3">
              <div className="text-[11px]" style={{ color: 'var(--mute)' }}>
                {manualBarcode
                  ? <>Barcode <span className="tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>{manualBarcode}</span> isn’t in the database. Enter what’s on the pack and it’ll be saved for next time.</>
                  : 'Enter the details from the pack.'}
              </div>

              <input ref={labelFileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
                     onChange={(e) => scanLabel(e.target.files?.[0])} />
              <Pressable onClick={() => labelFileRef.current?.click()} disabled={labelScanning}
                         className="btn w-full !py-2.5 text-[12px] font-semibold flex items-center justify-center gap-2">
                <Icon name="camera" size={15} />
                {labelScanning ? 'Reading label…' : 'Scan the label instead'}
              </Pressable>
              {labelNote && (
                <div className="text-[10px]" style={{ color: 'var(--mute)' }}>{labelNote}</div>
              )}
              <div className="text-[9px] uppercase tracking-[.16em] text-center" style={{ color: 'var(--faint)' }}>or enter it yourself</div>

              <label className="block">
                <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Barcode</span>
                <input value={manualBarcode} onChange={(e) => setManualBarcode(e.target.value.replace(/\D/g, ''))}
                       inputMode="numeric" className="input w-full !py-2 mt-1 tabular-nums" aria-label="Barcode" />
              </label>
              <label className="block">
                <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Product name *</span>
                <input value={manualForm.name} onChange={(e) => setManualField('name', e.target.value)}
                       className="input w-full !py-2 mt-1" aria-label="Product name" />
              </label>
              <label className="block">
                <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Brand</span>
                <input value={manualForm.brand} onChange={(e) => setManualField('brand', e.target.value)}
                       className="input w-full !py-2 mt-1" aria-label="Brand" />
              </label>
              <div className="flex gap-3">
                <label className="flex-1">
                  <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Serving size (g) *</span>
                  <input type="number" min="1" step="1" value={manualForm.servingGrams}
                         onChange={(e) => setManualField('servingGrams', e.target.value)}
                         className="input w-full !py-2 mt-1 tabular-nums" aria-label="Serving size in grams" />
                </label>
                <label className="flex-1">
                  <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Serving label</span>
                  <input value={manualForm.servingLabel} onChange={(e) => setManualField('servingLabel', e.target.value)}
                         placeholder="e.g. 1 bar (40g)" className="input w-full !py-2 mt-1" aria-label="Serving label" />
                </label>
              </div>
              <div className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>
                Per that serving size
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['calories', 'Calories *'], ['protein', 'Protein (g) *'],
                  ['carbs', 'Carbs (g) *'], ['fat', 'Fat (g) *'],
                  ['fiber', 'Fiber (g)'], ['sugar', 'Sugar (g)'],
                  ['sodium', 'Sodium (mg)'],
                ].map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>{label}</span>
                    <input type="number" min="0" step="any" value={manualForm[key]}
                           onChange={(e) => setManualField(key, e.target.value)}
                           className="input w-full !py-2 mt-1 tabular-nums" aria-label={label} />
                  </label>
                ))}
              </div>

              {manualErr && <div className="text-[11px]" style={{ color: 'var(--bad)' }}>{manualErr}</div>}

              <Pressable onClick={submitManual} disabled={manualBusy}
                         className="btn-primary w-full !py-3.5 text-[13px] font-bold">
                {manualBusy ? 'Saving…' : 'Save & continue'}
              </Pressable>
              <button onClick={() => { setManualAdd(false); setManualErr(''); }}
                      className="w-full text-center text-[11px] underline" style={{ color: 'var(--mute)' }}>
                Cancel
              </button>
            </div>
          )}

          {/* ── quantity (name-search picker) ── */}
          {food && (
            <div className="space-y-4">
              <div>
                <div className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>{food.name}</div>
                <button onClick={backToSearch}
                        className="text-[10px] underline mt-0.5" style={{ color: 'var(--mute)' }}>
                  change food
                </button>
              </div>

              {groups.map(([group, ps]) => (
                <div key={group}>
                  <div className="text-[9px] uppercase tracking-[.16em] mb-1.5" style={{ color: 'var(--faint)' }}>
                    {group}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ps.map((p) => {
                      const on = portionKey === p.key && !grams;
                      return (
                        <button key={p.key}
                                onClick={() => { setPortionKey(p.key); setGrams(''); }}
                                className="rounded-full px-2.5 py-1 text-[11px] transition-colors"
                                style={on
                                  ? { background: 'var(--accent)', color: 'var(--accent-contrast)', border: '1px solid var(--accent)' }
                                  : { border: '1px solid var(--line)', color: 'var(--mute)' }}>
                          {p.label}
                          {/* Sub-gram portions keep a decimal. A pinch is ~0.4 g, and
                              Math.round turned that into a chip reading "Pinch · 0g" --
                              a control that appears to log nothing. */}
                          <span className="opacity-60"> · {p.grams < 1 ? p.grams.toFixed(1) : Math.round(p.grams)}g</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="flex items-end gap-3">
                <label className="flex-1">
                  <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>How many</span>
                  <input type="number" min="0.25" step="0.25" value={count}
                         onChange={(e) => setCount(e.target.value)}
                         className="input w-full !py-2 mt-1 tabular-nums" aria-label="Portion count" />
                </label>
                <span className="pb-2.5 text-[10px]" style={{ color: 'var(--faint)' }}>or</span>
                <label className="flex-1">
                  <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Weigh it (g)</span>
                  <input type="number" min="1" step="1" value={grams} placeholder="—"
                         onChange={(e) => { setGrams(e.target.value); if (e.target.value) setPortionKey(null); }}
                         className="input w-full !py-2 mt-1 tabular-nums" aria-label="Grams" />
                </label>
              </div>

              {/* Oil only for things that are cooked — offering it on an
                  apple is noise. */}
              {food.oil_applicable && (
                <div>
                  <div className="text-[9px] uppercase tracking-[.16em] mb-1.5" style={{ color: 'var(--faint)' }}>
                    Oil used
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {OIL_LEVELS.map(([key, label]) => {
                      const on = oil === key;
                      return (
                        <button key={key} onClick={() => setOil(on ? null : key)}
                                className="rounded-full px-2.5 py-1 text-[11px]"
                                style={on
                                  ? { background: 'var(--accent)', color: 'var(--accent-contrast)', border: '1px solid var(--accent)' }
                                  : { border: '1px solid var(--line)', color: 'var(--mute)' }}>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {resolved?.oil && (
                    <div className="text-[10px] mt-1.5" style={{ color: 'var(--mute)' }}>
                      {resolved.oil.delta_kcal >= 0 ? '+' : ''}{Math.round(resolved.oil.delta_kcal)} kcal vs this dish’s usual oil
                    </div>
                  )}
                </div>
              )}

              {/* Always show the resolved grams — it is how a user catches a
                  bad unit conversion before it reaches their day's total. */}
              <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--accent-soft)', border: '1px solid var(--line)' }}>
                {resolved ? (
                  <>
                    <div className="flex items-baseline justify-between">
                      <span className="font-black text-[22px] tabular-nums" style={{ color: 'var(--ink)' }}>
                        {resolved.totals?.energy_kcal == null ? '—' : Math.round(resolved.totals.energy_kcal)}
                      </span>
                      <span className="text-[11px] tabular-nums" style={{ color: 'var(--mute)' }}>
                        {resolved.grams} g · {resolved.quantity_label}
                      </span>
                    </div>
                    <div className="text-[10px] mt-1" style={{ color: 'var(--mute)' }}>
                      {/* null means NOT MEASURED, never 0. */}
                      P {resolved.totals?.protein_g ?? '—'} · C {resolved.totals?.carb_g ?? '—'} · F {resolved.totals?.fat_g ?? '—'}
                    </div>
                    {resolved.grams_basis === 'assumed_100g' && (
                      <div className="text-[10px] mt-1" style={{ color: 'var(--warn)' }}>
                        No serving size on record — assuming 100 g. Adjust if you know better.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>{err || 'Working it out…'}</div>
                )}
              </div>

              <Pressable onClick={commit} disabled={!resolved || busy}
                         className="btn-primary w-full !py-3.5 text-[13px] font-bold">
                {busy ? 'Adding…' : 'Add to log'}
              </Pressable>
            </div>
          )}

          {err && !food && !barcodeItem && !manualAdd && !aiResult && <div className="text-[11px] mt-2" style={{ color: 'var(--bad)' }}>{err}</div>}
        </div>
      </div>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onScanned={(item, code) => {
          setScanning(false);
          if (item) {
            // A scan already knows the product AND its serving, so it drops
            // straight into the confirm screen rather than back into search.
            setBarcodeItem(item);
            setBarcodeGrams(String(item.quantity.grams));
          } else if (code) {
            // Genuine miss (not indexed anywhere, including the live
            // external lookup) — offer the manual-add fallback with the
            // scanned code already filled in.
            openManualAdd(code);
          }
        }}
      />
    </div>
  );
}
