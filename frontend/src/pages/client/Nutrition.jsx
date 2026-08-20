import { useEffect, useState, useMemo } from 'react';
import { useTheme } from '../../themeContext.jsx';
import { api } from '../../api.js';
import { useFetch, useCountUp } from '../../utils.js';
import { Spinner, ErrorState, Ring, Bar } from '../../components/UI.jsx';
import NutritionTargetSetup from '../../components/NutritionTargetSetup.jsx';

const r1 = (n) => Math.round(n * 10) / 10;

/* ════════════════════════════════════════════════════════════════
   THEME TOKENS
   ════════════════════════════════════════════════════════════════ */

const T = {
  dark: {
    bg: '#080B12',
    surface: 'rgba(255,255,255,0.03)',
    surfaceHover: 'rgba(255,255,255,0.06)',
    border: 'rgba(255,255,255,0.07)',
    borderHover: 'rgba(255,255,255,0.14)',
    ink: '#EDEFF7',
    mute: 'rgba(255,255,255,0.42)',
    faint: 'rgba(255,255,255,0.22)',
    accent: '#12B8B0',
    accentDim: 'rgba(18,184,176,0.15)',
    gold: '#FFC43D',
    goldDim: 'rgba(255,196,61,0.12)',
    protein: '#FF9A7A',
    carbs: '#FFC43D',
    fat: '#82C8F0',
    water: '#35D7FF',
    waterDim: 'rgba(53,215,255,0.12)',
    danger: '#FF6B6B',
    glass: 'rgba(255,255,255,0.04)',
    glassBorder: 'rgba(255,255,255,0.08)',
    ringTrack: 'rgba(255,255,255,0.06)',
    heroGlow: 'radial-gradient(ellipse at 50% 30%, rgba(18,184,176,0.08), transparent 70%)',
    cardShadow: '0 2px 20px rgba(0,0,0,0.3)',
    timeline: 'rgba(255,255,255,0.06)',
    timelineActive: 'rgba(18,184,176,0.3)',
  },
  light: {
    bg: '#F5F0EB',
    surface: 'rgba(61,48,38,0.03)',
    surfaceHover: 'rgba(61,48,38,0.06)',
    border: 'rgba(61,48,38,0.08)',
    borderHover: 'rgba(61,48,38,0.16)',
    ink: '#3D3026',
    mute: 'rgba(61,48,38,0.45)',
    faint: 'rgba(61,48,38,0.25)',
    accent: '#8C6A4D',
    accentDim: 'rgba(140,106,77,0.12)',
    gold: '#B47828',
    goldDim: 'rgba(180,120,40,0.10)',
    protein: '#D4623A',
    carbs: '#B47828',
    fat: '#3A8AB0',
    water: '#2AAFCF',
    waterDim: 'rgba(42,175,207,0.10)',
    danger: '#D44',
    glass: 'rgba(255,255,255,0.6)',
    glassBorder: 'rgba(61,48,38,0.08)',
    ringTrack: 'rgba(61,48,38,0.08)',
    heroGlow: 'radial-gradient(ellipse at 50% 30%, rgba(140,106,77,0.06), transparent 70%)',
    cardShadow: '0 2px 20px rgba(0,0,0,0.06)',
    timeline: 'rgba(61,48,38,0.06)',
    timelineActive: 'rgba(140,106,77,0.25)',
  },
};

/* ════════════════════════════════════════════════════════════════
   ANIMATED RING — premium calorie visualization
   ════════════════════════════════════════════════════════════════ */

function CalorieRing({ value, max, t }) {
  const size = 200;
  const stroke = 14;
  const gap = 6;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const frac = max > 0 ? Math.min(value / max, 1.5) : 0;
  const overTarget = value > max && max > 0;
  const animValue = useCountUp(Math.round(value), 1200);
  const animMax = useCountUp(Math.round(max || 0), 1200);
  const uid = useMemo(() => 'cr_' + Math.random().toString(36).slice(2, 8), []);

  const strokeColor = overTarget ? t.danger : t.accent;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      {/* Subtle glow behind ring */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: `radial-gradient(circle at 50% 50%, ${overTarget ? 'rgba(255,107,107,0.08)' : t.accentDim}, transparent 65%)`,
      }} />
      <svg width={size} height={size} className="-rotate-90 relative z-10">
        <defs>
          <linearGradient id={`${uid}_grad`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={overTarget ? '#FF6B6B' : t.accent} />
            <stop offset="100%" stopColor={overTarget ? '#FF9A7A' : t.gold} />
          </linearGradient>
          <filter id={`${uid}_glow`}>
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* Track */}
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={t.ringTrack} strokeWidth={stroke} />
        {/* Fill */}
        <circle
          cx={size/2} cy={size/2} r={r} fill="none"
          stroke={`url(#${uid}_grad)`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - Math.min(frac, 1))}
          filter={`url(#${uid}_glow)`}
          style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.22,.8,.3,1)' }}
        />
      </svg>
      {/* Center label */}
      <div className="absolute inset-0 flex flex-col items-center justify-center z-20">
        <div className="font-grotesk font-bold leading-none" style={{ fontSize: 38, color: t.ink, letterSpacing: '-0.02em' }}>
          {animValue.toLocaleString()}
        </div>
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
   MACRO BAR — refined progress display
   ════════════════════════════════════════════════════════════════ */

