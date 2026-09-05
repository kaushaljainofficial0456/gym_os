import { useEffect, useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTheme } from '../../themeContext.jsx';
import { api } from '../../api.js';
import { useCountUp } from '../../utils.js';
import { Spinner, ErrorState, Ring, Bar } from '../../components/UI.jsx';
import NutritionTargetSetup from '../../components/NutritionTargetSetup.jsx';
import FoodLogSheet from '../../components/FoodLogSheet.jsx';
import MyDietCard from '../../components/nutrition/MyDietCard.jsx';
import ShareMealsSheet from '../../components/nutrition/ShareMealsSheet.jsx';
import CustomizeMealSheet from '../../components/nutrition/CustomizeMealSheet.jsx';
import MealInfoSheet from '../../components/nutrition/MealInfoSheet.jsx';
import SavingOverlay from '../../components/nutrition/SavingOverlay.jsx';

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
   ANIMATED RING — premium calorie visualization
   ════════════════════════════════════════════════════════════════ */

function CalorieRing({ value, max, t }) {
  const size = 200;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const frac = max > 0 ? Math.min(value / max, 1.5) : 0;
  const overTarget = value > max && max > 0;
  const animValue = useCountUp(Math.round(value), 1200);
  const animMax = useCountUp(Math.round(max || 0), 1200);
  const uid = useMemo(() => 'cr_' + Math.random().toString(36).slice(2, 8), []);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <div className="absolute inset-0 pointer-events-none" style={{
        background: `radial-gradient(circle at 50% 50%, ${overTarget ? 'rgba(255,107,107,0.08)' : t.accentDim}, transparent 65%)`,
      }} />
      <svg width={size} height={size} className="-rotate-90 relative z-10">
        <defs>
          <linearGradient id={`${uid}_grad`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={overTarget ? '#FF6B6B' : t.accent} />
            <stop offset="50%" stopColor={overTarget ? '#FF9A7A' : t.accent} />
            <stop offset="100%" stopColor={overTarget ? '#FFB88C' : t.accent} />
          </linearGradient>
          <filter id={`${uid}_glow`}>
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={t.ringTrack} strokeWidth={stroke} />
        <circle
          cx={size/2} cy={size/2} r={r} fill="none"
          stroke={`url(#${uid}_grad)`} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(frac, 1))}
          filter={`url(#${uid}_glow)`}
          style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.22,.8,.3,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center z-20">
        <div className="font-black leading-none" style={{ fontSize: 38, color: t.ink, letterSpacing: '-0.02em' }}>{animValue.toLocaleString()}</div>
        <div className="font-grotesk text-[11px] mt-1" style={{ color: t.mute, letterSpacing: '0.06em' }}>kcal</div>
        <div className="mt-1.5 px-3 py-0.5 rounded-full font-grotesk text-[10px] font-semibold" style={{
          background: overTarget ? 'rgba(255,107,107,0.12)' : t.accentDim,
          color: overTarget ? t.danger : t.accent,
        }}>
          {max > 0 ? `${animMax.toLocaleString()} target` : 'No target'}
        </div>
      </div>
    </div>
  );
}

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

/* ════════════════════════════════════════════════════════════════
   HYDRATION — premium water visualization
   ════════════════════════════════════════════════════════════════ */

