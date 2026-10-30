import { useEffect, useState, useMemo, Suspense } from 'react';
import { lazyWithReload as lazy } from '../../lazyWithReload.js';
import { useOutletContext } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { useTheme } from '../../themeContext.jsx';
import { api } from '../../api.js';
import { useCountUp, useFetch } from '../../utils.js';
import { ErrorState, CheckIcon, XIcon, PageSkeleton, useConfirm, useDialog, Sheet } from '../../components/UI.jsx';
import InfoDot from '../../components/InfoDot.jsx';
import NutritionTargetSetup from '../../components/NutritionTargetSetup.jsx';
import FoodLogSheet from '../../components/FoodLogSheet.jsx';
import MyDietCard from '../../components/nutrition/MyDietCard.jsx';
import CalorieBalance from '../../components/nutrition/CalorieBalance.jsx';
import NetEnergyCard from '../../components/nutrition/NetEnergyCard.jsx';
import ShareMealsSheet from '../../components/nutrition/ShareMealsSheet.jsx';
import CustomizeMealSheet from '../../components/nutrition/CustomizeMealSheet.jsx';
import MealInfoSheet from '../../components/nutrition/MealInfoSheet.jsx';
import FuelRings from '../../components/nutrition/FuelRings.jsx';
import LogCard from '../../components/nutrition/logger/LogCard.jsx';
import { slotForTime, mealGroup } from '../../components/nutrition/logger/plate.js';
import { motion, AnimatePresence } from '../../design/motion/index.jsx';

// The logger is the heaviest thing on this page and nobody needs it until
// they tap: its own chunk, fetched on first open.
const PlateSheet = lazy(() => import('../../components/nutrition/logger/PlateSheet.jsx'));

const r1 = (n) => Math.round(n * 10) / 10;

/* ════════════════════════════════════════════════════════════════
   THEME TOKENS
   ════════════════════════════════════════════════════════════════ */

const T = {
  dark: {
    bg: 'var(--bg)',
    surface: 'rgba(255,255,255,0.03)',
    surfaceHover: 'rgba(255,255,255,0.06)',
    border: 'var(--line)',
    borderHover: 'rgba(255,255,255,0.14)',
    ink: 'var(--ink)',
    mute: 'var(--mute)',
    faint: 'var(--faint)',
    accent: 'var(--accent)',
    accentDim: 'var(--accent-soft)',
    gold: 'var(--accent)',
    goldDim: 'var(--accent-soft)',
    secondary: '#FB7185',
    secondaryDim: 'rgba(251,113,133,0.10)',
    protein: 'var(--accent)',
    carbs: 'var(--warn)',
    fat: 'var(--good)',
    water: 'var(--m-recovery)',
    waterDim: 'var(--m-recovery-bg)',
    danger: '#F87171',
    glass: 'rgba(255,255,255,0.04)',
    glassBorder: 'rgba(255,255,255,0.08)',
    ringTrack: 'rgba(255,255,255,0.06)',
    heroGlow: 'radial-gradient(ellipse at 50% 30%, rgb(var(--accent-rgb) / .06), transparent 70%)',
    cardShadow: '0 2px 20px rgba(0,0,0,0.3)',
    timeline: 'rgba(255,255,255,0.06)',
    timelineActive: 'rgb(var(--accent-rgb) / .3)',
  },
  light: {
    bg: 'var(--bg)',
    surface: 'var(--panel)',
    surfaceHover: 'rgba(0,0,0,0.06)',
    border: 'var(--line)',
    borderHover: 'rgba(0,0,0,0.14)',
    ink: 'var(--ink)',
    mute: 'var(--mute)',
    faint: 'var(--faint)',
    accent: 'var(--accent)',
    accentDim: 'var(--accent-soft)',
    gold: 'var(--accent)',
    goldDim: 'var(--accent-soft)',
    secondary: '#D46A8A',
    secondaryDim: 'rgba(212,106,138,0.08)',
    protein: 'var(--accent)',
    carbs: 'var(--warn)',
    fat: 'var(--good)',
    // Water's hue everywhere else (charts, reports), and solved for AA as
    // text on its own tint. #3E7B85 on a 10% wash of itself was 4.2:1 --
    // the "+250" / "+500" labels failed the light-theme axe scan.
    water: 'var(--m-recovery)',
    waterDim: 'var(--m-recovery-bg)',
    danger: '#D44',
    glass: 'rgba(255,255,255,0.6)',
    glassBorder: 'rgba(0,0,0,0.08)',
    ringTrack: 'rgba(0,0,0,0.08)',
    heroGlow: 'radial-gradient(ellipse at 50% 30%, rgb(var(--accent-rgb) / .05), transparent 70%)',
    cardShadow: '0 2px 20px rgba(0,0,0,0.06)',
    timeline: 'rgba(0,0,0,0.06)',
    timelineActive: 'rgb(var(--accent-rgb) / .25)',
  },
};

