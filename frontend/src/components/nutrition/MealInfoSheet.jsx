import { useState } from 'react';
import { useCountUp } from '../../utils.js';

/**
 * INFORMATION ABOUT MY MEALS — today's eaten meals, tap the eye icon on
 * one for a goal-aware nutrition analysis. Uses the client's EXISTING
 * goal (clients.goal, already surfaced on data.client.goal) and EXISTING
 * plan targets -- no new goal system, no new targets, just framing the
 * same numbers differently depending on what the client is actually
 * working toward. Never moralizing language ("good food" / "bad food"):
 * every line states a measured relationship to the target.
 */
function goalInsights(meal, plan, goal) {
  if (!plan || !plan.calories) return [];
  const calShare = meal.calories / plan.calories;
  const proShare = plan.protein > 0 ? meal.protein / plan.protein : 0;
  const fatShare = plan.fat > 0 ? meal.fat / plan.fat : 0;
  const lines = [];

  const g = String(goal || 'GENERAL').toUpperCase();
  if (g === 'FAT_LOSS') {
    if (calShare > 0.35) lines.push({ tone: 'warn', text: 'High calorie relative to your remaining daily target.' });
    else if (calShare < 0.15) lines.push({ tone: 'good', text: 'Light calorie contribution — leaves room later today.' });
    if (proShare < 0.15) lines.push({ tone: 'warn', text: "Protein contribution is relatively low for today's target." });
    else if (proShare > 0.3) lines.push({ tone: 'good', text: 'Strong protein contribution — helps preserve muscle in a deficit.' });
    if (fatShare > 0.4) lines.push({ tone: 'warn', text: 'Notable share of today\'s fat allowance in one meal.' });
  } else if (g === 'MUSCLE_GAIN' || g === 'STRENGTH') {
    if (calShare > 0.25) lines.push({ tone: 'good', text: "Strong calorie contribution toward today's target." });
    if (proShare > 0.2) lines.push({ tone: 'good', text: 'Good protein contribution for muscle-building targets.' });
    else if (proShare < 0.1) lines.push({ tone: 'warn', text: 'Protein contribution is modest relative to today\'s target.' });
    if (calShare < 0.1) lines.push({ tone: 'warn', text: 'Small calorie contribution — you may need more volume today.' });
  } else if (g === 'RECOMP') {
    if (proShare > 0.2) lines.push({ tone: 'good', text: 'Good protein contribution, useful for recomposition goals.' });
    if (calShare > 0.3) lines.push({ tone: 'warn', text: "Meaningful share of today's calorie target in one meal." });
  }
  // Every goal falls back to the same factual, non-judgemental percentage
  // lines when nothing above crossed a threshold worth flagging (or for
  // GENERAL, where there's no goal-specific framing at all) -- a target
  // genuinely being set must never read as "no target set" just because
  // this particular meal didn't trip a specific goal-aware condition.
  if (lines.length === 0) {
    lines.push({ tone: 'neutral', text: `${Math.round(calShare * 100)}% of today's calorie target.` });
    if (plan.protein) lines.push({ tone: 'neutral', text: `${Math.round(proShare * 100)}% of today's protein target.` });
  }
  return lines.slice(0, 3);
}

function AnalysisCard({ meal, plan, goal, t }) {
  const animCal = useCountUp(Math.round(meal.calories || 0), 500);
  const insights = goalInsights(meal, plan, goal);
  const toneColor = { good: t.fat, warn: t.carbs, neutral: t.mute };

  return (
    <div className="rounded-2xl p-4 anim-fadeUp" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
      <div className="font-grotesk text-sm font-bold mb-2" style={{ color: t.ink }}>{meal.name}</div>
      <div className="grid grid-cols-4 gap-2 text-center mb-3">
        {[['Cal', animCal, 'kcal'], ['Protein', r1(meal.protein), 'g'], ['Carbs', r1(meal.carbs), 'g'], ['Fat', r1(meal.fat), 'g']].map(([label, val, unit]) => (
          <div key={label}>
            <div className="font-grotesk text-[9px] uppercase tracking-wider" style={{ color: t.faint }}>{label}</div>
            <div className="font-grotesk text-sm font-bold tabular-nums" style={{ color: t.ink }}>{val}<span className="text-[9px] font-normal" style={{ color: t.faint }}>{unit}</span></div>
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        {insights.map((ins, i) => (
          <div key={i} className="flex items-start gap-2 anim-fadeIn" style={{ animationDelay: `${i * 90}ms` }}>
            <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: toneColor[ins.tone] || t.mute }} />
            <span className="font-grotesk text-[11px] leading-relaxed" style={{ color: t.mute }}>{ins.text}</span>
          </div>
        ))}
        {insights.length === 0 && <div className="font-grotesk text-[11px]" style={{ color: t.faint }}>No target set — assign a nutrition plan to see goal-aware analysis.</div>}
      </div>
    </div>
  );
}

const r1 = (n) => Math.round((n || 0) * 10) / 10;

export default function MealInfoSheet({ open, onClose, meals, plan, goal, t }) {
  const [openId, setOpenId] = useState(null);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center anim-fadeIn"
         style={{ background: 'rgb(var(--bg-rgb) / .72)', backdropFilter: 'blur(4px)' }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full sm:max-w-md max-h-[85vh] overflow-y-auto rounded-b-none sm:rounded-2xl anim-scaleIn">
        <div className="sticky top-0 z-10 px-4 pt-4 pb-3 flex items-center justify-between" style={{ background: 'var(--panel)' }}>
          <div className="text-[11px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Information About My Meals</div>
          <button onClick={onClose} aria-label="Close" style={{ color: 'var(--mute)' }}>✕</button>
        </div>
        <div className="px-4 pb-5 space-y-2">
          {meals.length === 0 && <div className="text-center py-6 font-grotesk text-[12px]" style={{ color: t.mute }}>No meals logged today yet</div>}
          {meals.map((m) => (
            <div key={m.id}>
              <button onClick={() => setOpenId(openId === m.id ? null : m.id)}
                      className="w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition-colors"
                      style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                <span className="min-w-0 flex-1">
                  <span className="block font-grotesk text-sm font-semibold truncate" style={{ color: t.ink }}>{m.name}</span>
                  <span className="block font-grotesk text-[10px]" style={{ color: t.faint }}>{Math.round(m.calories)} kcal</span>
                </span>
                <span className="shrink-0 text-base" style={{ color: openId === m.id ? t.accent : t.mute }}>👁</span>
              </button>
              {openId === m.id && <div className="mt-1.5"><AnalysisCard meal={m} plan={plan} goal={goal} t={t} /></div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