function HydrationCard({ waterState, target, onAdd, t }) {
  const pct = target > 0 ? Math.min(waterState / target, 1) : 0;
  const glasses = Math.ceil(target / 0.25);
  const animLitres = useCountUp(waterState * 10, 800) / 10;

  return (
    <div data-tour="nutrition-water" className="relative overflow-hidden rounded-2xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
      <div className="absolute inset-0 pointer-events-none" style={{ background: `linear-gradient(180deg, transparent 60%, ${t.waterDim})`, opacity: pct * 0.6 }} />
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center text-sm" style={{ background: t.waterDim, color: t.water }}>💧</div>
            <div>
              <div className="font-grotesk text-[11px] uppercase tracking-[.16em] font-semibold flex items-center gap-2" style={{ color: t.mute }}>
                <span className="inline-block w-1 h-1 rounded-full" style={{ background: t.accent }} />Water
              </div>
              <div className="font-grotesk text-[10px]" style={{ color: t.mute }}>{Math.round(pct * 100)}% of daily goal</div>
            </div>
          </div>
          <div className="font-grotesk text-xl font-black" style={{ color: t.water }}>
            {animLitres.toFixed(1)}<span className="text-xs font-medium" style={{ color: t.mute }}> / {target}L</span>
          </div>
        </div>
        <div className="h-3 rounded-full overflow-hidden mb-3" style={{ background: t.ringTrack }}>
          <div className="h-full rounded-full relative" style={{ width: `${pct * 100}%`, background: `linear-gradient(90deg, ${t.water}88, ${t.water})`, transition: 'width 0.6s cubic-bezier(.22,.8,.3,1)' }}>
            <div className="absolute inset-0 rounded-full" style={{ background: `linear-gradient(180deg, rgba(255,255,255,0.25) 0%, transparent 60%)` }} />
          </div>
        </div>
        <div className="grid gap-1.5 mb-3" style={{ gridTemplateColumns: `repeat(${Math.min(glasses, 12)}, 1fr)` }}>
          {Array.from({ length: Math.min(glasses, 12) }).map((_, i) => {
            const filled = waterState >= (i + 1) * 0.25;
            return (
              <button key={i} onClick={() => onAdd(filled ? -0.25 : 0.25)}
                className="aspect-square rounded-lg grid place-items-center text-[10px] transition-all duration-300 active:scale-90"
                style={{ background: filled ? `${t.water}25` : t.glass, border: `1px solid ${filled ? t.water + '50' : t.border}`, color: filled ? t.water : t.faint, boxShadow: filled ? `0 0 8px ${t.water}20` : 'none' }}
                aria-label={`Water glass ${i + 1}`}>
                {filled ? '💧' : ''}
              </button>
            );
          })}
        </div>
        <div className="text-center text-[10px]" style={{ color: t.faint }}>Tap a glass to fill · tap filled to remove</div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   TODAY'S EATEN MEALS — the actual log, separate from My Diet's
   reusable Saved Foods/Meals library. Edit mode reveals [-] remove +
   [Edit Quantity] per row; removals/edits persist immediately (per-
   action, same as before) -- "Save Changes" is the confirming exit
   flourish the spec asks for, not a second write.
   ════════════════════════════════════════════════════════════════ */

function TodaysEatenList({ meals, editing, onToggle, onEditQty, onDelete, t }) {
  if (!meals || meals.length === 0) {
    return (
      <div className="text-center py-10 px-6">
        <div className="w-14 h-14 mx-auto rounded-2xl grid place-items-center text-2xl mb-3" style={{ background: t.surface, border: `1px solid ${t.border}` }}>🍽️</div>
        <div className="font-grotesk text-sm font-semibold" style={{ color: t.ink }}>No foods logged today</div>
        <div className="text-xs mt-1 max-w-xs mx-auto" style={{ color: t.mute }}>Your nutrition day is waiting to be filled.</div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {meals.map((m) => {
        const isCustomLog = !m.meal_id && m.id && !m.id.startsWith('plan_');
        return (
          <div key={m.id} className="flex gap-3 items-start group transition-all">
            {editing ? (
              <button
                onClick={() => onDelete(m)}
                aria-label={`Remove ${m.name}`}
                className="mt-3 w-6 h-6 rounded-md grid place-items-center shrink-0 text-sm font-bold transition-transform active:scale-90"
                style={{ background: `${t.danger}12`, color: t.danger, border: `1px solid ${t.danger}30` }}
              >−</button>
            ) : (
              <button
                type="button" role="checkbox" aria-checked={!!m.eaten}
                aria-label={m.eaten ? `Mark ${m.name} as not eaten` : `Mark ${m.name} as eaten`}
                onClick={(e) => { e.stopPropagation(); onToggle(m); }}
                className="mt-3 w-5 h-5 rounded-md border-2 shrink-0 grid place-items-center transition-all duration-200 cursor-pointer"
                style={{ borderColor: m.eaten ? t.accent : t.border, background: m.eaten ? t.accent : 'transparent' }}
              >
                {m.eaten && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-contrast)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
              </button>
            )}

            <div className="flex-1 rounded-xl p-3.5 transition-all duration-200" style={{
              background: m.eaten ? t.accentDim : t.surface,
              border: `1px solid ${m.eaten ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : t.border}`,
            }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-grotesk text-sm font-bold" style={{ color: t.ink }}>{m.name}</span>
                    {m.time && <span className="font-grotesk text-[10px] px-1.5 py-px rounded-md" style={{ background: t.glass, color: t.mute }}>{m.time}</span>}
                  </div>
                  <div className="font-grotesk text-[10px]" style={{ color: t.mute }}>{m.slot}{m.quantity ? ` · ${m.quantity}${m.unit || 'g'}` : ''}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="font-grotesk text-sm font-bold shrink-0" style={{ color: m.eaten ? t.accent : t.mute }}>
                    {m.calories}<span className="text-[10px] font-normal" style={{ color: t.faint }}> kcal</span>
                  </div>
                  {editing && isCustomLog && (
                    <button onClick={() => onEditQty(m)} className="px-2 py-1 rounded-lg font-grotesk text-[9px] font-bold shrink-0" style={{ background: t.glass, color: t.mute, border: `1px solid ${t.border}` }}>
                      Edit Quantity
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 mt-1.5">
                <span className="font-grotesk text-[10px] font-semibold" style={{ color: t.protein }}>P {m.protein}g</span>
                <span className="font-grotesk text-[10px] font-semibold" style={{ color: t.carbs }}>C {m.carbs}g</span>
                <span className="font-grotesk text-[10px] font-semibold" style={{ color: t.fat }}>F {m.fat}g</span>
                {m.eaten && !editing && <span className="ml-auto font-grotesk text-[9px] font-semibold px-2 py-0.5 rounded-full" style={{ background: t.accentDim, color: t.accent }}>Logged</span>}
              </div>
              {m.foods && <div className="text-[10px] mt-1 truncate" style={{ color: t.faint }}>{m.foods}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   NUTRITION INSIGHT
   ════════════════════════════════════════════════════════════════ */

function NutritionInsight({ plan, eaten, t }) {
  const insight = useMemo(() => {
    if (!plan) return null;
    const remaining = plan.calories - eaten.calories;
    const proteinPct = plan.protein > 0 ? Math.round((eaten.protein / plan.protein) * 100) : 0;
    const carbPct = plan.carbs > 0 ? Math.round((eaten.carbs / plan.carbs) * 100) : 0;
    const fatPct = plan.fat > 0 ? Math.round((eaten.fat / plan.fat) * 100) : 0;
    if (remaining <= 0) return { text: `You've reached your calorie target.`, tone: 'gold' };
    if (proteinPct < carbPct && proteinPct < fatPct && proteinPct < 100) return { text: `Protein is your lowest macro — ${plan.protein - eaten.protein}g remaining.`, tone: 'protein' };
    if (remaining > 0) return { text: `${remaining} kcal away from today's target.`, tone: 'accent' };
    return null;
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
    <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}>
      <div className="w-full max-w-sm rounded-3xl overflow-hidden anim-scaleIn" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>
        <div className="px-5 pt-5 pb-3 flex items-start justify-between">
          <div>
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.accent }}>Edit Entry</div>
            <div className="font-grotesk text-base font-bold mt-1" style={{ color: t.ink }}>{log.name}</div>
          </div>
          <button className="w-8 h-8 rounded-full grid place-items-center text-sm transition-colors shrink-0" onClick={onClose} aria-label="Close" style={{ background: t.glass, color: t.mute, border: `1px solid ${t.border}` }}>✕</button>
        </div>
        <div className="px-5 pb-4">
          <label className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-1.5 block" style={{ color: t.mute }}>Quantity ({log.unit || 'g'})</label>
          <input type="number" className="w-full px-4 py-3 rounded-xl font-grotesk text-sm font-bold outline-none" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }} value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus />
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
   DELETE LOG CONFIRMATION
   ════════════════════════════════════════════════════════════════ */

function DeleteLogConfirm({ open, log, onClose, onConfirm, t }) {
  if (!open || !log) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}>
      <div className="w-full max-w-sm rounded-3xl overflow-hidden anim-scaleIn" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>
        <div className="px-5 pt-5 pb-4 text-center relative">
          <button className="absolute right-4 top-4 w-8 h-8 rounded-full grid place-items-center text-sm transition-colors" onClick={onClose} aria-label="Close" style={{ background: t.glass, color: t.mute, border: `1px solid ${t.border}` }}>✕</button>
          <div className="w-12 h-12 mx-auto rounded-full grid place-items-center text-xl mb-3" style={{ background: `${t.danger}10`, border: `1px solid ${t.danger}30` }}>🗑️</div>
          <div className="font-grotesk text-sm font-bold mb-1" style={{ color: t.ink }}>Remove from today's intake?</div>
          <div className="text-[11px]" style={{ color: t.mute }}>{log.name} · {log.quantity || 100}{log.unit || 'g'} · {log.calories} kcal</div>
        </div>
        <div className="px-5 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-semibold transition-all active:scale-95" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.mute }}>Cancel</button>
          <button onClick={() => onConfirm(log.id)} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={{ background: t.danger, color: 'var(--accent-contrast)' }}>Remove</button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   MAIN NUTRITION PAGE
   ════════════════════════════════════════════════════════════════ */

export default function Nutrition() {
  const { theme } = useTheme();
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
  const [deleteLogOpen, setDeleteLogOpen] = useState(false);
  const [deleteLog, setDeleteLog] = useState(null);
  const [supplementsExpanded, setSupplementsExpanded] = useState(false);
  const [mealsExpanded, setMealsExpanded] = useState(false);
  const [showAddSupplement, setShowAddSupplement] = useState(false);
  const [foodLogSheetOpen, setFoodLogSheetOpen] = useState(false);
  const [foodLogAutoScan, setFoodLogAutoScan] = useState(false);

  // Today's Eaten Meals edit mode -- [-]/[Edit Quantity] per row, "Save
  // Changes" is a confirming exit flourish (each action already persisted
  // immediately, same as before this redesign).
  const [todaysEditing, setTodaysEditing] = useState(false);
  const [savingTodaysEdit, setSavingTodaysEdit] = useState(false);
  const [todaysSaveStage, setTodaysSaveStage] = useState(null);

  // Food & Meal Tools sheets
  const [shareOpen, setShareOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  const data = home.data;
  const clientId = data?.client?.id;

  useEffect(() => { if (clientId) api(`/tracking/clients/${clientId}/supplements`).then((r) => setSupList(r.supplements || [])).catch(() => {}); }, [clientId]);

  const plan = data?.nutrition?.plan;

  useEffect(() => { if (data && !plan && !targetSetupOpen) setTargetSetupOpen(true); }, [data, plan]);
  const mealState = meals || data?.nutrition?.meals || [];
  const waterState = water ?? (data ? data.water.litres : 0);

  const eaten = mealState.filter((m) => m.eaten).reduce((s, m) => ({
    calories: s.calories + m.calories, protein: s.protein + m.protein,
    carbs: s.carbs + m.carbs, fat: s.fat + m.fat
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  useEffect(() => { if (!toast) return; const h = setTimeout(() => setToast(''), 2400); return () => clearTimeout(h); }, [toast]);

  if (home.loading) return <Spinner label="Loading your fuel plan…" />;
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
      home.reload();
    }
  };

  const editLogEntry = async (logId, updates) => {
    try {
      await api(`/me/meal-logs/${logId}`, { method: 'PUT', body: JSON.stringify(updates) });
      setToast('Entry updated ✓');
      setEditLogOpen(false); setEditLog(null);
      home.reload();
    } catch (e) { setToast(e.message); }
  };

  const deleteLogEntry = async (logId) => {
    try {
      await api(`/me/meal-logs/${logId}`, { method: 'DELETE' });
      setToast('Entry removed ✓');
      setDeleteLogOpen(false); setDeleteLog(null);
      home.reload();
    } catch (e) { setToast(e.message); }
  };

  const finishTodaysEdit = async () => {
    setSavingTodaysEdit(true); setTodaysSaveStage('saving');
    await new Promise((res) => setTimeout(res, 300));
    setTodaysSaveStage('success');
    setTimeout(() => { setSavingTodaysEdit(false); setTodaysSaveStage(null); setTodaysEditing(false); }, 700);
  };

  const addWater = async (litres = 0.25) => {
    const next = Math.min(data.water.target, Math.round((waterState + litres) * 100) / 100);
    setWater(next);
    // Same reasoning as toggleMeal above -- a silent revert with no toast
    // reads as "the app randomly undid my tap", not "that failed".
    try {
      await api(`/tracking/clients/${clientId}/water`, { method: 'POST', body: JSON.stringify({ litres: next }) });
    } catch (e) {
      setToast(e.message || "Couldn't log water — reverted");
      home.reload();
    }
  };

  const logEntry = async (entry) => {
    await api(`/nutrition/clients/${clientId}/meals/log`, {
      method: 'POST',
      body: JSON.stringify({
        name: entry.name, slot: 'Snack',
        calories: entry.calories, protein: entry.protein, carbs: entry.carbs, fat: entry.fat,
        source: entry.source || 'manual', eaten: true,
        ai_provider: entry.ai_provider || undefined,
        ai_model: entry.ai_model || undefined,
        ai_confidence: entry.ai_confidence || undefined,
      }),
    });
    home.reload();
  };

  const eatenTodayList = mealState.filter((m) => m.eaten);

  return (
    <div className="space-y-5 pb-24">

      {/* ══════ HEADER ══════ */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-grotesk font-black text-2xl leading-tight" style={{ color: t.ink }}>Today's Fuel</h1>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[13px] font-medium" style={{ color: t.mute }}>
              {plan ? `${plan.calories} kcal target · P${plan.protein}g · C${plan.carbs}g · F${plan.fat}g` : 'No plan assigned'}
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
            <div className="shrink-0"><CalorieRing value={eaten.calories} max={plan?.calories || 0} t={t} /></div>
            <div className="flex-1 w-full space-y-4">
              <MacroBar label="Protein" value={eaten.protein} max={plan?.protein || 0} color={t.protein} t={t} />
              <MacroBar label="Carbs" value={eaten.carbs} max={plan?.carbs || 0} color={t.carbs} t={t} />
              <MacroBar label="Fat" value={eaten.fat} max={plan?.fat || 0} color={t.fat} t={t} />
            </div>
          </div>
        </div>
      </div>

      {/* ══════ INSIGHT ══════ */}
      <NutritionInsight plan={plan} eaten={eaten} t={t} />

      {/* ══════ TODAY'S EATEN MEALS ══════ */}
      <div data-tour="nutrition-meals" className="relative rounded-3xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <SectionHeader
          title="Today's Eaten Meals" kicker
          subtitle={`${eatenTodayList.length} of ${mealState.length} logged`}
          t={t}
          action={
            <button
              onClick={() => (todaysEditing ? finishTodaysEdit() : setTodaysEditing(true))}
              disabled={savingTodaysEdit}
              className="px-3 py-1.5 rounded-xl font-grotesk text-[10px] font-bold transition-all active:scale-95"
              style={{ background: todaysEditing ? t.accent : t.glass, color: todaysEditing ? 'var(--accent-contrast)' : t.mute, border: `1px solid ${todaysEditing ? t.accent : t.border}` }}
            >
              {todaysEditing ? 'Save Changes' : 'Edit'}
            </button>
          }
        />
        <TodaysEatenList
          meals={mealsExpanded ? mealState : mealState.slice(0, 2)}
          editing={todaysEditing}
          onToggle={toggleMeal}
          onEditQty={(m) => { setEditLog(m); setEditLogOpen(true); }}
          onDelete={(m) => { setDeleteLog(m); setDeleteLogOpen(true); }}
          t={t}
        />
        {mealState.length > 2 && (
          <button onClick={() => setMealsExpanded(!mealsExpanded)} className="w-full mt-3 py-2 text-center font-grotesk text-[11px] font-semibold rounded-xl transition-colors" style={{ color: t.accent, background: t.accentDim }}>
            {mealsExpanded ? 'Show less' : `See more (${mealState.length - 2} more)`}
          </button>
        )}
        {mealState.length === 0 && (
          <button onClick={() => setFoodLogSheetOpen(true)} className="w-full mt-2 py-2.5 rounded-xl font-grotesk text-[12px] font-bold" style={{ background: t.accentDim, color: t.accent }}>
            Log / Estimate Food
          </button>
        )}
        <SavingOverlay open={savingTodaysEdit} stage={todaysSaveStage} label={todaysSaveStage === 'success' ? 'Changes Saved' : 'Saving changes'} mode="overlay" size="sm" />
      </div>

      {/* ══════ MY DIET (Saved Foods + Saved Meals) ══════ */}
      <MyDietCard clientId={clientId} onLogged={(entry) => (entry ? logEntry(entry) : home.reload())} t={t} toast={setToast} />

      {/* ══════ FOOD & MEAL TOOLS ══════ */}
      <div data-tour="nutrition-tools" className="rounded-3xl p-2" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <div className="px-3 pt-2 pb-1 font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.mute }}>Food & Meal Tools</div>
        <div className="grid grid-cols-3 gap-1.5 p-1">
          {[
            { label: 'Log / Estimate Food', icon: '🍽️', onClick: () => setFoodLogSheetOpen(true) },
            { label: 'Customize My Meals', icon: '🧩', onClick: () => setCustomizeOpen(true) },
            { label: 'Meal Information', icon: '📊', onClick: () => setInfoOpen(true) },
          ].map((tool) => (
            <button key={tool.label} onClick={tool.onClick}
                    className="flex flex-col items-center gap-1.5 rounded-2xl px-2 py-3.5 transition-all active:scale-95"
                    style={{ background: t.glass, border: `1px solid ${t.border}` }}>
              <span className="text-lg">{tool.icon}</span>
              <span className="font-grotesk text-[10px] font-semibold text-center leading-tight" style={{ color: t.ink }}>{tool.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ══════ SUPPLEMENTS ══════ */}
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
                  {showAddSupplement ? '✕ Close' : '+ Add'}
                </button>
              </div>
              {visible.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  {visible.map((s) => {
                    const taken = !!supTaken[s.id];
                    return (
                      <div key={s.id} role="button" tabIndex={0} onClick={() => setSupTaken((x) => ({ ...x, [s.id]: !taken }))} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSupTaken((x) => ({ ...x, [s.id]: !taken })); } }} className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all cursor-pointer" style={{ background: taken ? `${t.accent}10` : t.glass, border: `1px solid ${taken ? t.accent + '30' : t.border}` }}>
                        <span className="w-5 h-5 rounded-md grid place-items-center text-[10px] shrink-0" style={{ background: taken ? t.accent : 'transparent', color: taken ? 'var(--accent-contrast)' : 'transparent', border: `1px solid ${taken ? t.accent : t.border}` }}>✓</span>
                        <span className="flex-1 min-w-0">
                          <span className="block font-grotesk text-sm font-semibold truncate" style={{ color: t.ink }}>{s.name}</span>
                          <div className="h-1 rounded-full mt-1 overflow-hidden" style={{ background: t.ringTrack }}>
                            <div className="h-full rounded-full" style={{ width: taken ? '100%' : '0%', background: t.accent, transition: 'width 0.4s ease' }} />
                          </div>
                        </span>
                        <span className="font-grotesk text-[10px] shrink-0" style={{ color: t.mute }}>{s.dose || ''}</span>
                        <button className="w-6 h-6 rounded-md grid place-items-center text-[9px] shrink-0 transition-colors" onClick={async (e) => { e.stopPropagation(); if (!window.confirm(`Delete "${s.name}"?`)) return; try { await api(`/tracking/clients/${clientId}/supplements/${s.id}`, { method: 'DELETE' }); const r = await api(`/tracking/clients/${clientId}/supplements`); setSupList(r.supplements || []); setToast(`${s.name} removed`); } catch (err) { setToast(err.message || 'Failed to delete supplement'); } }} style={{ color: t.danger + 'AA' }} aria-label={`Delete ${s.name}`}>✕</button>
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
                    <button onClick={() => { setShowAddSupplement(false); setSupForm({ name: '', dose: '' }); }} className="w-6 h-6 rounded-md grid place-items-center text-[10px]" style={{ color: t.mute }} aria-label="Close add form">✕</button>
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

      {/* ══════ HYDRATION ══════ */}
      <HydrationCard waterState={waterState} target={data.water.target} onAdd={addWater} t={t} />

      {/* ══════ TOAST ══════ */}
      {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full font-grotesk text-xs shadow-lg anim-toast" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink, boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>{toast}</div>}

      {/* ══════ NUTRITION TARGET SETUP ══════ */}
      <NutritionTargetSetup open={targetSetupOpen} onComplete={() => { setTargetSetupOpen(false); home.reload(); }} currentPlan={plan} isEdit={!!plan} />

      {/* ══════ MODALS ══════ */}
      <EditLogModal open={editLogOpen} log={editLog} onClose={() => { setEditLogOpen(false); setEditLog(null); }} onSave={editLogEntry} t={t} />
      <DeleteLogConfirm open={deleteLogOpen} log={deleteLog} onClose={() => { setDeleteLogOpen(false); setDeleteLog(null); }} onConfirm={deleteLogEntry} t={t} />

      {/* ══════ FOOD LOG SHEET (search, barcode, mic, AI estimate) ══════ */}
      <FoodLogSheet
        open={foodLogSheetOpen}
        autoScan={foodLogAutoScan}
        onClose={() => { setFoodLogSheetOpen(false); setFoodLogAutoScan(false); }}
        onAdd={async (entry) => {
          await logEntry(entry);
          setFoodLogSheetOpen(false);
          setFoodLogAutoScan(false);
          setToast('Food logged ✓');
        }}
      />

      {/* ══════ SHARE MEALS ══════ */}
      <ShareMealsSheet open={shareOpen} onClose={() => setShareOpen(false)} t={t} />

      {/* ══════ CUSTOMIZE MY MEALS ══════ */}
      <CustomizeMealSheet open={customizeOpen} onClose={() => setCustomizeOpen(false)} onLogged={home.reload} t={t} toast={setToast} />

      {/* ══════ INFORMATION ABOUT MY MEALS ══════ */}
      <MealInfoSheet open={infoOpen} onClose={() => setInfoOpen(false)} meals={eatenTodayList} plan={plan} goal={data?.client?.goal} t={t} />
    </div>
  );
}
