/**
 * NutritionTargetSetup ΓÇö dual-mode component:
 *
 * 1. FIRST-TIME SETUP: shown when a client first reaches Nutrition
 *    without an active nutrition plan. Displays calculated targets
 *    and allows confirmation (POST /me/nutrition/targets/confirm).
 *
 * 2. EDIT MODE: shown when the client taps the edit icon next to
 *    their existing calorie target. Allows manual override (PUT /me/nutrition/targets)
 *    and reset to calculated values.
 *
 * Zero new dependencies.
 */
import { useState, useEffect } from 'react';
import { useTheme } from '../themeContext.jsx';
import { api } from '../api.js';
import { useCountUp } from '../utils.js';

const T = {
  dark: {
    bg: 'var(--bg)', surface: 'rgba(255,255,255,0.03)', glass: 'rgba(255,255,255,0.04)',
    border: 'var(--line)', ink: 'var(--ink)', mute: 'var(--mute)',
    faint: 'var(--faint)', accent: 'var(--accent)', accentDim: 'var(--accent-soft)',
    gold: 'rgb(var(--warn-rgb))', goldDim: 'rgb(var(--warn-rgb) / .10)', danger: 'rgb(var(--bad-rgb))',
    protein: '#FF8C42', carbs: '#FFD166', fat: '#4ECDC4',
  },
  light: {
    bg: 'var(--bg)', surface: 'var(--panel)', glass: 'rgba(255,255,255,0.6)',
    border: 'var(--line)', ink: 'var(--ink)', mute: 'var(--mute)',
    faint: 'var(--faint)', accent: 'var(--accent)', accentDim: 'var(--accent-soft)',
    gold: 'rgb(var(--warn-rgb))', goldDim: 'rgb(var(--warn-rgb) / .10)', danger: 'rgb(var(--bad-rgb))',
    protein: '#D4623A', carbs: '#B47828', fat: '#3A8AB0',
  },
};

function AnimatedNumber({ value, t }) {
  const anim = useCountUp(value, 1000);
  return <span style={{ color: t.ink }}>{anim.toLocaleString()}</span>;
}

/**
 * @param {boolean} open - whether the modal is visible
 * @param {function} onComplete - called after successful save
 * @param {object|null} currentPlan - existing plan { calories, protein, carbs, fat, name } when editing
 * @param {boolean} isEdit - true when editing an existing plan (vs first-time setup)
 */