/* ════════════════════════════════════════════════════════════════
   MACRO BAR
   ════════════════════════════════════════════════════════════════ */

function MacroStat({ label, value, max, color, t }) {
  const frac = max > 0 ? Math.min(value / max, 1) : 0;
  const animVal = useCountUp(Math.round(value), 1000);
  const over = value > max && max > 0;
  return (
    <div className="min-w-0">
      <div className="font-grotesk text-[10.5px] uppercase tracking-[.12em] font-semibold" style={{ color: t.mute }}>{label}</div>
      <div className="font-grotesk text-[15px] font-bold tabular-nums mt-0.5" style={{ color: over ? t.danger : t.ink }}>
        {animVal}<span className="text-[11px] font-medium" style={{ color: t.faint }}> / {max || 0} g</span>
      </div>
      <div className="h-1 rounded-full overflow-hidden mt-1.5" style={{ background: t.ringTrack }}>
        <div className="h-full rounded-full" style={{ width: `${frac * 100}%`, background: color, transition: 'width 1s cubic-bezier(.22,.8,.3,1)' }} />
      </div>
    </div>
  );
}

/**
 * A TARGET IS A LINE TO CROSS, NOT A CEILING ON WHAT HAPPENED.
 *
 * The running total used to be clamped with Math.min(target, ...), so the
 * moment you reached your goal every further tap computed the number you
 * already had: the glass didn't move, the figure didn't change, and
 * nothing said why. Four litres on a hot day recorded three, and a button
 * labelled "+500 ml" read as broken because tapping it did nothing at all.
 *
 * The floor is the same mistake in reverse. Undo is offered whenever
 * anything is logged, so at 0.1 L it sent -0.15, the API refused it, and
 * correcting a mis-tap surfaced "Couldn't log water" rather than simply
 * going back to zero.
 *
 * So the only bounds here are the ones the API actually enforces
 * (0-20 L, schemas.waterLog) -- anything tighter invents a rule the
 * backend never had and loses a real day's drinking to it.
 */
export function nextWaterLitres(current, delta) {
  const sum = (Number(current) || 0) + (Number(delta) || 0);
  return Math.min(20, Math.max(0, Math.round(sum * 100) / 100));
}

/* ════════════════════════════════════════════════════════════════
   HYDRATION — premium water visualization
   ════════════════════════════════════════════════════════════════ */

