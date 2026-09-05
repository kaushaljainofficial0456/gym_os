/**
 * NutritionTargetSetup — shown when a client first reaches Nutrition
 * without an active nutrition plan. Displays calculated targets
 * and allows confirmation.
 *
 * Zero new dependencies.
 */
import { useState, useEffect, useMemo } from 'react';
import { useTheme } from '../themeContext.jsx';
import { api } from '../api.js';
import { useCountUp } from '../utils.js';
import { calculateCaloriesFromMacros } from '../nutritionCalc.js';
import { CheckIcon } from './UI.jsx';

const T = {
  dark: {
    bg: 'var(--bg)', surface: 'rgba(255,255,255,0.03)', glass: 'rgba(255,255,255,0.04)',
    border: 'var(--line)', ink: 'var(--ink)', mute: 'var(--mute)',
    faint: 'var(--faint)', accent: 'var(--accent)', accentDim: 'var(--accent-soft)',
    gold: 'rgb(var(--warn-rgb))', goldDim: 'rgb(var(--warn-rgb) / .10)', danger: 'rgb(var(--bad-rgb))',
    protein: '#FF8C42', carbs: '#FFD166', fat: '#4ECDC4',
  },
  light: {
    // surface was rgba(0,0,0,0.03) -- a near-invisible tint over the peach
    // page background. var(--panel) matches the app's actual white .card.
    bg: 'var(--bg)', surface: 'var(--panel)', glass: 'rgba(255,255,255,0.6)',
    border: 'var(--line)', ink: 'var(--ink)', mute: 'var(--mute)',
    faint: 'var(--faint)', accent: 'var(--accent)', accentDim: 'var(--accent-soft)',
    gold: 'rgb(var(--warn-rgb))', goldDim: 'rgb(var(--warn-rgb) / .10)', danger: 'rgb(var(--bad-rgb))',
    protein: '#D4623A', carbs: '#B47828', fat: '#3A8AB0',
  },
};

function AnimatedNumber({ value, t, suffix = '' }) {
  const anim = useCountUp(value, 1000);
  return <span style={{ color: t.ink }}>{anim.toLocaleString()}{suffix}</span>;
}

export default function NutritionTargetSetup({ open, onComplete }) {
  const { theme } = useTheme();
  const t = T[theme] || T.dark;
  const [targets, setTargets] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Editable values -- calories is intentionally NOT its own state. It's
  // a LIVE-DERIVED value (protein×4 + carbs×4 + fat×9, the canonical 4/4/9
  // rule -- see nutritionCalc.js) so it can never drift out of sync with
  // whatever the user actually typed into the macro fields below, which
  // is exactly the bug this used to have: calories was a fourth
  // independent number that silently stopped updating the moment any
  // macro changed, right up until it was saved as-is.
  const [protein, setProtein] = useState(0);
  const [carbs, setCarbs] = useState(0);
  const [fat, setFat] = useState(0);
  const calories = useMemo(() => calculateCaloriesFromMacros({ protein, carbs, fat }), [protein, carbs, fat]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setSaveError(null);
    setConfirmed(false);
    api('/me/nutrition/targets')
      .then((res) => {
        if (res.incomplete) {
          setError('Please complete your profile first (height, weight, age, sex).');
          return;
        }
        setTargets(res.targets);
        setProtein(res.targets.protein);
        setCarbs(res.targets.carbs);
        setFat(res.targets.fat);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open]);

  const handleConfirm = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // `calories` is never sent -- the backend derives it itself from
      // these same three numbers via the identical 4/4/9 formula, the
      // one canonical place that calculation happens server-side. Sending
      // it here would just be a value the server ignores.
      await api('/me/nutrition/targets/confirm', {
        method: 'POST',
        body: JSON.stringify({ protein, carbs, fat }),
      });
      setConfirmed(true);
      setTimeout(() => onComplete(), 1200);
    } catch (e) {
      // Separate from `error` (the initial-load failure state, which hides
      // the whole editor) -- a save failure here must leave the editor and
      // Confirm button visible so the user can see what went wrong and
      // retry, instead of the UI going silently unresponsive.
      setSaveError(e.message || 'Could not save targets');
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
          <div className="font-grotesk text-lg font-bold mt-1" style={{ color: t.ink }}>Your Daily Targets</div>
          <div className="text-[11px] mt-0.5" style={{ color: t.mute }}>Calculated from your profile and goal. You can adjust these.</div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {loading && (
            <div className="text-center py-10">
              <div className="w-8 h-8 mx-auto rounded-full border-2 animate-spin mb-3" style={{ borderColor: t.border, borderTopColor: t.accent }} />
              <div className="text-[11px]" style={{ color: t.mute }}>Calculating your targets…</div>
            </div>
          )}

          {error && !targets && (
            <div className="text-center py-8">
              <div className="text-[11px] font-grotesk px-3 py-2 rounded-xl" style={{ background: `${t.danger}10`, border: `1px solid ${t.danger}25`, color: t.danger }}>{error}</div>
            </div>
          )}

          {targets && !loading && !confirmed && (
            <div className="space-y-4">
              {/* Calories — large display */}
              <div className="text-center py-4 rounded-2xl" style={{ background: t.accentDim, border: `1px solid ${t.accent}25` }}>
                <div className="font-grotesk font-bold" style={{ fontSize: 42, color: t.accent, letterSpacing: '-0.02em' }}>
                  <AnimatedNumber value={calories} t={t} />
                </div>
                <div className="font-grotesk text-[11px] mt-1" style={{ color: t.mute }}>kcal per day</div>
              </div>

              {/* Macros — editable */}
              <div className="space-y-3">
                {[
                  { label: 'Protein', value: protein, set: setProtein, color: t.protein, unit: 'g' },
                  { label: 'Carbs', value: carbs, set: setCarbs, color: t.carbs, unit: 'g' },
                  { label: 'Fat', value: fat, set: setFat, color: t.fat, unit: 'g' },
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
                        onChange={(e) => m.set(Math.max(15, Number(e.target.value) || 0))}
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
              <div className="w-14 h-14 mx-auto rounded-full grid place-items-center text-2xl mb-3" style={{ background: t.accentDim, border: `1px solid ${t.accent}40` }}><CheckIcon /></div>
              <div className="font-grotesk font-bold" style={{ color: t.accent }}>Targets confirmed!</div>
              <div className="text-[11px] mt-1" style={{ color: t.mute }}>Redirecting to your nutrition dashboard…</div>
            </div>
          )}
        </div>

        {/* Actions */}
        {targets && !loading && !confirmed && (
          <div className="px-6 pb-6 flex gap-3">
            <button onClick={handleConfirm} disabled={saving}
              className="flex-1 py-3 rounded-xl font-grotesk text-sm font-bold transition-all active:scale-[.97]"
              style={{
                background: saving ? t.surface : t.accent,
                color: saving ? t.mute : 'var(--accent-contrast)',
                border: `1px solid ${saving ? t.border : t.accent}`,
                opacity: saving ? 0.5 : 1,
                cursor: saving ? 'not-allowed' : 'pointer',
              }}>
              {saving ? 'Saving…' : 'Confirm Targets'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