export default function NutritionTargetSetup({ open, onComplete, currentPlan = null, isEdit = false }) {
  const { theme } = useTheme();
  const t = T[theme] || T.dark;
  const [targets, setTargets] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Editable values
  const [calories, setCalories] = useState(0);
  const [protein, setProtein] = useState(0);
  const [carbs, setCarbs] = useState(0);
  const [fat, setFat] = useState(0);

  // Track whether the current plan is manual or calculated
  const isManual = currentPlan?.name?.includes('(Manual)');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setSaveError(null);
    setConfirmed(false);

    // Always fetch calculated targets for the "Reset to calculated" feature
    api('/me/nutrition/targets')
      .then((res) => {
        if (res.incomplete) {
          setError('Please complete your profile first (height, weight, age, sex).');
          return;
        }
        setTargets(res.targets);

        // In edit mode, start with the current plan values; otherwise use calculated
        if (isEdit && currentPlan) {
          setCalories(currentPlan.calories || res.targets.calories);
          setProtein(currentPlan.protein || res.targets.protein);
          setCarbs(currentPlan.carbs || res.targets.carbs);
          setFat(currentPlan.fat || res.targets.fat);
        } else {
          setCalories(res.targets.calories);
          setProtein(res.targets.protein);
          setCarbs(res.targets.carbs);
          setFat(res.targets.fat);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open, isEdit, currentPlan?.calories]);

  const handleSave = async () => {
    // Validation
    if (!calories || calories < 500 || calories > 10000) {
      setSaveError('Please enter a valid daily calorie target (500ΓÇô10,000).');
      return;
    }
    if (!protein || protein < 20 || protein > 500) {
      setSaveError('Please enter valid protein (20ΓÇô500g).');
      return;
    }
    if (!carbs || carbs < 20 || carbs > 800) {
      setSaveError('Please enter valid carbs (20ΓÇô800g).');
      return;
    }
    if (!fat || fat < 15 || fat > 300) {
      setSaveError('Please enter valid fat (15ΓÇô300g).');
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      if (isEdit) {
        // Update existing plan ΓÇö mark as manual
        await api('/me/nutrition/targets', {
          method: 'PUT',
          body: JSON.stringify({
            calories, protein, carbs, fat,
            name: 'My Nutrition Plan (Manual)',
          }),
        });
      } else {
        // First-time setup ΓÇö create new plan
        await api('/me/nutrition/targets/confirm', {
          method: 'POST',
          body: JSON.stringify({ calories, protein, carbs, fat }),
        });
      }
      setConfirmed(true);
      setTimeout(() => onComplete(), 1200);
    } catch (e) {
      setSaveError(e.message || 'Could not save targets');
    }
    setSaving(false);
  };

  const handleReset = async () => {
    if (!targets) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Reset to calculated values ΓÇö mark as automatic
      await api('/me/nutrition/targets', {
        method: 'PUT',
        body: JSON.stringify({
          calories: targets.calories,
          protein: targets.protein,
          carbs: targets.carbs,
          fat: targets.fat,
          name: 'My Nutrition Plan',
        }),
      });
      setCalories(targets.calories);
      setProtein(targets.protein);
      setCarbs(targets.carbs);
      setFat(targets.fat);
      setConfirmed(true);
      setTimeout(() => onComplete(), 1200);
    } catch (e) {
      setSaveError(e.message || 'Could not reset targets');
    }
    setSaving(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(16px)' }}>
      <div className="w-full max-w-md rounded-3xl overflow-hidden anim-scaleIn" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>

        {/* Header */}
        <div className="px-6 pt-6 pb-2">
          <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.accent }}>Nutrition Targets</div>
          <div className="font-grotesk text-lg font-bold mt-1" style={{ color: t.ink }}>
            {isEdit ? 'Edit Daily Targets' : 'Your Daily Targets'}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: t.mute }}>
            {isEdit
              ? 'Adjust your daily calorie and macro targets.'
              : 'Calculated from your profile and goal. You can adjust these.'}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {loading && (
            <div className="text-center py-10">
              <div className="w-8 h-8 mx-auto rounded-full border-2 animate-spin mb-3" style={{ borderColor: t.border, borderTopColor: t.accent }} />
              <div className="text-[11px]" style={{ color: t.mute }}>Loading targetsΓÇª</div>
            </div>
          )}

          {error && !targets && (
            <div className="text-center py-8">
              <div className="text-[11px] font-grotesk px-3 py-2 rounded-xl" style={{ background: `${t.danger}10`, border: `1px solid ${t.danger}25`, color: t.danger }}>{error}</div>
            </div>
          )}

          {targets && !loading && !confirmed && (
            <div className="space-y-4">
              {/* Manual / Recommended badge */}
              <div className="flex justify-center">
                <span className="font-grotesk text-[9px] uppercase tracking-[.12em] px-2 py-0.5 rounded-full"
                  style={isManual
                    ? { background: `${t.gold}15`, color: t.gold, border: `1px solid ${t.gold}30` }
                    : { background: `${t.accent}10`, color: t.accent, border: `1px solid ${t.accent}20` }}>
                  {isManual ? 'Manual target' : 'Recommended'}
                </span>
              </div>

              {/* All macros ΓÇö editable including calories */}
              <div className="space-y-3">
                {[
                  { label: 'Calories', value: calories, set: setCalories, color: t.accent, unit: 'kcal', min: 500 },
                  { label: 'Protein', value: protein, set: setProtein, color: t.protein, unit: 'g', min: 15 },
                  { label: 'Carbs', value: carbs, set: setCarbs, color: t.carbs, unit: 'g', min: 15 },
                  { label: 'Fat', value: fat, set: setFat, color: t.fat, unit: 'g', min: 15 },
                ].map((m) => (
                  <div key={m.label} className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: m.color }} />
                    <div className="flex-1">
                      <div className="font-grotesk text-[11px] font-semibold" style={{ color: t.mute }}>{m.label}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        className="w-16 text-right px-2 py-1.5 rounded-lg font-grotesk text-sm font-bold outline-none"
                        style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}
                        value={m.value}
                        onChange={(e) => m.set(Math.max(m.min || 15, Number(e.target.value) || 0))}
                      />
                      <span className="font-grotesk text-[10px]" style={{ color: t.mute }}>{m.unit}</span>
                    </div>
                  </div>
                ))}
              </div>

              {saveError && (
                <div className="text-[11px] font-grotesk px-3 py-2 rounded-xl anim-fadeIn" style={{ background: `${t.danger}10`, border: `1px solid ${t.danger}25`, color: t.danger }}>
                  {saveError}
                </div>
              )}
            </div>
          )}

          {confirmed && (
            <div className="text-center py-8">
              <div className="w-14 h-14 mx-auto rounded-full grid place-items-center text-2xl mb-3" style={{ background: t.accentDim, border: `1px solid ${t.accent}40` }}>Γ£ô</div>
              <div className="font-grotesk font-bold" style={{ color: t.accent }}>Targets saved!</div>
              <div className="text-[11px] mt-1" style={{ color: t.mute }}>Redirecting to your nutrition dashboardΓÇª</div>
            </div>
          )}
        </div>

        {/* Actions */}
        {targets && !loading && !confirmed && (
          <div className="px-6 pb-6 space-y-2">
            <button onClick={handleSave} disabled={saving}
              className="w-full py-3 rounded-xl font-grotesk text-sm font-bold transition-all active:scale-[.97]"
              style={{
                background: saving ? t.surface : t.accent,
                color: saving ? t.mute : 'var(--accent-contrast)',
                border: `1px solid ${saving ? t.border : t.accent}`,
                opacity: saving ? 0.5 : 1,
                cursor: saving ? 'not-allowed' : 'pointer',
              }}>
              {saving ? 'SavingΓÇª' : isEdit ? 'Save Changes' : 'Confirm Targets'}
            </button>

            {/* Reset to calculated ΓÇö only shown in edit mode when plan is manual */}
            {isEdit && isManual && (
              <button onClick={handleReset} disabled={saving}
                className="w-full py-2.5 rounded-xl font-grotesk text-xs font-semibold transition-all active:scale-[.97]"
                style={{
                  background: 'transparent',
                  color: t.mute,
                  border: `1px solid ${t.border}`,
                }}>
                Reset to calculated
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