function HydrationCard({ waterState, target, onAdd, t }) {
  /* One row: how much, how far along, and the two amounts people drink.
     The old card's vessel, percentage, "ml to go" line and three labelled
     buttons said the same thing four ways. Undo is the "−". */
  const pct = target > 0 ? Math.min(waterState / target, 1) : 0;
  const animLitres = useCountUp(waterState * 10, 800) / 10;
  return (
    <div data-tour="nutrition-water" className="rounded-2xl px-4 py-3 flex items-center gap-3"
         style={{ background: t.surface, border: `1px solid ${t.border}` }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={t.water} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2.7s-6 6.4-6 11.1a6 6 0 0 0 12 0C18 9.1 12 2.7 12 2.7Z" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="font-grotesk tabular-nums leading-none" style={{ color: t.ink }}>
          <span className="text-[16px] font-black">{animLitres.toFixed(1)}</span>
          <span className="text-[12px] font-medium" style={{ color: t.mute }}> / {target} L</span>
        </div>
        <div className="h-1 rounded-full overflow-hidden mt-2" style={{ background: t.ringTrack }}>
          <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: t.water, transition: 'width .7s cubic-bezier(.22,.8,.3,1)' }} />
        </div>
      </div>
      {waterState > 0 && (
        <button onClick={() => onAdd(-0.25)} aria-label="Remove 250 ml of water"
                className="w-9 h-9 shrink-0 rounded-xl grid place-items-center" style={{ color: t.mute, border: `1px solid ${t.border}` }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
        </button>
      )}
      {[250, 500].map((ml) => (
        <button key={ml} onClick={() => onAdd(ml / 1000)} aria-label={`Add ${ml} ml of water`}
                className="h-9 px-2.5 shrink-0 rounded-xl font-grotesk text-[12px] font-bold tabular-nums transition-transform active:scale-95"
                style={{ background: t.waterDim, color: t.water }}>
          +{ml}
        </button>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   EDIT LOG MODAL — edit quantity of a logged food entry
   ════════════════════════════════════════════════════════════════ */

function EditLogModal({ open, log, onClose, onSave, t }) {
  const [quantity, setQuantity] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open && log) setQuantity(String(log.quantity || 100)); }, [open, log?.id]);
  const panelRef = useDialog(open && !!log, onClose);
  if (!open || !log) return null;

  const origQty = Number(log.quantity) || 100;
  const newQty = Math.max(0.1, Number(quantity) || 0);
  const scale = origQty > 0 ? newQty / origQty : 1;
  const preview = {
    calories: Math.round(log.calories * scale * 10) / 10,
    protein: Math.round(log.protein * scale * 10) / 10,
    carbs: Math.round(log.carbs * scale * 10) / 10,
    fat: Math.round(log.fat * scale * 10) / 10,
  };

  const handleSave = async () => { setSaving(true); await onSave(log.id, { quantity: newQty, unit: log.unit }); setSaving(false); };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}
      role="dialog" aria-modal="true" aria-label={`Edit ${log.name}`}>
      <div ref={panelRef} className="w-full max-w-sm rounded-3xl overflow-hidden anim-scaleIn" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>
        <div className="px-5 pt-5 pb-3 flex items-start justify-between">
          <div>
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.accent }}>Edit Entry</div>
            <div className="font-grotesk text-base font-bold mt-1" style={{ color: t.ink }}>{log.name}</div>
          </div>
          <button className="w-8 h-8 rounded-full grid place-items-center text-sm transition-colors shrink-0" onClick={onClose} aria-label="Close" style={{ background: t.glass, color: t.mute, border: `1px solid ${t.border}` }}><XIcon /></button>
        </div>
        <div className="px-5 pb-4">
          <label htmlFor="edit-log-quantity" className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-1.5 block" style={{ color: t.mute }}>Quantity ({log.unit || 'g'})</label>
          <input id="edit-log-quantity" type="number" className="w-full px-4 py-3 rounded-xl font-grotesk text-sm font-bold outline-none" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }} value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus />
        </div>
        <div className="px-5 pb-4">
          <div className="rounded-xl p-3" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2" style={{ color: t.mute }}>Updated Nutrition</div>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[['Calories', log.calories, preview.calories, 'kcal'], ['Protein', log.protein, preview.protein, 'g'], ['Carbs', log.carbs, preview.carbs, 'g'], ['Fat', log.fat, preview.fat, 'g']].map(([label, old, newVal, unit]) => (
                <div key={label}>
                  <div className="font-grotesk text-[10px]" style={{ color: t.mute }}>{label}</div>
                  <div className="font-grotesk text-xs font-bold" style={{ color: t.ink }}>{old}{unit}</div>
                  {Math.abs(old - newVal) > 0.5 && <div className="font-grotesk text-[10px] font-semibold" style={{ color: t.accent }}>→ {newVal}{unit}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="px-5 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-semibold transition-all active:scale-95" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.mute }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || newQty <= 0} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={{ background: (saving || newQty <= 0) ? t.surface : t.accent, color: (saving || newQty <= 0) ? t.mute : 'var(--accent-contrast)', border: `1px solid ${(saving || newQty <= 0) ? t.border : t.accent}`, opacity: (saving || newQty <= 0) ? 0.5 : 1, cursor: (saving || newQty <= 0) ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving…' : 'Save Changes'}</button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   MAIN NUTRITION PAGE
   ════════════════════════════════════════════════════════════════ */

export default function Nutrition() {
  const [confirm, confirmDialog] = useConfirm();
  // `resolved` (never the raw choice): 'system' is now a storable
  // value, and every comparison below is against light/dark.
  const { resolved: theme } = useTheme();
  const t = T[theme] || T.dark;

  const home = useOutletContext();
  const [meals, setMeals] = useState(null);
  const [water, setWater] = useState(null);
  const [supTaken, setSupTaken] = useState({});
  const [toast, setToast] = useState('');
  const [supList, setSupList] = useState(null);
  const [supForm, setSupForm] = useState({ name: '', dose: '' });
  const [savingSup, setSavingSup] = useState(false);
  const [targetSetupOpen, setTargetSetupOpen] = useState(false);
  // Closed without saving: not offered again until the next visit.
  const [targetDismissed, setTargetDismissed] = useState(false);
  // The logger stays mounted after its first open, so it can slide away.
  const [plateMounted, setPlateMounted] = useState(false);
  const [editLogOpen, setEditLogOpen] = useState(false);
  const [editLog, setEditLog] = useState(null);
  const [foodLogSheetOpen, setFoodLogSheetOpen] = useState(false);
  const [foodLogAutoScan, setFoodLogAutoScan] = useState(false);
  // Controlled by this page, not FoodLogSheet itself -- see that
  // component's own comment on why (Custom Macros' "keep sheet open for
  // the next entry" flow needs the parent to own which tab is active).
  // Silently dropped by this merge's auto-merge (same defect class as
  // effectivePlan/activePlan/balance a few lines above): FoodLogSheet
  // crashed with "setMode is not a function" the moment it rendered,
  // because the prop it requires was never being passed at all.
  const [foodLogMode, setFoodLogMode] = useState('search');

  // The plate logger, and which meal its foods are filed under -- always the
  // clock's ("breakfast" at 8am). It is never asked for: see TodayLog.jsx.
  const [plate, setPlate] = useState({ open: false, slot: slotForTime(), text: '', seed: null });
  const [nowSlot, setNowSlot] = useState(slotForTime);
  const [logTick, setLogTick] = useState(0);
  // A toast that can take back what just happened (log, remove).
  const [undo, setUndo] = useState(null);

  // The tools row's sheets.
  const [savedOpen, setSavedOpen] = useState(false);
  const [supOpen, setSupOpen] = useState(false);
  const [plateSeed, setPlateSeed] = useState(null);
  const [usuals, setUsuals] = useState([]);

  // Food & Meal Tools sheets
  const [shareOpen, setShareOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  const data = home.data;
  const clientId = data?.client?.id;

  useEffect(() => { if (clientId) api(`/tracking/clients/${clientId}/supplements`).then((r) => setSupList(r.supplements || [])).catch(() => {}); }, [clientId]);
  // The usual foods for this time of day, refreshed after every log so a
  // food logged once is one tap the next time.
  useEffect(() => {
    let live = true;
    api(`/me/nutrition/usuals?slot=${nowSlot}`).then((r) => live && setUsuals(r.usuals || [])).catch(() => {});
    return () => { live = false; };
  }, [nowSlot, logTick]);

  const plan = data?.nutrition?.plan;
  // Flexible Calorie Balance -- this whole block (through effectivePlan
  // below) was silently dropped by git's auto-merge: manavi's branch
  // predates this feature entirely (no CalorieBalance import, no
  // /me/nutrition/balance fetch), so the region auto-merged to HER
  // simpler version everywhere it didn't textually conflict, not just at
  // the one spot git actually flagged. Restored -- this is a real,
  // already-shipped feature, not something a merge gets to drop.
  const balance = useFetch(() => api('/me/nutrition/balance'), []);
  const activePlan = balance.data?.activePlan;

  useEffect(() => { if (data && !plan && !targetSetupOpen && !targetDismissed) setTargetSetupOpen(true); }, [data, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const mealState = meals || data?.nutrition?.meals || [];
  const waterState = water ?? (data ? data.water.litres : 0);

  const eaten = mealState.filter((m) => m.eaten).reduce((s, m) => ({
    calories: s.calories + m.calories, protein: s.protein + m.protein,
    carbs: s.carbs + m.carbs, fat: s.fat + m.fat
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  useEffect(() => { if (!toast) return; const h = setTimeout(() => setToast(''), 2400); return () => clearTimeout(h); }, [toast]);
  useEffect(() => { if (!undo) return; const h = setTimeout(() => setUndo(null), 8000); return () => clearTimeout(h); }, [undo]);
  // The meal the composer offers follows the clock across a long-open tab.
  useEffect(() => { const h = setInterval(() => setNowSlot(slotForTime()), 5 * 60 * 1000); return () => clearInterval(h); }, []);

  if (home.loading) return <PageSkeleton variant="dashboard" label="Loading your fuel plan" />;
  if (home.error) return <ErrorState error={home.error} onRetry={home.reload} />;

  const toggleMeal = async (m) => {
    const next = !m.eaten;
    setMeals(mealState.map((x) => (x.id === m.id ? { ...x, eaten: next } : x)));
    // Optimistic update -- on failure, reconcile back to server truth AND
    // say why, rather than the toggle silently reverting itself a moment
    // later with no explanation (what a bare `.catch(() => home.reload())`
    // looked like to the user).
    try {
      await api(`/nutrition/clients/${clientId}/meals/toggle`, { method: 'POST', body: JSON.stringify({ meal_id: m.id, eaten: next }) });
    } catch (e) {
      setToast(e.message || "Couldn't update that — reverted");
      home.reload({ silent: true });
    }
  };

  const editLogEntry = async (logId, updates) => {
    try {
      await api(`/me/meal-logs/${logId}`, { method: 'PUT', body: JSON.stringify(updates) });
      setToast('Entry updated ✓');
      setEditLogOpen(false); setEditLog(null);
      home.reload({ silent: true });
    } catch (e) { setToast(e.message); }
  };

  /* Asks through the app's own confirmation (useConfirm). The question
     used to be a hand-rolled overlay: no dialog role or name, focus left
     on the page behind it, no Escape and no scroll lock. */
  // Removing is immediate, with Undo -- not a dialog in front of every
  // slip of the thumb. Undo writes the same row back (same meal, amount and
  // numbers), which is all a meal_logs row is.
  const deleteLogEntry = async (log) => {
    try {
      await api(`/me/meal-logs/${log.id}`, { method: 'DELETE' });
      home.reload({ silent: true });
      setUndo({
        label: `Removed ${log.name}`,
        run: async () => {
          await api(`/nutrition/clients/${clientId}/meals/log`, {
            method: 'POST',
            body: JSON.stringify({
              name: log.name, slot: log.slot || 'snack',
              calories: Math.round(Number(log.calories) || 0),
              protein: Number(log.protein) || 0, carbs: Number(log.carbs) || 0, fat: Number(log.fat) || 0,
              eaten: true,
              source: ['manual', 'ai', 'ai_estimated', 'ai_estimated_user_adjusted', 'knn_estimated'].includes(log.source) ? log.source : 'manual',
              ...(log.quantity != null ? { quantity: Number(log.quantity) } : {}),
              ...(log.unit ? { unit: String(log.unit).slice(0, 30) } : {}),
            }),
          });
          home.reload({ silent: true });
        },
      });
    } catch (e) { setToast(e.message); }
  };

  const openPlate = ({ slot, text = '', seed = null, items = null } = {}) => {
    setPlateSeed(items);
    setPlateMounted(true);
    setPlate({ open: true, slot: slot || nowSlot, text, seed });
  };

  const onPlateLogged = ({ ids, count, calories }) => {
    home.reload({ silent: true });
    setLogTick((n) => n + 1);
    setUndo({
      label: `${count} ${count === 1 ? 'item' : 'items'} · ${calories} kcal logged`,
      run: async () => {
        await Promise.all(ids.map((id) => api(`/me/meal-logs/${id}`, { method: 'DELETE' })));
        home.reload({ silent: true });
      },
    });
  };

  const addWater = async (litres = 0.25) => {
    const next = nextWaterLitres(waterState, litres);
    setWater(next);
    // Same reasoning as toggleMeal above -- a silent revert with no toast
    // reads as "the app randomly undid my tap", not "that failed".
    try {
      await api(`/tracking/clients/${clientId}/water`, { method: 'POST', body: JSON.stringify({ litres: next }) });
    } catch (e) {
      setToast(e.message || "Couldn't log water — reverted");
      home.reload({ silent: true });
    }
  };

  // Which sources mean "these numbers are an ESTIMATE, not a measured
  // food". Derived from `source` in one place rather than asked of each
  // caller: meal_logs.estimate exists precisely to mark AI-estimated
  // nutrition, and every caller that forgot to set it wrote a row claiming
  // its numbers were measured. Nothing reads the column today, which is
  // exactly why it was silently wrong -- the first feature to show an
  // "estimated" badge would have inherited the bad data.
  const ESTIMATED_SOURCES = new Set(['ai', 'ai_estimated', 'ai_estimated_user_adjusted', 'knn_estimated']);

  const logEntry = async (entry) => {
    const source = entry.source || 'manual';
    // Round ONCE, here, at the only point every food log passes through.
    // Callers scale macros by arbitrary factors (1.5 bowls, 3 servings,
    // 245/100 g), so binary floating point routinely produced values like
    // 98.10000000000001 g of protein. Every screen rounds for DISPLAY, so
    // this was invisible in the app while the stored row, the API response
    // and any export carried the noise. Grams to 0.1 (finer than any
    // kitchen scale or food label), calories to whole numbers.
    const r1v = (n) => (n == null ? undefined : Math.round(Number(n) * 10) / 10);
    await api(`/nutrition/clients/${clientId}/meals/log`, {
      method: 'POST',
      body: JSON.stringify({
        name: entry.name, slot: plate.slot || mealGroup(nowSlot),
        calories: Math.round(Number(entry.calories) || 0),
        protein: r1v(entry.protein), carbs: r1v(entry.carbs), fat: r1v(entry.fat),
        source, eaten: true,
        estimate: ESTIMATED_SOURCES.has(source),
        ai_provider: entry.ai_provider || undefined,
        ai_model: entry.ai_model || undefined,
        ai_confidence: entry.ai_confidence || undefined,
        // The amount actually eaten, forwarded exactly as the caller
        // measured it (245 + 'g' for a resolved portion, 1.5 + 'bowl' for
        // a countable Custom Macros entry). This used to be dropped here
        // even though every caller supplies it and the route has always
        // stored it -- which quietly broke "Edit Quantity" later:
        // PUT /me/meal-logs/:id scales by newQty / (log.quantity || 100),
        // so a NULL quantity made it assume the entry was 100 g. Editing
        // a 1.5-bowl log to 2 bowls scaled by 2/100 and turned 52.5 g of
        // protein into 1.05 g. Send it, and the edit scales from the real
        // baseline. `?? undefined` so a genuinely absent quantity stays
        // absent rather than becoming 0.
        quantity: entry.quantity ?? undefined,
        unit: entry.unit ?? undefined,
      }),
    });
    home.reload({ silent: true });
  };

  const eatenTodayList = mealState.filter((m) => m.eaten);

  // Today's EFFECTIVE target -- the adjusted target while a Flexible
  // Calorie Balance plan is active, otherwise the base plan unchanged.
  // One shared object so the ring, macro bars, and the insight line below
  // can never drift out of sync with each other (a real gap caught live:
  // the insight text initially still read off the base `plan` after the
  // ring/bars below were already switched over).
  const effectivePlan = activePlan
    ? { calories: activePlan.adjustedCalorieTarget, protein: activePlan.adjustedProteinTarget, carbs: activePlan.adjustedCarbsTarget, fat: activePlan.adjustedFatTarget }
    : plan;

  return (
    <div className="space-y-5 pb-24">

      {/* ══════ HEADER ══════ */}
      <h1 className="font-grotesk font-black text-2xl leading-tight" style={{ color: t.ink }}>Today's Fuel</h1>

      {/* ══════ TODAY'S NUMBERS ══════ */}
      <div data-tour="nutrition-hero" className="relative overflow-hidden rounded-3xl px-5 pt-5 pb-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: t.heroGlow }} />
        <div className="absolute top-3 right-3 z-20">
          <InfoDot label="About these rings" title="Today's rings" align="end" size={28}>
            The outer ring is calories against today's target{activePlan ? ' (adjusted by your calorie balance plan)' : ''}. Inside it: protein, carbs and fat. The number in the middle is what is left.
            {plan && <> Target: {effectivePlan?.calories} kcal · P {effectivePlan?.protein} g · C {effectivePlan?.carbs} g · F {effectivePlan?.fat} g.</>}
          </InfoDot>
        </div>
        <div className="relative z-10 flex flex-col items-center">
          <button type="button" onClick={() => setTargetSetupOpen(true)} aria-label="Edit daily target" className="rounded-full">
            <FuelRings eaten={eaten} target={effectivePlan} size={204} />
          </button>
          <div className="w-full grid grid-cols-3 gap-4 mt-4">
            <MacroStat label="Protein" value={eaten.protein} max={effectivePlan?.protein || 0} color={t.protein} t={t} />
            <MacroStat label="Carbs" value={eaten.carbs} max={effectivePlan?.carbs || 0} color={t.carbs} t={t} />
            <MacroStat label="Fat" value={eaten.fat} max={effectivePlan?.fat || 0} color={t.fat} t={t} />
          </div>
        </div>
      </div>

      {/* ══════ LOG ══════ */}
      <LogCard
        slot={nowSlot}
        usuals={usuals}
        meals={mealState}
        onLogged={onPlateLogged}
        onAdjust={(items) => openPlate({ items })}
        onOpenFull={() => openPlate({})}
        onToggle={toggleMeal}
        onEdit={(m) => { setEditLog(m); setEditLogOpen(true); }}
        onDelete={deleteLogEntry}
      />

      {/* ══════ TOOLS ══════
          Everything that is not logging or today's numbers, as one row of
          labelled icons: visible, one tap, and no sentences. */}
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Meal tools">
        {[
          ['Customize', () => setCustomizeOpen(true), 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'],
          ['Saved', () => setSavedOpen(true), 'M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z'],
          ['Breakdown', () => setInfoOpen(true), 'M3 3v18h18M8 17V10M13 17V7M18 17v-4'],
          ['Supplements', () => setSupOpen(true), 'M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7ZM8.5 8.5l7 7'],
          ['Target', () => setTargetSetupOpen(true), 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'],
          ['Share', () => setShareOpen(true), 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13'],
        ].map(([label, go, d]) => (
          <button key={label} type="button" onClick={go}
                  className="h-16 rounded-2xl flex flex-col items-center justify-center gap-1.5 font-grotesk text-[11.5px] font-semibold transition-transform active:scale-95"
                  style={{ background: t.surface, border: `1px solid ${t.border}`, color: t.ink }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: t.mute }}><path d={d} /></svg>
            {label}
          </button>
        ))}
      </div>

      {/* ══════ NET ENERGY ══════ */}
      <NetEnergyCard t={t} refreshKey={Math.round(eaten.calories)} />

      {/* ══════ FLEXIBLE CALORIE BALANCE (only when it has something to say) ══════ */}
      {plan && <CalorieBalance balance={balance} t={t} onToast={setToast} baseTarget={plan} />}

      {/* ══════ WATER ══════ */}
      <HydrationCard waterState={waterState} target={data.water.target} onAdd={addWater} t={t} />

      {/* ══════ SUPPLEMENTS -- only for people who take any ══════ */}
      {(supList || []).length > 0 && (
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1" role="group" aria-label="Supplements taken today">
          {supList.map((sup) => {
            const taken = !!supTaken[sup.id];
            return (
              <button key={sup.id} type="button" aria-pressed={taken}
                      onClick={() => setSupTaken((x) => ({ ...x, [sup.id]: !taken }))}
                      className="shrink-0 h-9 pl-2 pr-3 rounded-xl flex items-center gap-1.5 font-grotesk text-[12.5px] font-semibold whitespace-nowrap"
                      style={taken
                        ? { background: t.accent, color: 'var(--accent-contrast)' }
                        : { background: t.surface, color: t.ink, border: `1px solid ${t.border}` }}>
                <span className="w-4 h-4 rounded-md grid place-items-center text-[9px]"
                      style={{ border: `1.5px solid ${taken ? 'currentColor' : t.border}` }}>{taken && <CheckIcon />}</span>
                {sup.name}
              </button>
            );
          })}
        </div>
      )}

      {/* ══════ SAVED FOODS & MEALS (a library, so it is a sheet, not page weight) ══════ */}
      <Sheet open={savedOpen} onClose={() => setSavedOpen(false)} title="Saved foods & meals" wide>
        <MyDietCard clientId={clientId} onLogged={(entry) => (entry ? logEntry(entry) : home.reload({ silent: true }))} t={t} toast={setToast} />
      </Sheet>

      {/* ══════ SUPPLEMENTS LIST ══════ */}
      <Sheet open={supOpen} onClose={() => { setSupOpen(false); setSupForm({ name: '', dose: '' }); }} title="Supplements">
        <div className="space-y-2">
          {(supList || []).map((sup) => (
            <div key={sup.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5" style={{ border: `1px solid ${t.border}` }}>
              <span className="min-w-0 flex-1">
                <span className="block font-grotesk text-[14px] font-semibold truncate" style={{ color: t.ink }}>{sup.name}</span>
                {sup.dose && <span className="block font-grotesk text-[11.5px]" style={{ color: t.mute }}>{sup.dose}</span>}
              </span>
              <button className="w-8 h-8 rounded-lg grid place-items-center shrink-0" aria-label={`Delete ${sup.name}`} style={{ color: t.danger }}
                      onClick={async () => { if (!(await confirm({ title: `Delete "${sup.name}"?`, confirmLabel: 'Delete supplement' }))) return; try { await api(`/tracking/clients/${clientId}/supplements/${sup.id}`, { method: 'DELETE' }); const r = await api(`/tracking/clients/${clientId}/supplements`); setSupList(r.supplements || []); } catch (err) { setToast(err.message || 'Failed to delete supplement'); } }}>
                <XIcon />
              </button>
            </div>
          ))}
          <form className="pt-2 space-y-2" onSubmit={async (e) => { e.preventDefault(); if (!supForm.name.trim()) return; setSavingSup(true); try { await api(`/tracking/clients/${clientId}/supplements`, { method: 'POST', body: JSON.stringify({ name: supForm.name.trim(), dose: supForm.dose || undefined }) }); setSupForm({ name: '', dose: '' }); const r = await api(`/tracking/clients/${clientId}/supplements`); setSupList(r.supplements || []); } catch (err) { setToast(err.message); } setSavingSup(false); }}>
            <input className="w-full px-3 py-2.5 rounded-xl font-grotesk text-sm outline-none" placeholder="Add a supplement, e.g. Omega 3" aria-label="Supplement name"
                   style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={supForm.name} onChange={(e) => setSupForm((f) => ({ ...f, name: e.target.value }))} />
            {supForm.name.trim() && (
              <div className="flex gap-2">
                <input className="flex-1 min-w-0 px-3 py-2.5 rounded-xl font-grotesk text-sm outline-none" placeholder="Dose (optional)" aria-label="Dose"
                       style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={supForm.dose} onChange={(e) => setSupForm((f) => ({ ...f, dose: e.target.value }))} />
                <button type="submit" disabled={savingSup} className="px-4 rounded-xl font-grotesk text-[13px] font-bold"
                        style={{ background: t.accent, color: 'var(--accent-contrast)' }}>{savingSup ? '…' : 'Add'}</button>
              </div>
            )}
          </form>
        </div>
      </Sheet>

      {/* ══════ TOAST ══════ */}
      {/* Portalled to <body>: ClientLayout animates every page with a
          transform that stays applied, and a transformed ancestor makes
          `position: fixed` relative to IT -- these toasts measured at
          y=1240 in an 812px viewport, below the fold, until portalled. */}
      {createPortal((
        <>
          {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full font-grotesk text-xs shadow-lg anim-toast" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink, boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>{toast}</div>}
          <AnimatePresence>
            {undo && (
              <motion.div
                key={undo.label}
                role="status" aria-live="polite"
                initial={{ opacity: 0, y: 16, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: 16, x: '-50%' }}
                className="fixed bottom-24 left-1/2 z-50 flex items-center gap-3 pl-4 pr-1.5 py-1.5 rounded-2xl font-grotesk text-[12.5px] max-w-[calc(100vw-32px)]"
                style={{ background: 'var(--ink)', color: 'var(--bg)', boxShadow: '0 12px 34px rgba(0,0,0,0.3)' }}
              >
                <span className="truncate">{undo.label}</span>
                <button type="button" className="shrink-0 h-8 px-3 rounded-xl font-bold"
                        style={{ background: 'color-mix(in srgb, var(--bg) 16%, transparent)', color: 'var(--bg)' }}
                        onClick={async () => { const u = undo; setUndo(null); try { await u.run(); setToast('Undone'); } catch (e) { setToast(e.message || 'Could not undo'); } }}>
                  Undo
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ), document.body)}

      {/* ══════ NUTRITION TARGET SETUP ══════ */}
      <NutritionTargetSetup open={targetSetupOpen}
                            onComplete={() => { setTargetSetupOpen(false); home.reload({ silent: true }); }}
                            onClose={() => { setTargetSetupOpen(false); setTargetDismissed(true); }}
                            currentPlan={plan} isEdit={!!plan} />

      {/* ══════ MODALS ══════ */}
      {confirmDialog}
      <EditLogModal open={editLogOpen} log={editLog} onClose={() => { setEditLogOpen(false); setEditLog(null); }} onSave={editLogEntry} t={t} />

      {/* ══════ PLATE LOGGER ══════ */}
      {plateMounted && (
        <Suspense fallback={null}>
          <PlateSheet
            open={plate.open}
            initialSlot={plate.slot}
            initialText={plate.text}
            seed={plate.seed}
            seedItems={plateSeed}
            onClose={() => { setPlate((p) => ({ ...p, open: false, text: '', seed: null })); setPlateSeed(null); }}
            onLogged={onPlateLogged}
            onClassic={(mode) => {
              setPlate((p) => ({ ...p, open: false }));
              setFoodLogMode(mode === 'barcode' ? 'search' : mode);
              setFoodLogAutoScan(mode === 'barcode');
              setFoodLogSheetOpen(true);
            }}
          />
        </Suspense>
      )}

      {/* ══════ FOOD LOG SHEET (search, barcode, mic, AI estimate) ══════ */}
      <FoodLogSheet
        open={foodLogSheetOpen}
        autoScan={foodLogAutoScan}
        mode={foodLogMode}
        setMode={setFoodLogMode}
        toast={setToast}
        onClose={() => { setFoodLogSheetOpen(false); setFoodLogAutoScan(false); }}
        onAdd={async (entry, opts) => {
          await logEntry(entry);
          // `opts?.keepOpen` -- a quick-log path (currently: Custom Macros)
          // that wants to stay on the sheet for the next entry rather than
          // exiting back to the dashboard. Backward compatible: every
          // existing call site that doesn't pass a second argument keeps
          // closing exactly as before.
          if (!opts?.keepOpen) { setFoodLogSheetOpen(false); setFoodLogAutoScan(false); }
          setToast(opts?.keepOpen ? `${entry.name} logged ✓` : 'Food logged ✓');
        }}
      />

      {/* ══════ SHARE MEALS ══════ */}
      <ShareMealsSheet open={shareOpen} onClose={() => setShareOpen(false)} t={t} />

      {/* ══════ CUSTOMIZE MY MEALS ══════
          onLogged was bare `home.reload` here (Manavi's branch predates
          the silent-reload fix) -- a non-silent reload flips
          `home.loading` back to true, and this page's own loading gate
          (PageSkeleton, above) would unmount the whole page -- including
          this very sheet -- mid-edit, for the duration of the refetch.
          Same class of bug as foodLogMode above. */}
      <CustomizeMealSheet open={customizeOpen} onClose={() => setCustomizeOpen(false)} onLogged={() => home.reload({ silent: true })} t={t} toast={setToast} />

      {/* ══════ INFORMATION ABOUT MY MEALS ══════ */}
      <MealInfoSheet open={infoOpen} onClose={() => setInfoOpen(false)} meals={eatenTodayList} plan={plan} goal={data?.client?.goal} t={t} />
    </div>
  );
}
