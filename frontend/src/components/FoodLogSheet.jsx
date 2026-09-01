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
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Pressable } from '../design/index.js';
import Icon from './Icon.jsx';
import BarcodeScanner from './BarcodeScanner.jsx';
import PortionWheel from './PortionWheel.jsx';

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

const EMPTY_CUSTOM = { name: '', calories: '', protein: '', carbs: '', fat: '', fiber: '', sugar: '', sodium: '' };
const REQUIRED_CUSTOM_MACROS = ['calories', 'protein', 'carbs', 'fat'];
const OPTIONAL_CUSTOM_MACROS = ['fiber', 'sugar', 'sodium'];

/** Round for display only — never re-used as an input to further math. */
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export default function FoodLogSheet({ open, onClose, onAdd, autoScan = false, mode, setMode, toast }) {
  // toast is optional (some older call sites may not pass one) -- fall
  // back to a no-op rather than crash, so a missing prop degrades to
  // "no toast shown" instead of a hard error on every quick-log.
  const notify = toast || (() => {});
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  // Distinct from "zero results" (Part 46: no silent failures) -- a
  // network/server error while searching used to look IDENTICAL to a
  // genuine no-match, with no way to tell "nothing found" from "the
  // request never even completed". Cleared on every new keystroke/query.
  const [searchErr, setSearchErr] = useState('');
  const [searchRetryNonce, setSearchRetryNonce] = useState(0);
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
  // Quick-log rows -- each search RESULT gets its own inline grams input +
  // a "+" button, so a food can be logged straight from the list without
  // opening the full portion picker (that screen is still reached by
  // tapping the row's NAME/info instead of "+" -- see `pick()`). Keyed by
  // the same id every other lookup here uses (`f.id || f.source_id`).
  // Grams, not a portion+count, to match the row's own compact layout --
  // still resolved server-side via the SAME /me/foods/resolve endpoint
  // and the SAME free-grams path the full picker's "Weigh it (g)" field
  // already uses, never re-derived client-side.
  const [rowGrams, setRowGrams] = useState({});
  const [rowLogging, setRowLogging] = useState({});
  const [rowErr, setRowErr] = useState({});
  // "+" -> "✓" confirmation (follow-up hardening pass, Sections 6/20) --
  // keyed the same stable way as rowLogging, so it can never land on the
  // wrong row if results reorder mid-flight. Purely a transient visual
  // confirmation alongside the toast, not a persisted "already logged"
  // flag -- the same food can be quick-logged again (e.g. a second
  // helping) without the row getting stuck showing a checkmark forever.
  const [rowChecked, setRowChecked] = useState({});
  // Recent foods (Part 40) -- reconstructed server-side from the client's
  // own meal_logs history (GET /me/foods/recent), not a new store. Shown
  // ONLY on the true idle screen (nothing typed yet) so it doesn't compete
  // with live search results. Logging one re-uses the exact same quick-log
  // path a search result's "+" uses, just seeded with the food's last-
  // known macros instead of a fresh /resolve call (there's no source_id to
  // resolve against for a plain manual/AI log).
  const [recentFoods, setRecentFoods] = useState([]);
  const [recentLogging, setRecentLogging] = useState({});
  const [recentChecked, setRecentChecked] = useState({});
  const [food, setFood] = useState(null);
  // Portion picker (Parts 4-9): the "How many" stepper is gone -- the
  // system works entirely from selectedPortions (one or more portion+qty
  // combinations, e.g. 1 small bowl + half a plate) OR an explicit custom
  // weight, never both at once (picking a portion clears customGrams and
  // vice versa -- one canonical effective weight, see the resolve effect
  // below). Each selected portion's own quantity is chosen via the
  // PortionWheel picker (wheelOpen/wheelPortion), not typed inline.
  const [selectedPortions, setSelectedPortions] = useState([]); // [{key,label,group,unitGrams,qty}]
  const [customGrams, setCustomGrams] = useState('');
  const [wheelOpen, setWheelOpen] = useState(false);
  const [wheelPortion, setWheelPortion] = useState(null); // the raw portion object the wheel is open for
  const [oil, setOil] = useState(null);
  const [resolved, setResolved] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [listening, setListening] = useState(false);
  // Custom Macros -- a second entry mode alongside search, reusing the
  // EXISTING private-food infrastructure (POST /me/foods, already
  // client_id-scoped + ownership-enforced -- see me.js's PUT/DELETE
  // /foods/:id -- and already searchable back via the "mine" branch of
  // GET /me/foods/search). This mode does not invent a second food store;
  // it's a form in front of the food store that already exists. Saving
  // both creates the reusable private food AND logs it for today in one
  // action, then stays open (onAdd(..., { keepOpen: true })) so the next
  // food can be searched or entered without re-opening the sheet.
  //
  // `mode`/`setMode` are CONTROLLED PROPS, not local state -- Nutrition.jsx
  // owns them (alongside its own `foodLogSheetOpen`). This sheet gets
  // remounted by its parent route whenever the underlying home data
  // reloads (a pre-existing behavior of ClientLayout's routed-Outlet
  // wrapper, unrelated to this feature -- confirmed via a per-mount
  // instance id: it remounts even during ordinary page settling). Any
  // state that's LOCAL to this component (q, results, food, aiResult...)
  // is fine to lose across that remount, since every one of those flows
  // already calls onClose() on success. Custom Macros is the first flow
  // that needs to survive a remount while staying open, so it can't live
  // in local state -- lifting it to the parent (which does NOT remount;
  // its own `open` state has been verified to persist) is what actually
  // fixes it, rather than fighting the remount itself.
  const [customForm, setCustomForm] = useState(EMPTY_CUSTOM);
  const [customErr, setCustomErr] = useState('');
  const [customSaving, setCustomSaving] = useState(false);
  const [showMoreMacros, setShowMoreMacros] = useState(false);
  // Duplicate-name handling (Part 39) -- the existing "MY FOODS" row with
  // this exact (case-insensitive) name, when one is found, pending the
  // user's own choice between reusing it or creating a genuine second one
  // (e.g. two different homemade dishes both fairly called "Curry").
  const [customDuplicate, setCustomDuplicate] = useState(null);
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
      // Best-effort -- a failed fetch just means no Recent section shows,
      // never blocks or errors the rest of the sheet.
      // limit=1 (follow-up hardening pass, Section 4): the idle screen
      // showed up to 6 Recent items, making the search dialog visually
      // heavy before the user has even typed anything. The underlying
      // history itself is untouched (meal_logs keeps every log; this only
      // limits how many rows THIS fetch asks for) -- also a genuine, if
      // small, network-payload win (Section 12/27).
      api('/me/foods/recent?limit=1').then((r) => setRecentFoods(r.recent || [])).catch(() => setRecentFoods([]));
    }
    if (!open) {
      setQ(''); setResults([]); setSearchErr(''); setFood(null); setResolved(null);
      setSelectedPortions([]); setCustomGrams(''); setWheelOpen(false); setWheelPortion(null); setOil(null); setErr('');
      setBarcodeItem(null); setBarcodeGrams(''); setBarcodeResolved(null); setBarcodeErr('');
      setManualAdd(false); setManualBarcode(''); setManualForm(EMPTY_MANUAL); setManualErr('');
      setLabelScanning(false); setLabelNote('');
      setAiResult(null); setAiErr(''); setAiEstimating(false);
      setKnnEstimate(null); setKnnGrams('100'); setKnnLogging(false);
      setMode('search'); setCustomForm(EMPTY_CUSTOM); setCustomErr(''); setCustomSaving(false); setCustomDuplicate(null); setShowMoreMacros(false);
      setRowGrams({}); setRowLogging({}); setRowErr({});
      setRecentFoods([]); setRecentLogging({});
    }
  }, [open, autoScan]);

  // Type-ahead. Debounced so a fast typist does not fire a request per key.
  useEffect(() => {
    const term = q.trim();
    if (food || term.length < 2) { setResults([]); setKnnEstimate(null); setSearching(false); return undefined; }
    setSearching(true); setSearchErr('');
    let dead = false;
    const h = setTimeout(() => {
      api(`/me/foods/search?q=${encodeURIComponent(term)}`)
        .then((r) => {
          if (dead) return;
          setResults(r.foods || []);
          setKnnEstimate(r.knn_estimate || null);
          setKnnGrams('100');
        })
        .catch((e) => { if (!dead) { setResults([]); setKnnEstimate(null); setSearchErr(e.message || 'Could not search right now — check your connection and try again.'); } })
        .finally(() => { if (!dead) setSearching(false); });
    }, 200);
    return () => { dead = true; clearTimeout(h); };
  }, [q, food, searchRetryNonce]);

  // Seed each new result row's quick-log grams with its own sensible
  // default (same precedence as pick()'s initial portion) -- never
  // clobbers a value already sitting in a row still on screen.
  useEffect(() => {
    if (!results.length) return;
    setRowGrams((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const f of results) {
        const key = f.id || f.source_id;
        if (next[key] === undefined) { next[key] = String(defaultGramsFor(f)); changed = true; }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  // Ask the server for grams + macros whenever the quantity changes.
  // Two mutually exclusive sources, never combined into one call:
  //   - customGrams set -> ONE resolve at that exact weight (free-grams
  //     path, same as before).
  //   - selectedPortions non-empty -> ONE resolve PER portion (each still
  //     server-priced individually, portion->grams stays authoritative),
  //     then the ALREADY-RESOLVED totals are summed here -- summing real
  //     numbers the server already computed is not re-deriving them, the
  //     same principle `eaten` totals elsewhere in this app already rely
  //     on. This is what lets "1 small bowl + half a plate" combine into
  //     one priced total without a backend change.
  useEffect(() => {
    if (!food) { setResolved(null); return undefined; }
    let dead = false;
    const h = setTimeout(async () => {
      try {
        let r = null;
        if (customGrams && Number(customGrams) > 0) {
          r = await api('/me/foods/resolve', {
            method: 'POST',
            // food_id (this row's own real `foods` primary key, present
            // for any search result built from the client's own foods or
            // the gym/global library -- absent for a bare, unmaterialized
            // model hit) makes resolve() price from THIS food's own
            // stored macros, never a name-based guess against the model
            // catalogue. The fix for a real bug: a custom food with no
            // source_id used to be "resolved" by searching the model for
            // its NAME instead, silently substituting a different food.
            body: JSON.stringify({ food_id: food.id || undefined, source_id: food.source_id || undefined, name: food.name, grams: Number(customGrams), oil_level: oil || undefined }),
          });
        } else if (selectedPortions.length > 0) {
          const parts = await Promise.all(selectedPortions.map((p) =>
            api('/me/foods/resolve', {
              method: 'POST',
              body: JSON.stringify({ source_id: food.source_id || undefined, name: food.name, portion_key: p.key, count: p.qty, oil_level: oil || undefined }),
            })
          ));
          if (dead) return;
          const sum = (field) => parts.reduce((acc, part) => acc + (Number(part.totals?.[field]) || 0), 0);
          const gramsSum = parts.reduce((acc, part) => acc + (Number(part.grams) || 0), 0);
          const oilSum = parts.reduce((acc, part) => acc + (Number(part.oil?.delta_kcal) || 0), 0);
          r = {
            totals: { energy_kcal: sum('energy_kcal'), protein_g: sum('protein_g'), carb_g: sum('carb_g'), fat_g: sum('fat_g') },
            grams: Math.round(gramsSum * 10) / 10,
            quantity_label: selectedPortions.map((p) => `${p.qty}× ${p.label}`).join(' + '),
            oil: food.oil_applicable ? { delta_kcal: oilSum } : null,
          };
        }
        if (!dead) { setResolved(r); setErr(''); }
      } catch (e) {
        if (!dead) { setResolved(null); setErr(e.message || 'Could not price that quantity'); }
      }
    }, 150);
    return () => { dead = true; clearTimeout(h); };
  }, [food, selectedPortions, customGrams, oil]);

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

  // ONE derived value for "which top-level screen is showing" (Part 24:
  // "a clean state/navigation model, not random boolean states"). The
  // underlying data-bearing state (food/aiResult/barcodeItem/manualAdd/
  // mode) stays exactly as it was -- each screen still owns its own
  // content the same way -- this just names which one is CURRENTLY
  // ACTIVE in one place, computed once, instead of the same
  // `!food && !barcodeItem && !manualAdd && !aiResult` conjunction being
  // re-typed at every render gate throughout this file (previously 5
  // separate copies, one now-fixed source of drift/typo risk). Priority
  // order matches how these screens can actually nest: manual-add and
  // AI-result are reached FROM search and never coexist with a picked
  // food; a picked food (portion picker) and a scanned barcode (confirm
  // screen) share one shape via backToSearch() already clearing both.
  const screen = manualAdd ? 'manual' : aiResult ? 'ai' : (food || barcodeItem) ? 'portion' : mode === 'custom' ? 'custom' : 'search';

  // Escape closes the TOPMOST layer only, one step at a time -- whichever
  // nested screen is active (mirrors goBack()'s own precedence, defined
  // further below -- referenced only inside this effect's callback, which
  // isn't invoked until a later keypress, well after that const exists),
  // and only the whole sheet if nothing else is open. Never requires a
  // selection first, matching Close's own "exit from anywhere" behavior
  // (Part 24). Deliberately does NOTHING while the wheel is open --
  // PortionWheel is a self-contained, independently-reusable component
  // and owns its own Escape-to-cancel; duplicating that logic here would
  // mean two independent listeners both reacting to the same keypress.
  // MUST stay above the `if (!open) return null;` below -- every hook in
  // this component must run on every render regardless of `open`, or
  // React throws "Rendered more hooks than during the previous render."
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== 'Escape' || wheelOpen) return;
      if (screen === 'manual') { setManualAdd(false); setManualErr(''); return; }
      if (screen === 'ai') { setAiResult(null); setAiErr(''); setAiEdits([]); setAiAdjusted(null); return; }
      if (screen === 'portion') { backToSearch(); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wheelOpen, screen]);

  if (!open) return null;

  // Same "food's own serving, else the bowl group, else its first portion"
  // precedence `pick()` below uses for the full picker's initial
  // selection -- reused here so a quick-log row's default grams matches
  // exactly what the portion picker would have defaulted to.
  const defaultGramsFor = (f) => {
    const first = (f.portions || []).find((p) => p.basis === 'serving')
      || (f.portions || []).find((p) => p.group === 'bowl')
      || (f.portions || [])[0];
    return first ? Math.round(first.grams) : 100;
  };

  const pick = (f) => {
    setFood(f);
    setResults([]);
    setKnnEstimate(null);
    // Default to the food's own serving when it has one (pre-selected at
    // qty 1, same as a fresh "1 small bowl"), else fall through to a
    // plain 100g custom weight -- same precedence defaultGramsFor() uses
    // for quick-log rows, so a food's default quantity is consistent
    // everywhere it appears.
    const first = (f.portions || []).find((p) => p.basis === 'serving')
      || (f.portions || []).find((p) => p.group === 'bowl')
      || (f.portions || [])[0];
    if (first) {
      setSelectedPortions([{ key: first.key, label: first.label, group: first.group, unitGrams: first.grams, qty: 1 }]);
      setCustomGrams('');
    } else {
      setSelectedPortions([]);
      setCustomGrams('100');
    }
  };

  const backToSearch = () => {
    setFood(null); setResolved(null);
    setBarcodeItem(null); setBarcodeResolved(null); setBarcodeErr('');
    setSelectedPortions([]); setCustomGrams(''); setWheelOpen(false); setWheelPortion(null);
  };

  // Add/update a portion selection from the wheel picker's "Done". Picking
  // a NEW/changed portion always wins over a stale custom weight (Part 8:
  // "one explicit effective-weight calculation" -- never both at once).
  const applyWheelPortion = (qty) => {
    if (!wheelPortion) return;
    setCustomGrams('');
    setSelectedPortions((prev) => {
      const idx = prev.findIndex((sp) => sp.key === wheelPortion.key);
      const entry = { key: wheelPortion.key, label: wheelPortion.label, group: wheelPortion.group, unitGrams: wheelPortion.grams, qty };
      if (idx === -1) return [...prev, entry];
      const next = [...prev]; next[idx] = entry; return next;
    });
    setWheelOpen(false);
  };

  const removeSelectedPortion = (key) => setSelectedPortions((prev) => prev.filter((sp) => sp.key !== key));

  // Quick-log a result row at its own inline grams -- resolves through the
  // SAME server-authoritative /me/foods/resolve endpoint the full picker
  // uses (free-grams path), then logs and STAYS in the search screen
  // (keepOpen: true) so the next food can be searched immediately. Never
  // navigates to the portion picker -- that's reached by tapping the row
  // itself, not "+" (see the row's onClick vs this handler).
  const quickLogRow = async (f) => {
    const key = f.id || f.source_id;
    const g = Number(rowGrams[key]);
    setRowErr((prev) => ({ ...prev, [key]: '' }));
    if (!(g > 0)) { setRowErr((prev) => ({ ...prev, [key]: 'Enter a valid amount in grams' })); return; }
    setRowLogging((prev) => ({ ...prev, [key]: true }));
    try {
      const resolvedRow = await api('/me/foods/resolve', {
        method: 'POST',
        // food_id -- see the portion-picker's own resolve call for why.
        body: JSON.stringify({ food_id: f.id || undefined, source_id: f.source_id || undefined, name: f.name, grams: g }),
      });
      const totals = resolvedRow?.totals;
      if (!totals || totals.energy_kcal == null) throw new Error('Could not price that quantity');
      await onAdd({
        name: f.name,
        calories: Math.round(totals.energy_kcal ?? 0),
        protein: totals.protein_g ?? 0,
        carbs: totals.carb_g ?? 0,
        fat: totals.fat_g ?? 0,
        quantity: g, unit: 'g',
      }, { keepOpen: true });
      // "+" -> "✓" (Sections 5-7/20) -- the row's own button flips to a
      // checkmark as an immediate, local confirmation. The success TOAST
      // itself is fired by the caller (Nutrition.jsx's onAdd, right after
      // this same logEntry call resolves) -- not duplicated here, since
      // that's already the single source of the "Food logged" copy;
      // search/results/query all stay untouched since nothing here closes
      // the sheet or reloads anything.
      setRowChecked((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => setRowChecked((prev) => ({ ...prev, [key]: false })), 1400);
    } catch (e) {
      // Rollback to "+" (rowChecked never set) plus BOTH an inline
      // per-row reason and the exact toast copy the hardening pass
      // specifies -- an inline-only error is easy to miss under a long
      // results list; the toast is what a person glances up and sees.
      setRowErr((prev) => ({ ...prev, [key]: e.message || 'Could not log that food' }));
      notify("Couldn't log food. Try again.");
    }
    setRowLogging((prev) => ({ ...prev, [key]: false }));
  };

  // Quick-log a Recent entry at its own last-known macros -- there's no
  // source_id to re-resolve against (a Recent row is a reconstructed log
  // SNAPSHOT, not a food catalogue match), so this replays those exact
  // values as a brand-new log entry today, same as if the user had
  // searched and gotten the same result again. Preserves the original
  // `source` tag (falls back to 'manual') so a re-logged database/AI
  // result stays correctly labeled, not silently reclassified.
  const quickLogRecent = async (r) => {
    const key = r.name;
    setRecentLogging((prev) => ({ ...prev, [key]: true }));
    try {
      await onAdd({
        name: r.name, calories: Math.round(r.calories || 0),
        protein: r.protein || 0, carbs: r.carbs || 0, fat: r.fat || 0,
        source: r.source && r.source !== 'plan' ? r.source : 'manual',
      }, { keepOpen: true });
      setRecentChecked((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => setRecentChecked((prev) => ({ ...prev, [key]: false })), 1400);
    } catch (e) {
      // The earlier comment here ("onAdd's own caller already surfaces a
      // toast on failure") was wrong for this exact path -- onAdd's own
      // catch block never runs when onAdd itself is what throws; the
      // exception lands right here instead, same as quickLogRow. Without
      // this, a failed Recent-replay silently reset the button back to
      // "+" with zero explanation.
      notify(e.message && e.message !== 'Failed to fetch' ? e.message : "Couldn't log food. Try again.");
    }
    setRecentLogging((prev) => ({ ...prev, [key]: false }));
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
      // Stays open, returns to search (never all the way out to the
      // dashboard) -- Flow B: search -> food detail -> choose portion ->
      // log -> back to search, ready for the next food.
      const grams = isBarcode ? Number(barcodeGrams) : resolved?.grams;
      await onAdd({
        name,
        calories: Math.round(totals.energy_kcal ?? 0),
        protein: totals.protein_g ?? 0,
        carbs: totals.carb_g ?? 0,
        fat: totals.fat_g ?? 0,
        quantity: grams > 0 ? grams : undefined,
        unit: grams > 0 ? 'g' : undefined,
      }, { keepOpen: true });
      backToSearch();
    } catch (e) {
      setErr(e.message || 'Could not add that food');
    }
    setBusy(false);
  };

  // Editing the form after a duplicate notice was shown (e.g. renaming it)
  // dismisses that notice -- it was a judgment about the PREVIOUS name/
  // values, not a permanent lock on the form.
  const setCustomField = (key, value) => { setCustomForm((f) => ({ ...f, [key]: value })); setCustomDuplicate(null); };

  // Custom Macros: create a private "MY FOODS" row (POST /me/foods --
  // client_id-scoped, never global, same route My Diet's saved-foods
  // editor already uses) AND log it for today, in one action. Stays open
  // afterward (onAdd(..., { keepOpen: true })) and resets the form so the
  // next food can be entered immediately, matching the same
  // stay-in-the-sheet behavior a quick database log will eventually have.
  //
  // `skipDuplicateCheck` -- true only when called from "Create another"
  // below, after the user has already been shown and dismissed the
  // duplicate-name notice for THIS name; every other call re-checks.
  const submitCustomFood = async (skipDuplicateCheck = false) => {
    setCustomErr('');
    const cf = customForm;
    const name = cf.name.trim();
    if (!name) { setCustomErr('Name this food first'); return; }
    const nums = { calories: Number(cf.calories), protein: Number(cf.protein), carbs: Number(cf.carbs), fat: Number(cf.fat) };
    for (const key of REQUIRED_CUSTOM_MACROS) {
      const v = nums[key];
      if (!Number.isFinite(v) || v < 0) { setCustomErr(`Enter a valid, non-negative ${key === 'calories' ? 'calorie' : key} value`); return; }
    }
    // fiber/sugar/sodium are OPTIONAL -- blank means "not tracked", never
    // coerced to 0; only sent if the user actually typed something.
    for (const key of OPTIONAL_CUSTOM_MACROS) {
      const raw = cf[key];
      if (raw === '' || raw == null) continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) { setCustomErr(`Enter a valid, non-negative ${key} value`); return; }
      nums[key] = v;
    }
    if (!skipDuplicateCheck) {
      try {
        const { mine } = await api('/me/foods');
        const dup = (mine || []).find((f) => f.name.trim().toLowerCase() === name.toLowerCase());
        if (dup) { setCustomDuplicate(dup); return; }
      } catch { /* lookup failure -- fall through and create normally rather than block on it */ }
    }
    setCustomSaving(true);
    try {
      await api('/me/foods', { method: 'POST', body: JSON.stringify({ name, ...nums }) });
      // quantity:1/unit:'serving' -- a Custom Macros entry has no grams
      // concept (it's "however much this one serving is"), but "1
      // serving" IS a real, meaningful baseline for later proportional
      // editing (2 servings -> exactly 2x these macros), unlike leaving
      // quantity unset (which silently defaulted to a fabricated "100").
      await onAdd({ name, calories: Math.round(nums.calories), protein: nums.protein, carbs: nums.carbs, fat: nums.fat, source: 'manual', quantity: 1, unit: 'serving' }, { keepOpen: true });
      setCustomForm(EMPTY_CUSTOM);
      setCustomDuplicate(null);
      setShowMoreMacros(false);
    } catch (e) {
      setCustomErr(e.message || 'Could not save that food');
    }
    setCustomSaving(false);
  };

  // "Use existing" -- log the ALREADY-SAVED food with this name instead of
  // creating a duplicate row; its own stored macros are the source, never
  // the form's (possibly different) values the user just typed.
  const useDuplicateCustomFood = async () => {
    if (!customDuplicate) return;
    setCustomSaving(true);
    try {
      await onAdd({
        name: customDuplicate.name, calories: Math.round(customDuplicate.calories || 0),
        protein: customDuplicate.protein || 0, carbs: customDuplicate.carbs || 0, fat: customDuplicate.fat || 0,
        source: 'manual', quantity: 1, unit: 'serving',
      }, { keepOpen: true });
      setCustomForm(EMPTY_CUSTOM);
      setCustomDuplicate(null);
    } catch (e) {
      setCustomErr(e.message || 'Could not log that food');
    }
    setCustomSaving(false);
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
        source: 'knn_estimated', quantity: g, unit: 'g',
      }, { keepOpen: true });
      setKnnEstimate(null); setKnnGrams('100'); setQ('');
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
      // AI estimate -> log -> back to the search screen (Part 12) --
      // never forced out to the dashboard, and the search bar stays
      // usable for the next food immediately.
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
        quantity: aiTotalGrams > 0 ? aiTotalGrams : undefined,
        unit: aiTotalGrams > 0 ? 'g' : undefined,
      }, { keepOpen: true });
      // A user who edited the AI's numbers is telling us something --
      // record it as ONE feedback observation toward the shared cache,
      // never an immediate overwrite (see backend/.../foodFeedback.js).
      // Best-effort: never blocks or fails the actual food log above.
      if (adjusted) {
        // original/adjusted can legitimately be different TOTAL weights
        // (the user may have changed overall quantity, not just
        // proportions) -- each side is normalized against its OWN actual
        // weight, never a single shared grams figure, or the comparison
        // itself would be wrong before it even reaches the server.
        const originalGrams = aiResult.serving?.estimated_weight_g || aiTotalGrams;
        api('/me/food-feedback', {
          method: 'POST',
          body: JSON.stringify({
            query: aiResult.food_name,
            original_grams: originalGrams,
            adjusted_grams: aiTotalGrams,
            original: {
              calories: aiResult.totals.calories, protein_g: aiResult.totals.protein,
              carbs_g: aiResult.totals.carbs, fat_g: aiResult.totals.fat,
            },
            adjusted: {
              calories: totals.calories, protein_g: totals.protein,
              carbs_g: totals.carbs, fat_g: totals.fat,
            },
            ai_provider: aiResult.ai?.provider || undefined,
            ai_model: aiResult.ai?.model || undefined,
          }),
        }).catch(() => {}); // feedback collection must never surface as a user-facing error
      }
      setAiResult(null); setAiErr(''); setAiEdits([]); setAiAdjusted(null); setQ('');
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

  // BACK vs CLOSE (Part 23): Back goes exactly one level backward (food
  // detail / AI review / barcode confirm / manual-add -> search); Close
  // always exits the whole flow, from any level, without requiring a
  // selection first. Only shown when there's actually somewhere to go
  // back TO -- at the top-level search/custom-macros screen there is no
  // previous step within this sheet, so only Close appears there.
  const showBack = screen === 'manual' || screen === 'ai' || screen === 'portion';
  const goBack = () => {
    if (screen === 'manual') { setManualAdd(false); setManualErr(''); return; }
    if (screen === 'ai') { setAiResult(null); setAiErr(''); setAiEdits([]); setAiAdjusted(null); return; }
    // food and barcodeItem (confirm screen) both return to search the
    // same way -- backToSearch() already clears both.
    backToSearch();
  };

  // barcodeItem vs food both map to `screen === 'portion'` but show
  // different titles -- the one place `screen` alone isn't quite enough
  // detail, so this checks the underlying data directly rather than
  // inventing a 5th screen value for what's really the same navigational
  // level.
  const dialogLabel = screen === 'manual' ? 'Add product manually' : screen === 'ai' ? 'AI estimate' : screen === 'portion' ? (barcodeItem ? 'Confirm product' : 'How much?') : screen === 'custom' ? 'Custom Macros' : 'Log Food';

  // Rendered via a portal straight to <body> rather than in place --
  // ClientLayout.jsx's page-transition wrapper carries `.anim-fadeUp`
  // (animation ... both, ending on a transform keyframe), and a fill-
  // mode 'both' animation keeps its end-state transform applied FOREVER
  // after it finishes. Per the CSS spec, any ancestor with a non-`none`
  // transform becomes the containing block for `position: fixed`
  // descendants -- so without this portal, this sheet's "fixed inset-0"
  // is fixed relative to that ancestor, not the true viewport. Confirmed
  // via a live repro: at an unusually short viewport, the app's sticky
  // header painted ABOVE this sheet despite its higher z-index, because
  // the sheet's real containing block wasn't the viewport at all. A
  // portal is the standard, fully general fix -- it sidesteps the
  // containing-block question entirely, for any future ancestor
  // transform too, without touching the shared animation CSS (which
  // many other pages also use) at all.
  return createPortal((
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
         style={{ background: 'rgb(var(--bg-rgb) / .72)', backdropFilter: 'blur(4px)' }}
         onClick={onClose} role="dialog" aria-modal="true" aria-label={dialogLabel}>
      <div className="card w-full sm:max-w-md max-h-[88vh] overflow-y-auto rounded-b-none sm:rounded-2xl"
           onClick={(e) => e.stopPropagation()}>

        <div className="sticky top-0 z-10 px-4 pt-4 pb-3" style={{ background: 'var(--panel)' }}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {showBack && (
                // 44x44 tap target (Part 33) even though the visible glyph
                // stays small -- -ml-2.5 pulls the extra padding back so the
                // header's own alignment doesn't visually shift.
                <button onClick={goBack} aria-label="Back" className="shrink-0 -ml-2.5 w-11 h-11 rounded-full grid place-items-center" style={{ color: 'var(--ink)' }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
              )}
              <div className="text-[11px] uppercase tracking-[.18em] truncate" style={{ color: 'var(--faint)' }}>
                {dialogLabel}
              </div>
            </div>
            <button onClick={onClose} aria-label="Close" className="shrink-0 -mr-2.5 w-11 h-11 rounded-full grid place-items-center text-[15px]" style={{ color: 'var(--mute)' }}>✕</button>
          </div>

          {(screen === 'search' || screen === 'custom') && (
            <div className="mt-2 flex gap-1.5 rounded-xl p-1" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
              {[['search', 'Search Food'], ['custom', 'Custom Macros']].map(([key, label]) => (
                <button key={key} onClick={() => { setMode(key); setCustomErr(''); setShowMoreMacros(false); }}
                        aria-pressed={mode === key}
                        className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold transition-colors"
                        style={mode === key
                          ? { background: 'var(--accent)', color: 'var(--accent-contrast)' }
                          : { color: 'var(--mute)' }}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {screen === 'search' && (
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
          {/* ── custom macros ── */}
          {screen === 'custom' && (
            <div className="space-y-3">
              <label className="block">
                <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>What would you like to call this food? *</span>
                <input value={customForm.name} onChange={(e) => setCustomField('name', e.target.value)}
                       placeholder="e.g. Homemade Paneer" autoFocus
                       className="input w-full !py-2 mt-1" aria-label="Food name" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                {[['calories', 'Calories *'], ['protein', 'Protein (g) *'], ['carbs', 'Carbs (g) *'], ['fat', 'Fat (g) *']].map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>{label}</span>
                    <input type="number" min="0" step="any" value={customForm[key]}
                           onChange={(e) => setCustomField(key, e.target.value)}
                           className="input w-full !py-2 mt-1 tabular-nums" aria-label={label} />
                  </label>
                ))}
              </div>
              {showMoreMacros ? (
                <div className="grid grid-cols-3 gap-3">
                  {[['fiber', 'Fiber (g)'], ['sugar', 'Sugar (g)'], ['sodium', 'Sodium (mg)']].map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>{label}</span>
                      <input type="number" min="0" step="any" value={customForm[key]}
                             onChange={(e) => setCustomField(key, e.target.value)}
                             className="input w-full !py-2 mt-1 tabular-nums" aria-label={label} />
                    </label>
                  ))}
                </div>
              ) : (
                <button type="button" onClick={() => setShowMoreMacros(true)}
                        className="text-[11px] font-semibold underline-offset-2 hover:underline" style={{ color: 'var(--mute)' }}>
                  + Fiber, sugar, sodium (optional)
                </button>
              )}
              <div className="text-[10px]" style={{ color: 'var(--faint)' }}>
                Private to you — saved as one of your own foods, never added to the shared SK OS database. It'll show up first the next time you search for it.
              </div>
              {customErr && <div className="text-[11px]" style={{ color: 'var(--bad)' }}>{customErr}</div>}

              {customDuplicate ? (
                <div className="rounded-xl p-3 space-y-2.5" style={{ background: 'var(--accent-soft)', border: '1px solid var(--line)' }}>
                  <div className="text-[12px]" style={{ color: 'var(--ink)' }}>
                    You already have a custom food named "{customDuplicate.name}".
                  </div>
                  <div className="flex gap-2">
                    <Pressable onClick={useDuplicateCustomFood} disabled={customSaving}
                               className="flex-1 !py-2.5 rounded-xl text-[12px] font-bold" style={{ border: '1px solid var(--line)', background: 'transparent', color: 'var(--ink)' }}>
                      Use existing
                    </Pressable>
                    <Pressable onClick={() => submitCustomFood(true)} disabled={customSaving}
                               className="flex-1 btn-primary !py-2.5 text-[12px] font-bold">
                      {customSaving ? 'Saving…' : 'Create another'}
                    </Pressable>
                  </div>
                </div>
              ) : (
                <Pressable onClick={() => submitCustomFood(false)} disabled={customSaving || !customForm.name.trim()}
                           className="btn-primary w-full !py-3.5 text-[13px] font-bold">
                  {customSaving ? 'Saving…' : 'Save Custom Food & Log'}
                </Pressable>
              )}
            </div>
          )}

          {/* ── search results ── */}
          {screen === 'search' && (
            <div className="space-y-1">
              {/* Recent (Part 40) -- only on the true idle screen, before the
                  user has typed anything, so it never competes with live
                  search results. */}
              {q.trim().length === 0 && recentFoods.length > 0 && (
                <div className="pb-2 space-y-1.5">
                  <div className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Recent</div>
                  {recentFoods.map((r) => (
                    <div key={r.name} className="rounded-xl px-3 py-2 flex items-center justify-between gap-2" style={{ border: '1px solid var(--line)' }}>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{r.name}</div>
                        <div className="text-[10px]" style={{ color: 'var(--faint)' }}>
                          {Math.round(r.calories)} kcal{r.times_logged > 1 ? ` · logged ${r.times_logged}×` : ''}
                        </div>
                      </div>
                      <Pressable onClick={() => quickLogRecent(r)} disabled={!!recentLogging[r.name]}
                                 aria-label={recentChecked[r.name] ? `${r.name} logged` : `Log ${r.name} again`}
                                 className="shrink-0 w-8 h-8 rounded-full grid place-items-center btn-primary !p-0 text-[16px] font-bold"
                                 style={recentChecked[r.name] ? { background: 'var(--good)' } : undefined}>
                        {recentLogging[r.name] ? '…' : recentChecked[r.name] ? '✓' : '+'}
                      </Pressable>
                    </div>
                  ))}
                </div>
              )}
              {searching && !results.length && (
                <div className="text-[11px] py-3" style={{ color: 'var(--faint)' }}>Searching…</div>
              )}
              {!searching && searchErr && (
                <div className="py-3 space-y-2">
                  <div className="text-[11px]" style={{ color: 'var(--bad)' }}>{searchErr}</div>
                  <Pressable onClick={() => setSearchRetryNonce((n) => n + 1)} className="btn !py-2 !px-3 text-[11px] font-semibold">
                    Try again
                  </Pressable>
                </div>
              )}
              {!searching && !searchErr && q.trim().length >= 2 && !results.length && (
                <div className="py-3 space-y-2">
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
                    No close match found in SK OS for “{q.trim()}”.
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
              {results.map((f) => {
                const key = f.id || f.source_id;
                const disabled = f.trustworthy === false;
                const rowValue = rowGrams[key] ?? String(defaultGramsFor(f));
                const logging = !!rowLogging[key];
                const checked = !!rowChecked[key];
                return (
                  <div key={key} className="rounded-xl px-3 py-2 space-y-1.5" style={{ border: '1px solid var(--line)' }}>
                    <div className="flex items-center gap-2">
                      {/* Tapping the food itself (name/info) opens the full
                          portion picker -- "+" below is the quick-log path.
                          Two different intents, two different controls. */}
                      <button onClick={() => pick(f)} disabled={disabled}
                              className="min-w-0 flex-1 text-left disabled:opacity-45">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="block text-[13px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{f.name}</span>
                          {/* Short, crisp marker (Part 3 of the follow-up
                              hardening pass) so a client's OWN saved food is
                              never mistaken for the shared database --
                              gated on client_id specifically (not just
                              source === 'USER_ENTERED', which a gym/global
                              library row can also carry) so this never
                              implies a gym-shared food is "yours". */}
                          {f.client_id && (
                            <span className="shrink-0 text-[8px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                              Custom food
                            </span>
                          )}
                        </span>
                        <span className="text-[10px]" style={{ color: 'var(--mute)' }}>
                          {disabled
                            ? (f.data_quality_flag || 'Data quality flagged')
                            : `${f.calories == null ? '—' : Math.round(f.calories)} kcal / 100 g`}
                          {f.brand ? ` · ${f.brand}` : ''}
                          {f.confidence && f.confidence !== 'high' ? ` · ${f.confidence}` : ''}
                        </span>
                      </button>
                      <input
                        type="number" min="1" step="1" value={rowValue}
                        onChange={(e) => { setRowGrams((prev) => ({ ...prev, [key]: e.target.value })); setRowErr((prev) => ({ ...prev, [key]: '' })); setRowChecked((prev) => ({ ...prev, [key]: false })); }}
                        disabled={disabled}
                        aria-label={`${f.name} grams`}
                        className="w-16 text-right text-[12px] rounded-lg px-1.5 py-1.5 tabular-nums shrink-0"
                        style={{ background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--ink)' }}
                      />
                      <span className="text-[10px] shrink-0" style={{ color: 'var(--faint)' }}>g</span>
                      <Pressable onClick={() => quickLogRow(f)} disabled={disabled || logging || !(Number(rowValue) > 0)}
                                 aria-label={checked ? `${f.name} logged` : `Quick log ${f.name}`}
                                 className="w-8 h-8 rounded-full grid place-items-center shrink-0 font-bold text-[16px] leading-none transition-transform active:scale-90"
                                 style={{ background: checked ? 'var(--good)' : 'var(--accent)', color: 'var(--accent-contrast)', opacity: (disabled || logging || !(Number(rowValue) > 0)) ? 0.45 : 1 }}>
                        {logging ? '…' : checked ? '✓' : '+'}
                      </Pressable>
                    </div>
                    {rowErr[key] && <div className="text-[10px]" style={{ color: 'var(--bad)' }}>{rowErr[key]}</div>}
                  </div>
                );
              })}

              {/* AI fallback ALONGSIDE existing matches -- the user picks a
                  database match above, OR estimates the EXACT food they
                  typed (never the highest-scoring match, never a different
                  food) if none of the above is actually what they meant. */}
              {!searching && results.length > 0 && q.trim().length >= 2 && (
                <div className="pt-1">
                  <Pressable onClick={estimateWithAI} disabled={aiEstimating}
                             className="btn w-full !py-2 text-[11px] font-semibold flex items-center justify-center gap-2">
                    <Icon name="robot" size={14} />
                    {aiEstimating ? 'Estimating…' : `Didn't find the exact food? Estimate "${q.trim()}" with AI`}
                  </Pressable>
                  {aiErr && <div className="text-[11px] mt-1.5" style={{ color: 'var(--bad)' }}>{aiErr}</div>}
                </div>
              )}
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
                  {/* validation_status is about community evidence backing
                      the CACHED value -- a completely different concept
                      from a Tier-1/3 search-match percentage, never labelled
                      the same way. */}
                  {aiResult.validation_status === 'COMMUNITY_VALIDATED_CANDIDATE' ? '✓ SK OS Estimated' : '✨ AI Estimated'}
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
              <div className="flex items-start gap-3">
                {/* No image data exists for a name-matched food (only a
                    scanned barcode product carries a real image_url --
                    see the barcode-confirm screen below, which already
                    shows it) -- a clean placeholder here, never a
                    fabricated URL, per Part 10. Never blocks logging. */}
                <div className="w-12 h-12 rounded-xl grid place-items-center shrink-0" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                  <Icon name="food" size={22} />
                </div>
                <div className="min-w-0">
                  <div className="text-[15px] font-bold truncate" style={{ color: 'var(--ink)' }}>{food.name}</div>
                  <button onClick={backToSearch}
                          className="text-[10px] underline mt-0.5" style={{ color: 'var(--mute)' }}>
                    change food
                  </button>
                </div>
              </div>

              {groups.map(([group, ps]) => (
                <div key={group}>
                  <div className="text-[9px] uppercase tracking-[.16em] mb-1.5" style={{ color: 'var(--faint)' }}>
                    {group}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ps.map((p) => {
                      // "Selected" = this portion is part of the combined
                      // total below, at whatever qty the wheel last set --
                      // tapping the chip ALWAYS (re)opens the wheel, even
                      // for an already-selected portion, so its quantity
                      // can be adjusted rather than just toggled off.
                      const selected = selectedPortions.some((sp) => sp.key === p.key);
                      return (
                        <button key={p.key}
                                onClick={() => { setWheelPortion(p); setWheelOpen(true); }}
                                className="rounded-full px-2.5 py-1 text-[11px] transition-colors"
                                style={selected
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

              {/* Combined portions (Part 7) -- each selection shown with its
                  own remove control; the running total is what actually
                  prices below, never a hidden guess. */}
              {selectedPortions.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Selected</div>
                  {selectedPortions.map((sp) => (
                    <div key={sp.key} className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5" style={{ background: 'var(--accent-soft)' }}>
                      <span className="text-[12px]" style={{ color: 'var(--ink)' }}>
                        ✓ {sp.qty} × {sp.label} <span style={{ color: 'var(--mute)' }}>· {Math.round(sp.unitGrams * sp.qty)}g</span>
                      </span>
                      {/* p-2 -m-2 grows the actual tap target well past the
                          visible glyph without changing this row's compact
                          height (Part 33). */}
                      <button onClick={() => removeSelectedPortion(sp.key)} aria-label={`Remove ${sp.label}`}
                              className="shrink-0 opacity-60 hover:opacity-100 text-[13px] p-2 -m-2" style={{ color: 'var(--bad)' }}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Custom weight (Part 8) -- always available, always the
                  SAME single effective-weight source once typed: entering
                  a value here overrides any portion selection above
                  (cleared automatically, never summed together). Shows the
                  combined portion total as a placeholder when portions are
                  selected, so the number this is about to override is
                  visible before overriding it. */}
              <label className="block">
                <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Custom weight (g)</span>
                <input type="number" min="1" step="1" value={customGrams}
                       placeholder={selectedPortions.length ? String(Math.round(selectedPortions.reduce((s, sp) => s + sp.unitGrams * sp.qty, 0))) : '—'}
                       onChange={(e) => { const v = e.target.value; setCustomGrams(v); if (v) setSelectedPortions([]); }}
                       className="input w-full !py-2 mt-1 tabular-nums" aria-label="Custom weight in grams" />
              </label>

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

          {err && (screen === 'search' || screen === 'custom') && <div className="text-[11px] mt-2" style={{ color: 'var(--bad)' }}>{err}</div>}
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

      <PortionWheel
        open={wheelOpen}
        portion={wheelPortion}
        initialQty={wheelPortion ? (selectedPortions.find((sp) => sp.key === wheelPortion.key)?.qty ?? 1) : 1}
        onCancel={() => setWheelOpen(false)}
        onDone={applyWheelPortion}
      />
    </div>
  ), document.body);
}