function MacroBar({ label, value, max, color, t, icon }) {
  const frac = max > 0 ? Math.min(value / max, 1.5) : 0;
  const animVal = useCountUp(Math.round(value), 1000);
  const over = value > max && max > 0;

  return (
    <div className="flex items-center gap-3">
      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 8px ${color}40` }} />
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
            background: `linear-gradient(90deg, ${color}CC, ${color})`,
            transition: 'width 1s cubic-bezier(.22,.8,.3,1)',
            boxShadow: `0 0 10px ${color}30`,
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
    <div className="relative overflow-hidden rounded-2xl p-5" style={{
      background: t.surface,
      border: `1px solid ${t.border}`,
      boxShadow: t.cardShadow,
    }}>
      {/* Subtle water gradient bg */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: `linear-gradient(180deg, transparent 60%, ${t.waterDim})`,
        opacity: pct * 0.6,
      }} />

      <div className="relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center text-sm" style={{ background: t.waterDim, color: t.water }}>💧</div>
            <div>
              <div className="font-grotesk text-xs font-semibold" style={{ color: t.ink }}>Hydration</div>
              <div className="font-grotesk text-[10px]" style={{ color: t.mute }}>{Math.round(pct * 100)}% of daily goal</div>
            </div>
          </div>
          <div className="font-grotesk text-lg font-bold" style={{ color: t.water }}>
            {animLitres.toFixed(1)}<span className="text-xs font-normal" style={{ color: t.mute }}> / {target}L</span>
          </div>
        </div>

        {/* Water level bar */}
        <div className="h-3 rounded-full overflow-hidden mb-3" style={{ background: t.ringTrack }}>
          <div className="h-full rounded-full relative" style={{
            width: `${pct * 100}%`,
            background: `linear-gradient(90deg, ${t.water}88, ${t.water})`,
            transition: 'width 0.6s cubic-bezier(.22,.8,.3,1)',
          }}>
            <div className="absolute inset-0 rounded-full" style={{
              background: `linear-gradient(180deg, rgba(255,255,255,0.25) 0%, transparent 60%)`,
            }} />
          </div>
        </div>

        {/* Glass buttons */}
        <div className="grid gap-1.5 mb-3" style={{ gridTemplateColumns: `repeat(${Math.min(glasses, 12)}, 1fr)` }}>
          {Array.from({ length: Math.min(glasses, 12) }).map((_, i) => {
            const filled = waterState >= (i + 1) * 0.25;
            return (
              <button key={i} onClick={() => onAdd(filled ? -0.25 : 0.25)}
                className="aspect-square rounded-lg grid place-items-center text-[10px] transition-all duration-300 active:scale-90"
                style={{
                  background: filled ? `${t.water}25` : t.glass,
                  border: `1px solid ${filled ? t.water + '50' : t.border}`,
                  color: filled ? t.water : t.faint,
                  boxShadow: filled ? `0 0 8px ${t.water}20` : 'none',
                }}
                aria-label={`Water glass ${i + 1}`}
              >
                {filled ? '💧' : ''}
              </button>
            );
          })}
        </div>

        <div className="text-center text-[10px]" style={{ color: t.faint }}>
          Tap a glass to fill · tap filled to remove
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   MEAL TIMELINE — premium meal display
   ════════════════════════════════════════════════════════════════ */

function MealTimeline({ meals, onToggle, onEditLog, onDeleteLog, t }) {
  if (!meals || meals.length === 0) {
    return (
      <div className="text-center py-10 px-6">
        <div className="w-14 h-14 mx-auto rounded-2xl grid place-items-center text-2xl mb-3" style={{
          background: t.surface, border: `1px solid ${t.border}`,
        }}>🍽️</div>
        <div className="font-grotesk text-sm font-semibold" style={{ color: t.ink }}>No meals logged</div>
        <div className="text-xs mt-1 max-w-xs mx-auto" style={{ color: t.mute }}>Your nutrition day is waiting to be filled.</div>
      </div>
    );
  }

  return (
    <div className="relative pl-5">
      {/* Timeline line */}
      <div className="absolute left-[7px] top-3 bottom-3 w-px" style={{ background: t.timeline }} />

      <div className="space-y-3">
        {meals.map((m) => {
          // Custom logged entries (AI, manual, custom) have no meal_id and have an id from meal_logs
          const isCustomLog = !m.meal_id && m.id && !m.id.startsWith('plan_');
          return (
            <div key={m.id} className="relative flex gap-3 items-start group transition-all">
              {/* Timeline dot */}
              <div className="absolute -left-5 top-3 w-[15px] h-[15px] rounded-full border-2 z-10 transition-all duration-300" style={{
                borderColor: m.eaten ? t.accent : t.border,
                background: m.eaten ? t.accent : 'transparent',
                boxShadow: m.eaten ? `0 0 10px ${t.accent}40` : 'none',
              }}>
                {m.eaten && <div className="absolute inset-0.5 rounded-full flex items-center justify-center text-[7px] text-white font-bold">✓</div>}
              </div>

              {/* Meal card */}
              <div className="flex-1 rounded-xl p-3.5 transition-all duration-200" style={{
                background: m.eaten ? `${t.accentDim}` : t.surface,
                border: `1px solid ${m.eaten ? t.accent + '30' : t.border}`,
                boxShadow: m.eaten ? `0 0 20px ${t.accent}08` : 'none',
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
                    {/* Edit/Remove menu for custom logged entries */}
                    {isCustomLog && (
                      <div className="relative shrink-0">
                        <button className="w-6 h-6 rounded-lg grid place-items-center text-[10px] transition-colors" style={{ background: t.glass, color: t.mute, border: `1px solid ${t.border}` }} onClick={(e) => { e.stopPropagation(); const menu = e.currentTarget.nextElementSibling; menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex'; }} aria-label="Actions">⋮</button>
                        <div className="hidden absolute right-0 top-full mt-1 z-20 flex-col min-w-[120px] rounded-xl overflow-hidden" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>
                          <button className="px-3 py-2 text-left font-grotesk text-[11px] font-semibold transition-colors" style={{ color: t.ink }} onClick={(e) => { e.stopPropagation(); e.currentTarget.parentElement.style.display = 'none'; onEditLog(m); }} onMouseEnter={(e) => e.currentTarget.style.background = t.surfaceHover} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>Edit</button>
                          <button className="px-3 py-2 text-left font-grotesk text-[11px] font-semibold transition-colors" style={{ color: t.danger }} onClick={(e) => { e.stopPropagation(); e.currentTarget.parentElement.style.display = 'none'; onDeleteLog(m); }} onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,107,107,0.06)'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>Remove</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="font-grotesk text-[10px] font-semibold" style={{ color: t.protein }}>P {m.protein}g</span>
                  <span className="font-grotesk text-[10px] font-semibold" style={{ color: t.carbs }}>C {m.carbs}g</span>
                  <span className="font-grotesk text-[10px] font-semibold" style={{ color: t.fat }}>F {m.fat}g</span>
                  {m.eaten && <span className="ml-auto font-grotesk text-[9px] font-semibold px-2 py-0.5 rounded-full" style={{ background: t.accentDim, color: t.accent }}>Logged</span>}
                </div>
                {m.foods && <div className="text-[10px] mt-1 truncate" style={{ color: t.faint }}>{m.foods}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   NUTRITION INSIGHT — data-driven micro insights
   ════════════════════════════════════════════════════════════════ */

function NutritionInsight({ plan, eaten, t }) {
  const insight = useMemo(() => {
    if (!plan) return null;
    const remaining = plan.calories - eaten.calories;
    const proteinPct = plan.protein > 0 ? Math.round((eaten.protein / plan.protein) * 100) : 0;
    const carbPct = plan.carbs > 0 ? Math.round((eaten.carbs / plan.carbs) * 100) : 0;
    const fatPct = plan.fat > 0 ? Math.round((eaten.fat / plan.fat) * 100) : 0;

    if (remaining <= 0) return { text: `You've reached your calorie target.`, tone: 'gold' };
    if (proteinPct < carbPct && proteinPct < fatPct && proteinPct < 100) {
      return { text: `Protein is your lowest macro — ${plan.protein - eaten.protein}g remaining.`, tone: 'protein' };
    }
    if (remaining > 0) return { text: `${remaining} kcal away from today's target.`, tone: 'accent' };
    return null;
  }, [plan, eaten]);

  if (!insight) return null;

  const colors = { accent: t.accent, gold: t.gold, protein: t.protein };
  const color = colors[insight.tone] || t.accent;

  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl" style={{
      background: `${color}08`,
      border: `1px solid ${color}18`,
    }}>
      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}60` }} />
      <span className="font-grotesk text-[11px] font-medium" style={{ color }}>{insight.text}</span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   SECTION HEADER — reusable premium section title
   ════════════════════════════════════════════════════════════════ */

function SectionHeader({ title, subtitle, action, t }) {
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
   CustomMealModal — preserved from existing implementation
   ════════════════════════════════════════════════════════════════ */

function CustomMealModal({ open, onClose, clientId, onSaved, toast, editMeal = null }) {
  const { theme } = useTheme();
  const t = T[theme] || T.dark;
  const [mealName, setMealName] = useState('');
  const [ingredients, setIngredients] = useState([]);
  const [servings, setServings] = useState(1);
  const [foodQuery, setFoodQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);

  const isEdit = !!editMeal;

  useEffect(() => {
    if (!foodQuery.trim() || foodQuery.length < 2) { setSearchResults([]); return; }
    let cancelled = false;
    const t2 = setTimeout(async () => {
      setSearching(true);
      try { const res = await api(`/me/foods/search?q=${encodeURIComponent(foodQuery)}`); if (!cancelled) setSearchResults(res.foods || []); }
      catch { if (!cancelled) setSearchResults([]); }
      setSearching(false);
    }, 300);
    return () => { cancelled = true; clearTimeout(t2); };
  }, [foodQuery]);

  const totals = useMemo(() => {
    let cal = 0, pro = 0, carb = 0, fat = 0;
    for (const ing of ingredients) {
      const f = ing.grams / 100;
      cal += (ing.calories || 0) * f; pro += (ing.protein || 0) * f;
      carb += (ing.carbs || 0) * f; fat += (ing.fat || 0) * f;
    }
    return { calories: r1(cal), protein: r1(pro), carbs: r1(carb), fat: r1(fat) };
  }, [ingredients]);

  const perServing = useMemo(() => {
    const n = Math.max(1, Number(servings) || 1);
    return { calories: r1(totals.calories / n), protein: r1(totals.protein / n), carbs: r1(totals.carbs / n), fat: r1(totals.fat / n) };
  }, [totals, servings]);

  useEffect(() => {
    if (open && editMeal) {
      setMealName(editMeal.name || ''); setServings(1); setIngredients([]); setLoadingEdit(true);
      api(`/me/meals/${editMeal.id}/items`).then((r) => {
        setIngredients((r.items || []).map((it) => ({
          name: it.name, calories: it.quantity > 0 ? (it.calories / it.quantity) * 100 : 0,
          protein: it.quantity > 0 ? (it.protein / it.quantity) * 100 : 0,
          carbs: it.quantity > 0 ? (it.carbs / it.quantity) * 100 : 0,
          fat: it.quantity > 0 ? (it.fat / it.quantity) * 100 : 0, grams: it.quantity || 100
        })));
      }).catch(() => {}).finally(() => setLoadingEdit(false));
    } else if (open && !editMeal) { setMealName(''); setIngredients([]); setServings(1); }
  }, [open, editMeal?.id]);

  const addIngredient = (food) => {
    setIngredients((p) => [...p, { foodId: food.id, name: food.name, calories: Number(food.calories) || 0, protein: Number(food.protein) || 0, carbs: Number(food.carbs) || 0, fat: Number(food.fat) || 0, grams: 100 }]);
    setFoodQuery('');
  };

  const canSave = mealName.trim() && ingredients.length > 0 && ingredients.every((i) => i.grams > 0) && Number(servings) > 0;

  const saveAndLog = async () => {
    if (!canSave) return; setSaving(true);
    try {
      const n = Math.max(1, Number(servings) || 1);
      if (isEdit) {
        await api(`/me/meals/${editMeal.id}`, { method: 'PUT', body: JSON.stringify({ name: mealName.trim().slice(0, 80), calories: r1(totals.calories / n), protein: r1(totals.protein / n), carbs: r1(totals.carbs / n), fat: r1(totals.fat / n), foods: ingredients.map((i) => `${i.grams}g ${i.name}`).join(', ') }) });
        toast('Meal updated ✓');
      } else {
        const res = await api('/me/meals', { method: 'POST', body: JSON.stringify({ name: mealName.trim().slice(0, 80), slot: 'Meal', calories: r1(totals.calories / n), protein: r1(totals.protein / n), carbs: r1(totals.carbs / n), fat: r1(totals.fat / n), foods: ingredients.map((i) => `${i.grams}g ${i.name}`).join(', ') }) });
        if (res?.id) {
          for (const ing of ingredients) await api(`/me/meals/${res.id}/items`, { method: 'POST', body: JSON.stringify({ name: ing.name, quantity: ing.grams }) }).catch(() => {});
          await api(`/me/meals/${res.id}/log`, { method: 'POST' }).catch(() => {});
        }
        toast('Custom meal saved & logged ✓');
      }
      onClose(); setMealName(''); setIngredients([]); setServings(1); setFoodQuery(''); onSaved();
    } catch (e) { toast(e.message || 'Could not save meal'); }
    setSaving(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}>
      <div className="w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden rounded-3xl anim-scaleIn" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>
        {/* Header */}
        <div className="p-5 flex items-center justify-between shrink-0" style={{ borderBottom: `1px solid ${t.border}` }}>
          <div>
            <div className="font-grotesk font-bold" style={{ color: t.ink }}>{isEdit ? 'Edit meal' : 'Customize your meal'}</div>
            <div className="text-[11px] mt-0.5" style={{ color: t.mute }}>{isEdit ? 'Update your recipe' : 'Build a recipe from ingredients'}</div>
          </div>
          <button className="w-8 h-8 rounded-full grid place-items-center text-sm transition-colors" onClick={onClose} aria-label="Close" style={{ background: t.glass, color: t.mute, border: `1px solid ${t.border}` }}>✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-1.5 block" style={{ color: t.mute }}>Meal Name</label>
            <input className="w-full px-3.5 py-2.5 rounded-xl font-grotesk text-sm outline-none transition-colors" placeholder="e.g. Paneer Rice Bowl" value={mealName} onChange={(e) => setMealName(e.target.value)} autoFocus style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }} />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.mute }}>Ingredients</label>
              {ingredients.length > 0 && <span className="font-grotesk text-[10px]" style={{ color: t.faint }}>{ingredients.length} item{ingredients.length !== 1 ? 's' : ''}</span>}
            </div>

            {ingredients.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {ingredients.map((ing, idx) => (
                  <div key={idx} className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                    <span className="flex-1 min-w-0">
                      <span className="block font-grotesk text-[13px] font-semibold truncate" style={{ color: t.ink }}>{ing.name}</span>
                      <span className="text-[9px]" style={{ color: t.mute }}>{ing.calories} kcal · P{ing.protein} C{ing.carbs} F{ing.fat} <span style={{ color: t.faint }}>(per 100g)</span></span>
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input type="number" min="1" step="10" className="w-16 text-right px-1.5 py-1 rounded-lg font-grotesk text-[11px] outline-none" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }} value={ing.grams} onChange={(e) => { const n = Number(e.target.value); if (n >= 0) setIngredients((p) => p.map((x, i) => i === idx ? { ...x, grams: n } : x)); }} aria-label={`${ing.name} grams`} />
                      <span className="text-[10px] w-3" style={{ color: t.mute }}>g</span>
                      <button className="text-[11px] ml-1 transition-colors" style={{ color: t.danger + 'AA' }} onClick={() => setIngredients((p) => p.filter((_, i) => i !== idx))} aria-label={`Remove ${ing.name}`}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="relative">
              <input className="w-full px-3.5 py-2.5 rounded-xl font-grotesk text-sm outline-none transition-colors" placeholder="+ Add ingredient (search foods…)" value={foodQuery} onChange={(e) => setFoodQuery(e.target.value)} style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }} />
              {searchResults.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded-xl z-10 space-y-0.5 p-1" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}>
                  {searchResults.map((f) => (
                    <button key={f.id} onClick={() => addIngredient(f)} className="w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors" style={{ color: t.ink }} onMouseEnter={(e) => e.currentTarget.style.background = t.surfaceHover} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                      <span className="min-w-0">
                        <span className="block text-[12px] font-grotesk font-semibold truncate">{f.name}</span>
                        <span className="text-[9px]" style={{ color: t.mute }}>{f.source || 'food'} · {r1(f.calories)} kcal/100g</span>
                      </span>
                      <span className="text-[10px] shrink-0 font-semibold" style={{ color: t.gold }}>+ Add</span>
                    </button>
                  ))}
                </div>
              )}
              {foodQuery.length >= 2 && searchResults.length === 0 && !searching && (
                <div className="absolute left-0 right-0 top-full mt-1 rounded-xl z-10 p-3 text-center text-[11px]" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 12px 40px rgba(0,0,0,0.4)', color: t.mute }}>No foods found for "{foodQuery}"</div>
              )}
              {searching && foodQuery.length >= 2 && (
                <div className="absolute left-0 right-0 top-full mt-1 rounded-xl z-10 p-3 text-center text-[11px]" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 12px 40px rgba(0,0,0,0.4)', color: t.mute }}>Searching…</div>
              )}
            </div>
          </div>

          {ingredients.length > 0 && (
            <div className="rounded-xl p-3.5" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
              <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2" style={{ color: t.mute }}>Recipe total</div>
              <div className="grid grid-cols-4 gap-2 text-center">
                {[['Calories', totals.calories, 'kcal'], ['Protein', totals.protein, 'g'], ['Carbs', totals.carbs, 'g'], ['Fat', totals.fat, 'g']].map(([l, v, u]) => (
                  <div key={l}><div className="font-grotesk font-bold text-sm" style={{ color: t.ink }}>{v}</div><div className="text-[9px]" style={{ color: t.mute }}>{u}</div></div>
                ))}
              </div>
            </div>
          )}

          {ingredients.length > 0 && (
            <div className="flex items-center gap-3">
              <label className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold shrink-0" style={{ color: t.mute }}>Servings</label>
              <input type="number" min="1" step="1" className="w-16 text-center px-2 py-1.5 rounded-lg font-grotesk text-sm outline-none" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }} value={servings} onChange={(e) => setServings(Math.max(1, parseInt(e.target.value, 10) || 1))} />
              <span className="text-[10px]" style={{ color: t.faint }}>= {r1(totals.calories / Math.max(1, Number(servings) || 1))} kcal / serving</span>
            </div>
          )}

          {ingredients.length > 0 && (
            <div className="rounded-xl p-3.5" style={{ background: t.goldDim, border: `1px solid ${t.gold}30` }}>
              <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2" style={{ color: t.gold }}>Per serving ({Math.max(1, Number(servings) || 1)} servings)</div>
              <div className="grid grid-cols-4 gap-2 text-center">
                {[['Calories', perServing.calories, 'kcal'], ['Protein', perServing.protein, 'g'], ['Carbs', perServing.carbs, 'g'], ['Fat', perServing.fat, 'g']].map(([l, v, u]) => (
                  <div key={l}><div className="font-grotesk font-bold text-sm" style={{ color: t.gold }}>{v}</div><div className="text-[9px]" style={{ color: t.mute }}>{u}</div></div>
                ))}
              </div>
            </div>
          )}

          {ingredients.length === 0 && (
            <div className="text-center py-6 text-xs" style={{ color: t.mute }}>Search for foods above to start building your meal.</div>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 shrink-0" style={{ borderTop: `1px solid ${t.border}` }}>
          <button className="w-full py-3 rounded-xl font-grotesk text-sm font-bold transition-all active:scale-[.97]" disabled={!canSave || saving || loadingEdit} onClick={saveAndLog}
            style={{ background: canSave ? t.accent : t.surface, color: canSave ? '#fff' : t.mute, border: `1px solid ${canSave ? t.accent : t.border}`, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'not-allowed' }}>
            {saving ? 'Saving…' : loadingEdit ? 'Loading…' : isEdit ? 'Update meal' : 'Save & log 1 serving'}
          </button>
          {canSave && <div className="text-center text-[10px] mt-2" style={{ color: t.faint }}>1 serving = {perServing.calories} kcal · P{perServing.protein}g · C{perServing.carbs}g · F{perServing.fat}g</div>}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   SavedMealsModal — preserved from existing implementation
   ════════════════════════════════════════════════════════════════ */

function SavedMealsModal({ open, onClose, onEdit, toast, onRefresh }) {
  const { theme } = useTheme();
  const t = T[theme] || T.dark;
  const [meals, setMeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = async () => { setLoading(true); setError(null); try { const res = await api('/me/meals'); setMeals(res.meals || []); } catch (e) { setError(e.message); } setLoading(false); };
  useEffect(() => { if (open) load(); }, [open]);

  const logMeal = async (m) => { try { await api(`/me/meals/${m.id}/log`, { method: 'POST' }); toast(`Logged ${m.name} ✓`); onRefresh(); onClose(); } catch (e) { toast(e.message); } };
  const confirmDelete = (m) => { if (!window.confirm(`Delete "${m.name}"?\n\nIf you've logged it today, today's entry will also be removed. Previous nutrition history will be preserved.`)) return; deleteMeal(m.id); };
  const deleteMeal = async (id) => { setDeleting(id); try { await api(`/me/meals/${id}`, { method: 'DELETE' }); setMeals((p) => p.filter((m) => m.id !== id)); toast('Meal deleted'); onRefresh(); } catch (e) { toast(e.message); } setDeleting(null); };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}>
      <div className="w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden rounded-3xl anim-scaleIn" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>
        <div className="p-5 flex items-center justify-between shrink-0" style={{ borderBottom: `1px solid ${t.border}` }}>
          <div>
            <div className="font-grotesk font-bold" style={{ color: t.ink }}>Saved meals</div>
            <div className="text-[11px] mt-0.5" style={{ color: t.mute }}>Quick log from your recipes</div>
          </div>
          <button className="w-8 h-8 rounded-full grid place-items-center text-sm transition-colors" onClick={onClose} aria-label="Close" style={{ background: t.glass, color: t.mute, border: `1px solid ${t.border}` }}>✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {loading && <div className="text-center py-8 text-xs" style={{ color: t.mute }}>Loading saved meals…</div>}
          {error && <div className="text-center py-8"><div className="text-xs mb-2" style={{ color: t.danger }}>Couldn't load your saved meals.</div><button className="px-3 py-1.5 rounded-lg text-xs font-grotesk" onClick={load} style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}>Retry</button></div>}
          {!loading && !error && meals.length === 0 && (
            <div className="text-center py-8 space-y-3">
              <div className="w-14 h-14 mx-auto rounded-2xl grid place-items-center text-2xl" style={{ background: t.surface, border: `1px solid ${t.border}` }}>🍽️</div>
              <div className="text-sm font-grotesk font-semibold" style={{ color: t.ink }}>No saved meals yet</div>
              <div className="text-[11px]" style={{ color: t.mute }}>Create a custom meal and it will appear here.</div>
            </div>
          )}
          {!loading && !error && meals.length > 0 && (
            <div className="space-y-2">
              {meals.map((m) => (
                <div key={m.id} className="rounded-xl p-3.5" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                  <div className="font-grotesk text-sm font-bold mb-1" style={{ color: t.ink }}>{m.name}</div>
                  <div className="text-[10px] mb-2.5" style={{ color: t.mute }}>{m.calories} kcal · P{m.protein}g · C{m.carbs}g · F{m.fat}g{m.item_count ? ` · ${m.item_count} items` : ''}</div>
                  <div className="flex gap-2">
                    <button className="flex-1 py-2 rounded-xl font-grotesk text-[11px] font-bold transition-all active:scale-[.97]" onClick={() => logMeal(m)} style={{ background: t.accent, color: '#fff' }}>Log 1 Serving</button>
                    <button className="px-3 py-2 rounded-xl font-grotesk text-[11px] font-semibold transition-all active:scale-[.97]" onClick={() => { onClose(); onEdit(m); }} style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}>Edit</button>
                    <button className="px-3 py-2 rounded-xl font-grotesk text-[11px] font-semibold transition-all active:scale-[.97]" disabled={deleting === m.id} onClick={() => confirmDelete(m)} style={{ background: 'transparent', border: `1px solid ${t.danger}30`, color: t.danger + 'CC' }}>{deleting === m.id ? '…' : 'Delete'}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   EDIT LOG MODAL — edit quantity of a logged food entry
   ════════════════════════════════════════════════════════════════ */

function EditLogModal({ open, log, onClose, onSave, t }) {
  const [quantity, setQuantity] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && log) setQuantity(String(log.quantity || 100));
  }, [open, log?.id]);

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

  const handleSave = async () => {
    setSaving(true);
    await onSave(log.id, { quantity: newQty, unit: log.unit });
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}>
      <div className="w-full max-w-sm rounded-3xl overflow-hidden anim-scaleIn" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.accent }}>Edit Entry</div>
          <div className="font-grotesk text-base font-bold mt-1" style={{ color: t.ink }}>{log.name}</div>
        </div>

        {/* Quantity input */}
        <div className="px-5 pb-4">
          <label className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-1.5 block" style={{ color: t.mute }}>Quantity ({log.unit || 'g'})</label>
          <input type="number" className="w-full px-4 py-3 rounded-xl font-grotesk text-sm font-bold outline-none" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }} value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus />
        </div>

        {/* Nutrition preview */}
        <div className="px-5 pb-4">
          <div className="rounded-xl p-3" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2" style={{ color: t.mute }}>Updated Nutrition</div>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[['Calories', log.calories, preview.calories, 'kcal'], ['Protein', log.protein, preview.protein, 'g'], ['Carbs', log.carbs, preview.carbs, 'g'], ['Fat', log.fat, preview.fat, 'g']].map(([label, old, newVal, unit]) => (
                <div key={label}>
                  <div className="font-grotesk text-[10px]" style={{ color: t.mute }}>{label}</div>
                  <div className="font-grotesk text-xs font-bold" style={{ color: t.ink }}>{old}{unit}</div>
                  {Math.abs(old - newVal) > 0.5 && (
                    <div className="font-grotesk text-[10px] font-semibold" style={{ color: t.accent }}>→ {newVal}{unit}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-semibold transition-all active:scale-95" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.mute }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || newQty <= 0} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={{ background: (saving || newQty <= 0) ? t.surface : t.accent, color: (saving || newQty <= 0) ? t.mute : '#fff', border: `1px solid ${(saving || newQty <= 0) ? t.border : t.accent}`, opacity: (saving || newQty <= 0) ? 0.5 : 1, cursor: (saving || newQty <= 0) ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving…' : 'Save Changes'}</button>
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
        <div className="px-5 pt-5 pb-4 text-center">
          <div className="w-12 h-12 mx-auto rounded-full grid place-items-center text-xl mb-3" style={{ background: `${t.danger}10`, border: `1px solid ${t.danger}30` }}>🗑️</div>
          <div className="font-grotesk text-sm font-bold mb-1" style={{ color: t.ink }}>Remove from today's intake?</div>
          <div className="text-[11px]" style={{ color: t.mute }}>{log.name} · {log.quantity || 100}{log.unit || 'g'} · {log.calories} kcal</div>
        </div>
        <div className="px-5 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-semibold transition-all active:scale-95" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.mute }}>Cancel</button>
          <button onClick={() => onConfirm(log.id)} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={{ background: t.danger, color: '#fff' }}>Remove</button>
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

  const home = useFetch(() => api('/tracking/me/home'));
  const [meals, setMeals] = useState(null);
  const [water, setWater] = useState(null);
  const [supTaken, setSupTaken] = useState({});
  const [aiText, setAiText] = useState('');
  const [aiResult, setAiResult] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [logging, setLogging] = useState(false);
  const [toast, setToast] = useState('');
  const [supList, setSupList] = useState(null);
  const foods = useFetch(() => api('/me/foods'));
  const myMeals = useFetch(() => api('/me/meals'));
  const [foodForm, setFoodForm] = useState({ name: '', unit: '', serving: '', calories: '', protein: '', carbs: '', fat: '' });
  const [mealForm, setMealForm] = useState({ slot: 'Meal', name: '', time: '', calories: '', protein: '', carbs: '', fat: '', foods: '' });
  const [saving, setSaving] = useState(false);
  const [openSection, setOpenSection] = useState(null);
  const [supForm, setSupForm] = useState({ name: '', dose: '', schedule_time: '' });
  const [savingSup, setSavingSup] = useState(false);
  const [composing, setComposing] = useState(null);
  const [items, setItems] = useState([]);
  const [foodSearch, setFoodSearch] = useState('');
  const [foodQty, setFoodQty] = useState(1);
  const [chosenFood, setChosenFood] = useState(null);
  const [customMealOpen, setCustomMealOpen] = useState(false);
  const [editMeal, setEditMeal] = useState(null);
  const [savedMealsOpen, setSavedMealsOpen] = useState(false);
  const [logFoodMenuOpen, setLogFoodMenuOpen] = useState(false);
  const [targetSetupOpen, setTargetSetupOpen] = useState(false);
  const [editLogOpen, setEditLogOpen] = useState(false);
  const [editLog, setEditLog] = useState(null);
  const [deleteLogOpen, setDeleteLogOpen] = useState(false);
  const [deleteLog, setDeleteLog] = useState(null);

  const data = home.data;
  const clientId = data?.client?.id;

  useEffect(() => { if (clientId) api(`/tracking/clients/${clientId}/supplements`).then((r) => setSupList(r.supplements || [])).catch(() => {}); }, [clientId]);

  const plan = data?.nutrition?.plan;

  // Auto-open target setup if no plan exists after data loads
  useEffect(() => {
    if (data && !plan && !targetSetupOpen) setTargetSetupOpen(true);
  }, [data, plan]);
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
    await api(`/nutrition/clients/${clientId}/meals/toggle`, { method: 'POST', body: JSON.stringify({ meal_id: m.id, eaten: next }) }).catch(() => home.reload());
  };

  const editLogEntry = async (logId, updates) => {
    try {
      await api(`/me/meal-logs/${logId}`, { method: 'PUT', body: JSON.stringify(updates) });
      setToast('Entry updated ✓');
      setEditLogOpen(false);
      setEditLog(null);
      home.reload();
    } catch (e) { setToast(e.message); }
  };

  const deleteLogEntry = async (logId) => {
    try {
      await api(`/me/meal-logs/${logId}`, { method: 'DELETE' });
      setToast('Entry removed ✓');
      setDeleteLogOpen(false);
      setDeleteLog(null);
      home.reload();
    } catch (e) { setToast(e.message); }
  };

  const addWater = async (litres = 0.25) => {
    const next = Math.min(data.water.target, Math.round((waterState + litres) * 100) / 100);
    setWater(next);
    await api(`/tracking/clients/${clientId}/water`, { method: 'POST', body: JSON.stringify({ litres: next }) }).catch(() => home.reload());
  };

  const estimate = async () => {
    if (!aiText.trim()) return; setEstimating(true);
    try { const res = await api(`/nutrition/clients/${clientId}/meals/ai-estimate`, { method: 'POST', body: JSON.stringify({ text: aiText }) }); setAiResult(res); }
    catch (e) { setToast(e.message); } setEstimating(false);
  };

  const logAi = async () => {
    if (!aiResult) return; setLogging(true);
    try {
      await api(`/nutrition/clients/${clientId}/meals/log`, { method: 'POST', body: JSON.stringify({ name: aiText.slice(0, 100), slot: 'Snack', calories: aiResult.total.calories, protein: aiResult.total.protein, carbs: aiResult.total.carbs, fat: aiResult.total.fat, source: 'ai', estimate: true, eaten: true }) });
      setToast('Meal logged ✓'); setAiText(''); setAiResult(null); home.reload();
    } catch (e) { setToast(e.message); } setLogging(false);
  };

  const openComposer = async (m) => {
    setComposing(m); setFoodSearch(''); setFoodQty(1); setChosenFood(null);
    try { const r = await api(`/me/meals/${m.id}/items`); setItems(r.items || []); } catch (e) { setToast(e.message || 'Could not open meal'); }
  };

  const reloadItems = async () => { try { const r = await api(`/me/meals/${composing.id}/items`); setItems(r.items || []); myMeals.reload(); } catch (e) { setToast(e.message); } };
  const setItemQty = async (it, q) => { const n = Number(q); if (!n || n <= 0) return; try { await api(`/me/meals/${composing.id}/items/${it.id}`, { method: 'PUT', body: JSON.stringify({ quantity: n }) }); await reloadItems(); } catch (e) { setToast(e.message); } };
  const addItem = async (f) => { try { await api(`/me/meals/${composing.id}/items`, { method: 'POST', body: JSON.stringify({ food_id: f.id, quantity: Number(foodQty) || 1 }) }); setChosenFood(null); setFoodQty(1); setFoodSearch(''); await reloadItems(); setToast(`${f.name} added`); } catch (e) { setToast(e.message); } };
  const allFoods = [...(foods.data?.mine || []).map((f) => ({ ...f, scope: 'MY FOOD' })), ...(foods.data?.gym || []).map((f) => ({ ...f, scope: 'GYM' })), ...(foods.data?.global || []).map((f) => ({ ...f, scope: 'GLOBAL' }))];

  return (
    <div className="space-y-5 pb-24">

      {/* ══════ HEADER ══════ */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-grotesk font-bold text-xl" style={{ color: t.ink }}>Today's Fuel</h1>
          <div className="text-xs mt-0.5" style={{ color: t.mute }}>
            {plan ? `${plan.calories} kcal target · P${plan.protein}g · C${plan.carbs}g · F${plan.fat}g` : 'No plan assigned'}
          </div>
        </div>
        <button onClick={() => setLogFoodMenuOpen(true)} className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-95" style={{ background: t.accent, color: '#fff', boxShadow: `0 4px 15px ${t.accent}40` }}>
          <span className="text-sm leading-none">+</span> Log Food
        </button>
      </div>

      {/* ══════ TODAY'S FUEL HERO ══════ */}
      <div className="relative overflow-hidden rounded-3xl p-6" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: t.heroGlow }} />
        <div className="relative z-10">
          <div className="flex flex-col md:flex-row items-center gap-6">
            {/* Calorie Ring */}
            <div className="shrink-0">
              <CalorieRing value={eaten.calories} max={plan?.calories || 0} t={t} />
            </div>

            {/* Macro Bars */}
            <div className="flex-1 w-full space-y-4">
              <MacroBar label="Protein" value={eaten.protein} max={plan?.protein || 0} color={t.protein} t={t} />
              <MacroBar label="Carbs" value={eaten.carbs} max={plan?.carbs || 0} color={t.carbs} t={t} />
              <MacroBar label="Fat" value={eaten.fat} max={plan?.fat || 0} color={t.fat} t={t} />
            </div>
          </div>

          {/* Quick actions */}
          <div className="flex gap-2 mt-5 pt-4" style={{ borderTop: `1px solid ${t.border}` }}>
            {[
              { label: 'Log Food', icon: '✦', onClick: () => setLogFoodMenuOpen(true), color: t.accent },
              { label: 'Water', icon: '💧', onClick: () => addWater(0.25), color: t.water },
              { label: 'Saved Meals', icon: '📋', onClick: () => setSavedMealsOpen(true), color: t.gold },
            ].map((a) => (
              <button key={a.label} onClick={a.onClick} className="flex items-center gap-1.5 px-3 py-2 rounded-xl font-grotesk text-[11px] font-semibold transition-all active:scale-95" style={{ background: `${a.color}10`, border: `1px solid ${a.color}25`, color: a.color }}>
                <span className="text-xs">{a.icon}</span> {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ══════ INSIGHT ══════ */}
      <NutritionInsight plan={plan} eaten={eaten} t={t} />

      {/* ══════ TODAY'S MEALS ══════ */}
      <div className="rounded-3xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <SectionHeader title="Today's Meals" subtitle={`${mealState.filter(m => m.eaten).length} of ${mealState.length} logged`} t={t} />
        <MealTimeline meals={mealState} onToggle={toggleMeal} onEditLog={(m) => { setEditLog(m); setEditLogOpen(true); }} onDeleteLog={(m) => { setDeleteLog(m); setDeleteLogOpen(true); }} t={t} />
      </div>

      {/* ══════ HYDRATION ══════ */}
      <HydrationCard waterState={waterState} target={data.water.target} onAdd={addWater} t={t} />

      {/* ══════ AI FOOD ESTIMATE ══════ */}
      <div id="log-food-section" className="rounded-3xl p-5 scroll-mt-20" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <SectionHeader title="What did you eat?" t={t} />
        <div className="flex gap-2">
          <input className="flex-1 px-3.5 py-2.5 rounded-xl font-grotesk text-sm outline-none" placeholder='"2 rotis, dal and curd"' value={aiText} onChange={(e) => setAiText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && estimate()} style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }} />
          <button className="shrink-0 px-4 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-95" onClick={estimate} disabled={estimating || !aiText.trim()} style={{ background: (estimating || !aiText.trim()) ? t.surface : t.accent, color: (estimating || !aiText.trim()) ? t.mute : '#fff', cursor: (estimating || !aiText.trim()) ? 'not-allowed' : 'pointer' }}>
            {estimating ? '…' : 'Estimate'}
          </button>
        </div>
        {aiResult && (
          <div className="mt-3 rounded-xl p-4" style={{ background: t.goldDim, border: `1px solid ${t.gold}25` }}>
            {aiResult.items?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {aiResult.items.map((it, i) => <span key={i} className="px-2 py-0.5 rounded-lg text-[10px] font-grotesk" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}>{it.qty}× {it.name} (~{it.calories} kcal)</span>)}
              </div>
            )}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="font-grotesk text-sm font-bold" style={{ color: t.gold }}>~{aiResult.total.calories} kcal · P{aiResult.total.protein}g · C{aiResult.total.carbs}g · F{aiResult.total.fat}g</div>
              <div className="flex gap-2">
                <button className="px-3 py-1.5 rounded-xl font-grotesk text-[11px] font-semibold active:scale-95" onClick={() => setAiResult(null)} style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}>Edit</button>
                <button className="px-3 py-1.5 rounded-xl font-grotesk text-[11px] font-bold active:scale-95" onClick={logAi} disabled={logging} style={{ background: t.gold, color: '#000' }}>{logging ? '…' : 'Log it'}</button>
              </div>
            </div>
            <div className="text-[10px] mt-2" style={{ color: t.faint }}>⚠️ {aiResult.disclaimer}</div>
          </div>
        )}
      </div>

      {/* ══════ MY FOODS ══════ */}
      <div className="rounded-3xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <div className="flex items-center justify-between mb-3">
          <SectionHeader title="My Foods" subtitle={foods.data?.mine?.length ? `${foods.data.mine.length} saved` : undefined} t={t} action={
            <button className="px-2.5 py-1 rounded-lg text-[10px] font-grotesk font-semibold transition-colors" onClick={() => setOpenSection(openSection === 'foods' ? null : 'foods')} style={{ background: openSection === 'foods' ? t.accentDim : t.glass, color: openSection === 'foods' ? t.accent : t.mute, border: `1px solid ${openSection === 'foods' ? t.accent + '30' : t.border}` }}>
              {openSection === 'foods' ? 'Close' : 'Manage'}
            </button>
          } />
        </div>

        {!openSection === 'foods' && !!foods.data?.mine?.length && (
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {foods.data.mine.slice(0, 6).map((f) => (
              <div key={f.id} className="shrink-0 rounded-xl px-3 py-2 min-w-[120px]" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                <div className="font-grotesk text-[11px] font-semibold truncate" style={{ color: t.ink }}>{f.name}</div>
                <div className="font-grotesk text-[10px]" style={{ color: t.mute }}>{f.calories} kcal</div>
              </div>
            ))}
          </div>
        )}

        {openSection === 'foods' && (
          <div className="space-y-3">
            <div className="rounded-xl p-3 space-y-2" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
              <div className="grid grid-cols-2 gap-2">
                <input className="px-3 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="Food name" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={foodForm.name} onChange={(e) => setFoodForm((f) => ({ ...f, name: e.target.value }))} />
                <input className="px-3 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="Serving (e.g. 150 g)" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={foodForm.serving} onChange={(e) => setFoodForm((f) => ({ ...f, serving: e.target.value }))} />
              </div>
              <div className="grid grid-cols-4 gap-2">
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="kcal" type="number" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={foodForm.calories} onChange={(e) => setFoodForm((f) => ({ ...f, calories: e.target.value }))} />
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="P" type="number" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={foodForm.protein} onChange={(e) => setFoodForm((f) => ({ ...f, protein: e.target.value }))} />
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="C" type="number" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={foodForm.carbs} onChange={(e) => setFoodForm((f) => ({ ...f, carbs: e.target.value }))} />
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="F" type="number" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={foodForm.fat} onChange={(e) => setFoodForm((f) => ({ ...f, fat: e.target.value }))} />
              </div>
              <button className="w-full py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" disabled={saving || !foodForm.name.trim()} onClick={async () => { setSaving(true); try { await api('/me/foods', { method: 'POST', body: JSON.stringify({ ...foodForm, calories: Number(foodForm.calories) || 0, protein: Number(foodForm.protein) || 0, carbs: Number(foodForm.carbs) || 0, fat: Number(foodForm.fat) || 0 }) }); setFoodForm({ name: '', unit: '', serving: '', calories: '', protein: '', carbs: '', fat: '' }); foods.reload(); setToast('Food saved ✓'); } catch (e) { setToast(e.message); } setSaving(false); }}
                style={{ background: (saving || !foodForm.name.trim()) ? t.surface : t.accent, color: (saving || !foodForm.name.trim()) ? t.mute : '#fff', cursor: (saving || !foodForm.name.trim()) ? 'not-allowed' : 'pointer' }}>
                Save to My Foods
              </button>
            </div>

            {!!foods.data?.mine?.length && (
              <div className="space-y-1.5">
                {foods.data.mine.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-grotesk font-semibold" style={{ color: t.ink }}>{f.name}</span>
                      <span className="text-[10px]" style={{ color: t.mute }}>{f.serving || f.unit || ''} · {f.calories} kcal · P{f.protein} C{f.carbs} F{f.fat}</span>
                    </span>
                    <button className="px-2.5 py-1 rounded-lg text-[10px] font-grotesk font-semibold shrink-0 transition-all active:scale-95" style={{ background: t.accentDim, color: t.accent }} onClick={async () => { try { await api(`/nutrition/clients/${clientId}/meals/log`, { method: 'POST', body: JSON.stringify({ name: f.name, slot: 'Snack', calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, source: 'custom', eaten: true }) }); setToast('Logged ' + f.name); home.reload(); } catch (e) { setToast(e.message); } }}>Log</button>
                    <button className="text-[10px] shrink-0 transition-colors" style={{ color: t.danger + 'AA' }} onClick={async () => { try { await api(`/me/foods/${f.id}`, { method: 'DELETE' }); foods.reload(); } catch (e) { setToast(e.message); } }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══════ MY MEALS ══════ */}
      <div className="rounded-3xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <div className="flex items-center justify-between mb-3">
          <SectionHeader title="My Meals" subtitle={myMeals.data?.meals?.length ? `${myMeals.data.meals.length} templates` : undefined} t={t} action={
            <button className="px-2.5 py-1 rounded-lg text-[10px] font-grotesk font-semibold transition-colors" onClick={() => setOpenSection(openSection === 'meals' ? null : 'meals')} style={{ background: openSection === 'meals' ? t.accentDim : t.glass, color: openSection === 'meals' ? t.accent : t.mute, border: `1px solid ${openSection === 'meals' ? t.accent + '30' : t.border}` }}>
              {openSection === 'meals' ? 'Close' : 'Manage'}
            </button>
          } />
        </div>

        {openSection === 'meals' && (
          <div className="space-y-3">
            <div className="rounded-xl p-3 space-y-2" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
              <div className="grid grid-cols-3 gap-2">
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="Slot" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={mealForm.slot} onChange={(e) => setMealForm((f) => ({ ...f, slot: e.target.value }))} />
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="Name" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={mealForm.name} onChange={(e) => setMealForm((f) => ({ ...f, name: e.target.value }))} />
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="Time" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={mealForm.time} onChange={(e) => setMealForm((f) => ({ ...f, time: e.target.value }))} />
              </div>
              <div className="grid grid-cols-4 gap-2">
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="kcal" type="number" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={mealForm.calories} onChange={(e) => setMealForm((f) => ({ ...f, calories: e.target.value }))} />
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="P" type="number" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={mealForm.protein} onChange={(e) => setMealForm((f) => ({ ...f, protein: e.target.value }))} />
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="C" type="number" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={mealForm.carbs} onChange={(e) => setMealForm((f) => ({ ...f, carbs: e.target.value }))} />
                <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="F" type="number" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={mealForm.fat} onChange={(e) => setMealForm((f) => ({ ...f, fat: e.target.value }))} />
              </div>
              <input className="w-full px-3 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="Foods (e.g. 50g oats · 200ml milk)" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={mealForm.foods} onChange={(e) => setMealForm((f) => ({ ...f, foods: e.target.value }))} />
              <button className="w-full py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" disabled={saving || !mealForm.name.trim()} onClick={async () => { setSaving(true); try { await api('/me/meals', { method: 'POST', body: JSON.stringify({ ...mealForm, calories: Number(mealForm.calories) || 0, protein: Number(mealForm.protein) || 0, carbs: Number(mealForm.carbs) || 0, fat: Number(mealForm.fat) || 0 }) }); setMealForm({ slot: 'Meal', name: '', time: '', calories: '', protein: '', carbs: '', fat: '', foods: '' }); myMeals.reload(); setToast('Meal template saved ✓'); } catch (e) { setToast(e.message); } setSaving(false); }}
                style={{ background: (saving || !mealForm.name.trim()) ? t.surface : t.accent, color: (saving || !mealForm.name.trim()) ? t.mute : '#fff', cursor: (saving || !mealForm.name.trim()) ? 'not-allowed' : 'pointer' }}>
                Save meal template
              </button>
            </div>

            {!!myMeals.data?.meals?.length && (
              <div className="space-y-1.5">
                {myMeals.data.meals.map((m) => (
                  <div key={m.id}>
                    <div className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-grotesk font-semibold" style={{ color: t.ink }}>{m.name}</span>
                        <span className="text-[10px]" style={{ color: t.mute }}>{m.slot}{m.time ? ` · ${m.time}` : ''} · {m.calories} kcal · P{m.protein} C{m.carbs} F{m.fat}{m.item_count ? ` · ${m.item_count} items` : ''}</span>
                      </span>
                      <button className="px-2 py-1 rounded-lg text-[10px] font-grotesk font-semibold shrink-0 active:scale-95" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }} onClick={() => openComposer(m)}>Compose</button>
                      <button className="px-2.5 py-1 rounded-lg text-[10px] font-grotesk font-semibold shrink-0 active:scale-95" style={{ background: t.accentDim, color: t.accent }} onClick={async () => { try { await api(`/me/meals/${m.id}/log`, { method: 'POST' }); setToast('Logged ' + m.name); home.reload(); } catch (e) { setToast(e.message); } }}>Eaten</button>
                      <button className="text-[10px] shrink-0 transition-colors" style={{ color: t.danger + 'AA' }} onClick={async () => { try { await api(`/me/meals/${m.id}`, { method: 'DELETE' }); myMeals.reload(); } catch (e) { setToast(e.message); } }}>✕</button>
                    </div>
                    {composing?.id === m.id && (
                      <div className="mt-2 rounded-xl p-3.5 space-y-2.5" style={{ background: t.goldDim, border: `1px solid ${t.gold}25` }}>
                        <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.gold }}>BUILD {m.name.toUpperCase()}</div>
                        {items.length > 0 && (
                          <div className="space-y-1.5">
                            {items.map((it) => (
                              <div key={it.id} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                                <span className="flex-1 min-w-0">
                                  <span className="block text-[12px] font-grotesk font-semibold truncate" style={{ color: t.ink }}>{it.name}</span>
                                  <span className="text-[9px]" style={{ color: t.mute }}>{it.quantity}× {it.unit || 'serving'} · {it.calories} kcal</span>
                                </span>
                                <div className="flex items-center gap-1 shrink-0">
                                  <input type="number" min="0.1" step="0.1" className="w-14 px-1.5 py-1 rounded-lg font-grotesk text-[10px] outline-none" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={it.quantity} aria-label={`${it.name} quantity`} onChange={(e) => setItemQty(it, e.target.value)} />
                                  <button className="text-[11px] transition-colors" style={{ color: t.danger + 'AA' }} onClick={async () => { try { await api(`/me/meals/${m.id}/items/${it.id}`, { method: 'DELETE' }); await reloadItems(); } catch (e) { setToast(e.message); } }} aria-label={`Remove ${it.name}`}>✕</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <input className="flex-1 px-3 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="Search foods…" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={foodSearch} onChange={(e) => setFoodSearch(e.target.value)} />
                          <input type="number" min="0.1" step="0.1" className="w-16 px-2 py-2 rounded-lg font-grotesk text-xs outline-none" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={foodQty} onChange={(e) => setFoodQty(e.target.value)} aria-label="Quantity" />
                        </div>
                        {!!foodSearch && (
                          <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                            {allFoods.filter((f) => (f.name + ' ' + (f.scope || '')).toLowerCase().includes(foodSearch.toLowerCase())).slice(0, 15).map((f) => (
                              <button key={f.id} onClick={() => addItem(f)} className="w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                                <span className="min-w-0">
                                  <span className="block text-[12px] font-grotesk font-semibold truncate" style={{ color: t.ink }}>{f.name}</span>
                                  <span className="text-[9px]" style={{ color: t.mute }}>{f.scope} · {f.calories} kcal</span>
                                </span>
                                <span className="text-[10px] shrink-0 font-semibold" style={{ color: t.gold }}>+ Add</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══════ SUPPLEMENTS ══════ */}
      <div className="rounded-3xl p-5" style={{ background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow }}>
        <SectionHeader title="Supplements" t={t} />
        {supList?.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {supList.map((s) => {
              const taken = !!supTaken[s.id];
              return (
                <button key={s.id} onClick={() => setSupTaken((x) => ({ ...x, [s.id]: !taken }))} className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all" style={{ background: taken ? `${t.accent}10` : t.glass, border: `1px solid ${taken ? t.accent + '30' : t.border}` }}>
                  <span className="w-5 h-5 rounded-md grid place-items-center text-[10px]" style={{ background: taken ? t.accent : 'transparent', color: taken ? '#fff' : 'transparent', border: `1px solid ${taken ? t.accent : t.border}` }}>✓</span>
                  <span className="flex-1 font-grotesk text-sm font-semibold" style={{ color: t.ink }}>{s.name}</span>
                  <span className="text-[10px]" style={{ color: t.mute }}>{s.dose || ''}{s.schedule_time ? ` · ${s.schedule_time}` : ''}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="rounded-xl p-3 space-y-2" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
          <div className="grid grid-cols-3 gap-2">
            <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="Name" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={supForm.name} onChange={(e) => setSupForm((f) => ({ ...f, name: e.target.value }))} />
            <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" placeholder="Dose" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={supForm.dose} onChange={(e) => setSupForm((f) => ({ ...f, dose: e.target.value }))} />
            <input className="px-2.5 py-2 rounded-lg font-grotesk text-xs outline-none" type="time" placeholder="Time" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} value={supForm.schedule_time} onChange={(e) => setSupForm((f) => ({ ...f, schedule_time: e.target.value }))} />
          </div>
          <button className="w-full py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" disabled={savingSup || !supForm.name.trim()} onClick={async () => { setSavingSup(true); try { await api(`/tracking/clients/${clientId}/supplements`, { method: 'POST', body: JSON.stringify({ name: supForm.name.trim(), dose: supForm.dose || undefined, schedule_time: supForm.schedule_time || undefined }) }); setSupForm({ name: '', dose: '', schedule_time: '' }); api(`/tracking/clients/${clientId}/supplements`).then((r) => setSupList(r.supplements || [])).catch(() => {}); setToast('Supplement added ✓'); } catch (e) { setToast(e.message); } setSavingSup(false); }}
            style={{ background: (savingSup || !supForm.name.trim()) ? t.surface : t.accent, color: (savingSup || !supForm.name.trim()) ? t.mute : '#fff', cursor: (savingSup || !supForm.name.trim()) ? 'not-allowed' : 'pointer' }}>
            Add supplement
          </button>
        </div>
      </div>

      {/* ══════ TOAST ══════ */}
      {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full font-grotesk text-xs shadow-lg anim-toast" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink, boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>{toast}</div>}

      {/* ══════ LOG FOOD MENU ══════ */}
      {logFoodMenuOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) setLogFoodMenuOpen(false); }} style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}>
          <div className="w-full max-w-sm overflow-hidden rounded-3xl anim-scaleIn" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>
            <div className="p-5" style={{ borderBottom: `1px solid ${t.border}` }}>
              <div className="font-grotesk font-bold" style={{ color: t.ink }}>Log Food</div>
            </div>
            <div className="p-2">
              <button className="w-full flex items-center gap-3 p-3.5 rounded-2xl text-left transition-colors" onClick={() => { setLogFoodMenuOpen(false); setCustomMealOpen(true); }} style={{ color: t.ink }} onMouseEnter={(e) => e.currentTarget.style.background = t.surfaceHover} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <div className="w-11 h-11 rounded-2xl grid place-items-center text-lg shrink-0" style={{ background: t.goldDim, border: `1px solid ${t.gold}25` }}>🍳</div>
                <div>
                  <div className="font-grotesk text-sm font-bold">Customize My Meal</div>
                  <div className="text-[11px]" style={{ color: t.mute }}>Build a meal from individual ingredients</div>
                </div>
              </button>
              <button className="w-full flex items-center gap-3 p-3.5 rounded-2xl text-left transition-colors" onClick={() => { setLogFoodMenuOpen(false); setSavedMealsOpen(true); }} style={{ color: t.ink }} onMouseEnter={(e) => e.currentTarget.style.background = t.surfaceHover} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <div className="w-11 h-11 rounded-2xl grid place-items-center text-lg shrink-0" style={{ background: t.accentDim, border: `1px solid ${t.accent}25` }}>📋</div>
                <div>
                  <div className="font-grotesk text-sm font-bold">Saved Meals</div>
                  <div className="text-[11px]" style={{ color: t.mute }}>View and manage your saved meals</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════ NUTRITION TARGET SETUP ══════ */}
      <NutritionTargetSetup open={targetSetupOpen} onComplete={() => { setTargetSetupOpen(false); home.reload(); }} />

      {/* ══════ MODALS ══════ */}
      <CustomMealModal open={customMealOpen} onClose={() => { setCustomMealOpen(false); setEditMeal(null); }} clientId={clientId} onSaved={() => { home.reload(); myMeals.reload(); foods.reload(); }} toast={(msg) => setToast(msg)} editMeal={editMeal} />
      <SavedMealsModal open={savedMealsOpen} onClose={() => setSavedMealsOpen(false)} onEdit={(m) => { setEditMeal(m); setCustomMealOpen(true); }} toast={(msg) => setToast(msg)} onRefresh={() => { home.reload(); myMeals.reload(); }} />
      <EditLogModal open={editLogOpen} log={editLog} onClose={() => { setEditLogOpen(false); setEditLog(null); }} onSave={editLogEntry} t={t} />
      <DeleteLogConfirm open={deleteLogOpen} log={deleteLog} onClose={() => { setDeleteLogOpen(false); setDeleteLog(null); }} onConfirm={deleteLogEntry} t={t} />
    </div>
  );
}
