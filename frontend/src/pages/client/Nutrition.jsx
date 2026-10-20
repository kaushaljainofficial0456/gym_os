import { useEffect, useState, useMemo, lazy, Suspense } from 'react';
import { useOutletContext } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { useTheme } from '../../themeContext.jsx';
import { api } from '../../api.js';
import { useCountUp, useFetch } from '../../utils.js';
import { ErrorState, CheckIcon, XIcon, PageSkeleton, useConfirm, useDialog } from '../../components/UI.jsx';
import NutritionTargetSetup from '../../components/NutritionTargetSetup.jsx';
import FoodLogSheet from '../../components/FoodLogSheet.jsx';
import MyDietCard from '../../components/nutrition/MyDietCard.jsx';
import CalorieBalance from '../../components/nutrition/CalorieBalance.jsx';
import NetEnergyCard from '../../components/nutrition/NetEnergyCard.jsx';
import ShareMealsSheet from '../../components/nutrition/ShareMealsSheet.jsx';
import CustomizeMealSheet from '../../components/nutrition/CustomizeMealSheet.jsx';
import MealInfoSheet from '../../components/nutrition/MealInfoSheet.jsx';
import FuelRings from '../../components/nutrition/FuelRings.jsx';
import QuickComposer from '../../components/nutrition/logger/QuickComposer.jsx';
import MealSlots from '../../components/nutrition/logger/MealSlots.jsx';
import { slotForTime, slotLabel, mealGroup } from '../../components/nutrition/logger/plate.js';
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
    water: '#5B9AA3',
    waterDim: 'rgba(91,154,163,0.10)',
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
    water: '#3E7B85',
    waterDim: 'rgba(62,123,133,0.10)',
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

function MacroBar({ label, value, max, color, t }) {
  const frac = max > 0 ? Math.min(value / max, 1.5) : 0;
  const animVal = useCountUp(Math.round(value), 1000);
  const over = value > max && max > 0;
  const faded = (pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

  return (
    <div className="flex items-center gap-3">
      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 8px ${faded(40)}` }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between mb-1">
          <span className="font-grotesk text-[11px] font-semibold" style={{ color: t.mute }}>{label}</span>
          <span className="font-grotesk text-[12px] font-bold tabular-nums" style={{ color: over ? t.danger : t.ink }}>
            {animVal}<span className="font-normal" style={{ color: t.faint }}> / {max || 0}g</span>
          </span>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ background: t.ringTrack }}>
          <div className="h-full rounded-full" style={{
            width: `${Math.min(frac * 100, 100)}%`,
            background: `linear-gradient(90deg, ${faded(80)}, ${color})`,
            transition: 'width 1s cubic-bezier(.22,.8,.3,1)',
            boxShadow: `0 0 10px ${faded(30)}`,
          }} />
        </div>
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
  const pct = target > 0 ? Math.min(waterState / target, 1) : 0;
  const animLitres = useCountUp(waterState * 10, 800) / 10;

  /* A GLASS THAT FILLS, and buttons that say what people actually drink.
   *
   * This was a row of twelve identical squares you toggled one quarter-
   * litre at a time -- about 26px each on a phone, so hitting the right
   * one was a aim test, and four taps to record a bottle. Worse, the way
   * to correct a mistake was "tap a filled one", which nothing on screen
   * could have told you.
   *
   * Now the vessel IS the display: it fills as you drink, so the state is
   * one glance rather than counting squares. Adding is three real
   * amounts -- a glass, a bottle, a big bottle -- and a mistake is undone
   * by an Undo button that says so, instead of a hidden second meaning
   * for the same tap.
   */
  const ADD_AMOUNTS = [
    { ml: 250, label: 'Glass', sub: '250 ml' },
    { ml: 500, label: 'Bottle', sub: '500 ml' },
    { ml: 1000, label: 'Large', sub: '1 L' },
  ];
  const fillPct = Math.min(100, pct * 100);

  return (
    <div data-tour="nutrition-water" className="relative overflow-hidden rounded-2xl p-5"
         style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
      <div className="absolute inset-0 pointer-events-none"
           style={{ background: `linear-gradient(180deg, transparent 60%, ${t.waterDim})`, opacity: pct * 0.6 }} />
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-4">
          <div className="font-grotesk text-[11px] uppercase tracking-[.16em] font-semibold flex items-center gap-2"
               style={{ color: t.mute }}>
            <span className="inline-block w-1 h-1 rounded-full" style={{ background: t.accent }} />Water
          </div>
          <div className="font-grotesk text-[10px]" style={{ color: t.mute }}>
            {Math.round(pct * 100)}% of {target}L
          </div>
        </div>

        <div className="flex items-center gap-5">
          {/* The vessel. Its fill is the reading -- no counting required. */}
          <div className="relative shrink-0" style={{ width: 74, height: 104 }} aria-hidden="true">
            <div className="absolute inset-0 overflow-hidden"
                 style={{
                   borderRadius: '10px 10px 26px 26px',
                   border: `2px solid ${t.border}`,
                   background: t.glass,
                 }}>
              <div
                className="absolute inset-x-0 bottom-0"
                style={{
                  height: `${fillPct}%`,
                  background: `linear-gradient(180deg, ${t.water}CC, ${t.water})`,
                  transition: 'height .7s cubic-bezier(.22,.8,.3,1)',
                }}
              >
                {/* The meniscus, so the level reads as liquid and not as a bar. */}
                <div className="absolute inset-x-0 top-0" style={{ height: 6, background: `linear-gradient(180deg, rgba(255,255,255,.45), transparent)` }} />
              </div>
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1">
              <span className="font-grotesk font-black tabular-nums leading-none" style={{ fontSize: 34, color: t.water }}>
                {animLitres.toFixed(1)}
              </span>
              <span className="font-grotesk text-[13px] font-medium" style={{ color: t.mute }}>/ {target} L</span>
            </div>
            <div className="font-grotesk text-[11px] mt-1" style={{ color: t.mute }}>
              {waterState >= target
                ? "Target reached — nice."
                : `${Math.max(0, Math.round((target - waterState) * 1000))} ml to go`}
            </div>

            {/* Real amounts, at a real size. */}
            <div className="grid grid-cols-3 gap-1.5 mt-3">
              {ADD_AMOUNTS.map((a) => (
                <button
                  key={a.ml}
                  onClick={() => onAdd(a.ml / 1000)}
                  className="rounded-xl px-1 py-2 transition-transform active:scale-95"
                  style={{ background: t.waterDim, border: `1px solid ${t.water}40`, color: t.water, minHeight: 48 }}
                  aria-label={`Add ${a.sub} of water`}
                >
                  <span className="block font-grotesk text-[12px] font-bold leading-none">+{a.label}</span>
                  <span className="block font-grotesk text-[9.5px] mt-0.5" style={{ color: t.mute }}>{a.sub}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* A named way back, rather than a hidden second meaning for the
            same tap. Only offered when there is something to undo. */}
        {waterState > 0 && (
          <button
            onClick={() => onAdd(-0.25)}
            className="mt-3 w-full rounded-lg font-grotesk text-[11px] font-semibold transition-colors"
            style={{ minHeight: 38, border: `1px solid ${t.border}`, color: t.mute }}
            aria-label="Remove 250 ml of water"
          >
            Undo 250 ml
          </button>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   NUTRITION INSIGHT
   ════════════════════════════════════════════════════════════════ */

function NutritionInsight({ plan, eaten, t }) {
  /* AN EMPTY MORNING IS NOT A FAILURE.
   *
   * This said "2625 kcal away from today's target" before you had eaten
   * anything, in a tinted alert box, at the top of the page. At 8am that
   * is not information -- it is the whole day's target restated as a
   * shortfall, and the first thing the app says to you is that you are
   * behind. Nobody is behind at breakfast.
   *
   * So the line is read against the CLOCK as well as the plate: an
   * untouched day reads as open early and only becomes a nudge late,
   * and the pace line only appears once there is a pace to have. The
   * genuinely useful case -- protein trailing, which is the macro people
   * actually miss and the one worth acting on -- is kept and promoted. */
  const insight = useMemo(() => {
    if (!plan) return null;
    const remaining = Math.round(plan.calories - eaten.calories);
    const hour = new Date().getHours();
    const nothingYet = eaten.calories <= 0;

    if (nothingYet) {
      if (hour < 11) return { text: "Today's a clean slate. Log breakfast whenever you get to it.", tone: 'accent' };
      if (hour < 17) return { text: 'Nothing logged yet — add what you had and the rest of the day fills in.', tone: 'accent' };
      return { text: "Nothing logged today. Even a rough entry beats a blank day.", tone: 'accent' };
    }

    if (remaining <= 0) {
      const over = Math.abs(remaining);
      return over > 150
        ? { text: `${over} kcal over target — one day is a data point, not a trend.`, tone: 'accent' }
        : { text: "You've hit your calorie target for today.", tone: 'gold' };
    }

    const proteinLeft = Math.round(plan.protein - eaten.protein);
    const proteinPct = plan.protein > 0 ? (eaten.protein / plan.protein) * 100 : 100;
    const caloriePct = plan.calories > 0 ? (eaten.calories / plan.calories) * 100 : 0;
    // Trailing by a real margin, not merely lowest by a rounding error.
    if (proteinLeft > 0 && proteinPct + 15 < caloriePct) {
      return { text: `Protein's lagging your calories — ${proteinLeft}g still to go.`, tone: 'protein' };
    }

    return { text: `${remaining} kcal left today.`, tone: 'accent' };
  }, [plan, eaten]);

  if (!insight) return null;
  const colors = { accent: t.accent, gold: t.gold, protein: t.protein };
  const color = colors[insight.tone] || t.accent;
  const faded = (pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl" style={{ background: faded(8), border: `1px solid ${faded(18)}` }}>
      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${faded(60)}` }} />
      <span className="font-grotesk text-[11px] font-medium" style={{ color }}>{insight.text}</span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   SECTION HEADER
   ════════════════════════════════════════════════════════════════ */

function SectionHeader({ title, subtitle, action, t, kicker = false }) {
  if (kicker) {
    return (
      <div className="flex items-end justify-between mb-4">
        <div>
          <div className="font-grotesk text-[11px] font-semibold uppercase tracking-[.16em] flex items-center gap-2 mb-1" style={{ color: t.mute }}>
            <span className="inline-block w-1 h-1 rounded-full" style={{ background: t.accent }} />{title}
          </div>
          {subtitle && <div className="font-grotesk text-[11px] font-medium" style={{ color: t.mute }}>{subtitle}</div>}
        </div>
        {action}
      </div>
    );
  }
  return (
    <div className="flex items-end justify-between mb-3">
      <div>
        <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.mute }}>{title}</div>
        {subtitle && <div className="font-grotesk text-[10px] mt-0.5" style={{ color: t.faint }}>{subtitle}</div>}
      </div>
      {action}
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
  const [editLogOpen, setEditLogOpen] = useState(false);
  const [editLog, setEditLog] = useState(null);
  const [supplementsExpanded, setSupplementsExpanded] = useState(false);
  const [showAddSupplement, setShowAddSupplement] = useState(false);
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

  // The plate logger, and which meal it is logging to. The meal defaults to
  // the clock ("breakfast" at 8am); "+" on a meal sets it explicitly.
  const [plate, setPlate] = useState({ open: false, slot: slotForTime(), text: '', seed: null });
  const [nowSlot, setNowSlot] = useState(slotForTime);
  const [logTick, setLogTick] = useState(0);
  // A toast that can take back what just happened (log, remove).
  const [undo, setUndo] = useState(null);

  // Food & Meal Tools sheets
  const [shareOpen, setShareOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  const data = home.data;
  const clientId = data?.client?.id;

  useEffect(() => { if (clientId) api(`/tracking/clients/${clientId}/supplements`).then((r) => setSupList(r.supplements || [])).catch(() => {}); }, [clientId]);

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

  useEffect(() => { if (data && !plan && !targetSetupOpen) setTargetSetupOpen(true); }, [data, plan]);
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

  const openPlate = ({ slot, text = '', seed = null } = {}) => {
    setPlate({ open: true, slot: slot || nowSlot, text, seed });
  };

  const onPlateLogged = ({ ids, slot, count, calories }) => {
    home.reload({ silent: true });
    setLogTick((n) => n + 1);
    setUndo({
      label: `${count} ${count === 1 ? 'item' : 'items'} · ${calories} kcal → ${slotLabel(slot)}`,
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-grotesk font-black text-2xl leading-tight" style={{ color: t.ink }}>Today's Fuel</h1>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[13px] font-medium" style={{ color: t.mute }}>
              {plan
                ? (activePlan
                  ? `${activePlan.adjustedCalorieTarget} kcal today (base ${plan.calories}) · P${activePlan.adjustedProteinTarget}g · C${activePlan.adjustedCarbsTarget}g · F${activePlan.adjustedFatTarget}g`
                  : `${plan.calories} kcal target · P${plan.protein}g · C${plan.carbs}g · F${plan.fat}g`)
                : 'No plan assigned'}
            </span>
            <button onClick={() => setTargetSetupOpen(true)} aria-label="Edit calorie target" className="w-5 h-5 rounded-md grid place-items-center shrink-0 transition-colors" style={{ color: t.mute, background: t.glass }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            </button>
          </div>
        </div>
        {/* Share Meals -- replaces the old "Log Food" header button. Log/
            estimate now lives in Food & Meal Tools below, alongside
            Customize and Information, as one cohesive tool group. */}
        <button onClick={() => setShareOpen(true)} aria-label="Share meals"
                className="shrink-0 w-10 h-10 rounded-xl grid place-items-center transition-all active:scale-90"
                style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
            <path d="M8.6 10.5 15.4 6.5M8.6 13.5 15.4 17.5" />
          </svg>
        </button>
      </div>

      {/* ══════ TODAY'S FUEL HERO ══════ */}
      <div data-tour="nutrition-hero" className="relative overflow-hidden rounded-3xl p-6" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: t.heroGlow }} />
        <div className="relative z-10">
          <div className="flex flex-col md:flex-row items-center gap-6">
            <FuelRings eaten={eaten} target={effectivePlan} size={216} />
            <div className="flex-1 w-full space-y-4">
              <MacroBar label="Protein" value={eaten.protein} max={effectivePlan?.protein || 0} color={t.protein} t={t} />
              <MacroBar label="Carbs" value={eaten.carbs} max={effectivePlan?.carbs || 0} color={t.carbs} t={t} />
              <MacroBar label="Fat" value={eaten.fat} max={effectivePlan?.fat || 0} color={t.fat} t={t} />
            </div>
          </div>
        </div>
      </div>

      {/* ══════ INSIGHT ══════ */}
      <NutritionInsight plan={effectivePlan} eaten={eaten} t={t} />

      {/* ══════ LOG FOOD ══════
          The one thing most people open this page to do, directly under
          the day's numbers: say or type the meal, or tap a usual. */}
      <QuickComposer slot={nowSlot} refreshKey={logTick} onOpen={(o) => openPlate(o)} />

      {/* ══════ TODAY, BY MEAL ══════ */}
      <MealSlots
        meals={mealState}
        currentSlot={nowSlot}
        onAdd={(slot) => openPlate({ slot })}
        onToggle={toggleMeal}
        onEdit={(m) => { setEditLog(m); setEditLogOpen(true); }}
        onDelete={deleteLogEntry}
      />

      <div className="flex items-center justify-center gap-5 -mt-1">
        {[
          { label: 'Customize my meals', onClick: () => setCustomizeOpen(true) },
          { label: 'Meal information', onClick: () => setInfoOpen(true) },
        ].map((tool) => (
          <button key={tool.label} onClick={tool.onClick}
                  className="font-grotesk text-[11px] font-semibold underline-offset-4 hover:underline"
                  style={{ color: t.mute, minHeight: 40 }}>
            {tool.label}
          </button>
        ))}
      </div>

      {/* MyDietCard / Food & Meal Tools already render above, right after
          the Insight/Flexible Calorie Balance section -- this was
          manavi-progress-enhancements-v2's OLD position for both (her
          branch predates the "move tools above Today's Eaten Meals"
          pass), left over from a git auto-merge that didn't know the two
          copies were the same feature. Removed as a duplicate, not a
          feature loss: same components, same handlers, same clientId --
          the surviving copy above additionally uses the shared Icon set
          instead of emoji and the silent-reload fix on MyDietCard's
          onLogged. */}

      {/* ══════ NET ENERGY ══════
          Intake minus expenditure -- the CONCLUSION the day adds up to,
          so it reads after the day's list rather than before it. The page
          now runs: how much is left, log something, what you logged, and
          only then which direction the day actually went. Collapsed by default: one figure and one word
          is the whole answer most of the time. `refreshKey` is today's
          eaten total, so logging a meal moves this immediately rather
          than at the next page load. */}
      <NetEnergyCard t={t} refreshKey={Math.round(eaten.calories)} />

      {/* ══════ FLEXIBLE CALORIE BALANCE ══════ */}
      {plan && <CalorieBalance balance={balance} t={t} onToast={setToast} baseTarget={plan} />}

      {/* ══════ SAVED FOODS & MEALS ══════
          A LIBRARY, not a daily action -- so it sits below the things
          you touch every day. It used to sit between the Log food
          button and Today's Eaten Meals, which is the worst place for
          it: directly across the one path people walk on this page. */}
      <MyDietCard clientId={clientId} onLogged={(entry) => (entry ? logEntry(entry) : home.reload({ silent: true }))} t={t} toast={setToast} />


      {/* ══════ HYDRATION ══════ */}
      <HydrationCard waterState={waterState} target={data.water.target} onAdd={addWater} t={t} />

      {/* ══════ SUPPLEMENTS ══════
          Last of the day's cards, after water. It is the one block
          here plenty of people never use at all, so it gets the spot
          that costs nothing to scroll past. */}
      <div className="rounded-3xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        {(() => {
          const sups = supList || [];
          const visible = sups.length > 0 ? (supplementsExpanded ? sups : sups.slice(0, 2)) : [];
          const takenCount = sups.filter((s) => !!supTaken[s.id]).length;
          const supPct = sups.length > 0 ? Math.round((takenCount / sups.length) * 100) : 0;
          return (
            <>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="relative w-14 h-14">
                    <svg width="56" height="56" className="-rotate-90">
                      <circle cx="28" cy="28" r={26} fill="none" stroke={t.ringTrack} strokeWidth="4" />
                      <circle cx="28" cy="28" r={26} fill="none" stroke={supPct === 100 ? t.accent : t.gold} strokeWidth="4" strokeLinecap="round" strokeDasharray={2 * Math.PI * 26} strokeDashoffset={2 * Math.PI * 26 * (1 - supPct / 100)} style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(.22,.8,.3,1)' }} />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center"><span className="font-grotesk text-[13px] font-bold" style={{ color: supPct === 100 ? t.accent : t.gold }}>{supPct}%</span></div>
                  </div>
                  <div>
                    <div className="font-grotesk text-[11px] uppercase tracking-[.16em] font-semibold flex items-center gap-2" style={{ color: t.mute }}>
                      <span className="inline-block w-1 h-1 rounded-full" style={{ background: t.accent }} />Supplements
                    </div>
                    <div className="font-grotesk text-[10px]" style={{ color: t.faint }}>{takenCount} of {sups.length} taken</div>
                  </div>
                </div>
                <button onClick={() => setShowAddSupplement(!showAddSupplement)} className="px-3 py-1.5 rounded-xl font-grotesk text-[10px] font-bold transition-all active:scale-95" style={{ background: showAddSupplement ? t.danger + '15' : t.accentDim, color: showAddSupplement ? t.danger : t.accent, border: `1px solid ${showAddSupplement ? t.danger + '30' : t.accent + '30'}` }}>
                  {showAddSupplement ? 'Close' : '+ Add'}
                </button>
              </div>
              {visible.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  {visible.map((s) => {
                    const taken = !!supTaken[s.id];
                    return (
                      <div key={s.id} role="button" tabIndex={0} onClick={() => setSupTaken((x) => ({ ...x, [s.id]: !taken }))} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSupTaken((x) => ({ ...x, [s.id]: !taken })); } }} className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all cursor-pointer" style={{ background: taken ? `${t.accent}10` : t.glass, border: `1px solid ${taken ? t.accent + '30' : t.border}` }}>
                        <span className="w-5 h-5 rounded-md grid place-items-center text-[10px] shrink-0" style={{ background: taken ? t.accent : 'transparent', color: taken ? 'var(--accent-contrast)' : 'transparent', border: `1px solid ${taken ? t.accent : t.border}` }}><CheckIcon /></span>
                        <span className="flex-1 min-w-0">
                          <span className="block font-grotesk text-sm font-semibold truncate" style={{ color: t.ink }}>{s.name}</span>
                          <div className="h-1 rounded-full mt-1 overflow-hidden" style={{ background: t.ringTrack }}>
                            <div className="h-full rounded-full" style={{ width: taken ? '100%' : '0%', background: t.accent, transition: 'width 0.4s ease' }} />
                          </div>
                        </span>
                        <span className="font-grotesk text-[10px] shrink-0" style={{ color: t.mute }}>{s.dose || ''}</span>
                        <button className="w-6 h-6 rounded-md grid place-items-center text-[9px] shrink-0 transition-colors" onClick={async (e) => { e.stopPropagation(); if (!(await confirm({ title: `Delete "${s.name}"?`, confirmLabel: 'Delete supplement' }))) return; try { await api(`/tracking/clients/${clientId}/supplements/${s.id}`, { method: 'DELETE' }); const r = await api(`/tracking/clients/${clientId}/supplements`); setSupList(r.supplements || []); setToast(`${s.name} removed`); } catch (err) { setToast(err.message || 'Failed to delete supplement'); } }} style={{ color: t.danger + 'AA' }} aria-label={`Delete ${s.name}`}><XIcon /></button>
                      </div>
                    );
                  })}
                </div>
              )}
              {sups.length === 0 && !showAddSupplement && (
                <div className="text-center py-4 mb-3"><div className="font-grotesk text-[11px]" style={{ color: t.mute }}>No supplements added yet</div></div>
              )}
              {sups.length > 2 && (
                <button onClick={() => setSupplementsExpanded(!supplementsExpanded)} className="w-full py-2 text-center font-grotesk text-[11px] font-semibold rounded-xl mb-3 transition-colors" style={{ color: t.accent, background: t.accentDim + '40' }}>
                  {supplementsExpanded ? 'Show less' : `See more (${sups.length - 2} more)`}
                </button>
              )}
              {showAddSupplement && (
                <div className="rounded-xl p-3.5 space-y-2.5" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                  <div className="flex items-center justify-between">
                    <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.mute }}>Add supplement</div>
                    <button onClick={() => { setShowAddSupplement(false); setSupForm({ name: '', dose: '' }); }} className="w-6 h-6 rounded-md grid place-items-center text-[10px]" style={{ color: t.mute }} aria-label="Close add form"><XIcon /></button>
                  </div>
                  <input className="w-full px-3 py-2.5 rounded-xl font-grotesk text-sm outline-none" placeholder="e.g. Omega 3" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={supForm.name} onChange={(e) => setSupForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
                  <input className="w-full px-3 py-2.5 rounded-xl font-grotesk text-xs outline-none" placeholder="Dose (e.g. 1000 mg, 1 scoop, 1000 IU)" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={supForm.dose} onChange={(e) => setSupForm((f) => ({ ...f, dose: e.target.value }))} />
                  <button className="w-full py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" disabled={savingSup || !supForm.name.trim()} onClick={async () => { setSavingSup(true); try { await api(`/tracking/clients/${clientId}/supplements`, { method: 'POST', body: JSON.stringify({ name: supForm.name.trim(), dose: supForm.dose || undefined }) }); setSupForm({ name: '', dose: '' }); setShowAddSupplement(false); api(`/tracking/clients/${clientId}/supplements`).then((r) => setSupList(r.supplements || [])).catch(() => {}); setToast('Supplement added ✓'); } catch (e) { setToast(e.message); } setSavingSup(false); }}
                    style={{ background: (savingSup || !supForm.name.trim()) ? t.surface : t.accent, color: (savingSup || !supForm.name.trim()) ? t.mute : 'var(--accent-contrast)', cursor: (savingSup || !supForm.name.trim()) ? 'not-allowed' : 'pointer' }}>
                    {savingSup ? 'Saving…' : 'Save supplement'}
                  </button>
                </div>
              )}
            </>
          );
        })()}
      </div>

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
      <NutritionTargetSetup open={targetSetupOpen} onComplete={() => { setTargetSetupOpen(false); home.reload({ silent: true }); }} currentPlan={plan} isEdit={!!plan} />

      {/* ══════ MODALS ══════ */}
      {confirmDialog}
      <EditLogModal open={editLogOpen} log={editLog} onClose={() => { setEditLogOpen(false); setEditLog(null); }} onSave={editLogEntry} t={t} />

      {/* ══════ PLATE LOGGER ══════ */}
      {plate.open && (
        <Suspense fallback={null}>
          <PlateSheet
            open={plate.open}
            initialSlot={plate.slot}
            initialText={plate.text}
            seed={plate.seed}
            onClose={() => setPlate((p) => ({ ...p, open: false, text: '', seed: null }))}
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
