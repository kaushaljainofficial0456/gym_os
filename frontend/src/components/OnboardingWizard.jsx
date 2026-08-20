/**
 * OnboardingWizard — premium multi-step onboarding for first-time clients.
 *
 * Collects: Name, Sex, Height, Weight, Goal, Activity Level
 * Persists via existing PUT /me/profile
 * Marks onboarding_completed = true on submit.
 *
 * Zero new dependencies — pure React + inline theme tokens.
 */
import { useState, useMemo } from 'react';
import { useTheme } from '../themeContext.jsx';
import { api } from '../api.js';
import { useCountUp } from '../utils.js';

/* ════════════════════════════════════════════════════════════════
   THEME TOKENS
   ════════════════════════════════════════════════════════════════ */
const T = {
  dark: {
    bg: '#080B12', surface: 'rgba(255,255,255,0.03)', glass: 'rgba(255,255,255,0.04)',
    border: 'rgba(255,255,255,0.07)', borderHover: 'rgba(255,255,255,0.14)',
    ink: '#EDEFF7', mute: 'rgba(255,255,255,0.42)', faint: 'rgba(255,255,255,0.22)',
    accent: '#12B8B0', accentDim: 'rgba(18,184,176,0.15)',
    gold: '#FFC43D', goldDim: 'rgba(255,196,61,0.12)',
    danger: '#FF6B6B',
  },
  light: {
    bg: '#F5F0EB', surface: 'rgba(61,48,38,0.03)', glass: 'rgba(255,255,255,0.6)',
    border: 'rgba(61,48,38,0.08)', borderHover: 'rgba(61,48,38,0.16)',
    ink: '#3D3026', mute: 'rgba(61,48,38,0.45)', faint: 'rgba(61,48,38,0.25)',
    accent: '#8C6A4D', accentDim: 'rgba(140,106,77,0.12)',
    gold: '#B47828', goldDim: 'rgba(180,120,40,0.10)',
    danger: '#D44',
  },
};

const GOALS = [
  { id: 'FAT_LOSS', label: 'Fat Loss', icon: '🔥', desc: 'Reduce body fat while preserving muscle' },
  { id: 'MUSCLE_GAIN', label: 'Muscle Gain', icon: '💪', desc: 'Build lean muscle mass' },
  { id: 'RECOMP', label: 'Recomposition', icon: '⚖️', desc: 'Simultaneously lose fat and gain muscle' },
  { id: 'STRENGTH', label: 'Strength', icon: '🏋️', desc: 'Increase maximal strength' },
  { id: 'GENERAL', label: 'General Fitness', icon: '🏃', desc: 'Overall health and wellness' },
];

const ACTIVITY = [
  { id: 'BEGINNER', label: 'Beginner', desc: 'New to training or < 6 months' },
  { id: 'INTERMEDIATE', label: 'Intermediate', desc: '6-24 months of consistent training' },
  { id: 'ADVANCED', label: 'Advanced', desc: '2+ years of serious training' },
];

/* ════════════════════════════════════════════════════════════════
   STEP COMPONENTS
   ════════════════════════════════════════════════════════════════ */

function StepIndicator({ current, total, t }) {
  return (
    <div className="flex items-center gap-1.5 mb-6">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex-1 h-1 rounded-full transition-all duration-500" style={{
          background: i <= current ? t.accent : t.border,
          boxShadow: i === current ? `0 0 8px ${t.accent}40` : 'none',
        }} />
      ))}
    </div>
  );
}

function StepName({ form, setForm, t }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="font-grotesk text-lg font-bold mb-1" style={{ color: t.ink }}>What's your name?</div>
        <div className="text-[11px]" style={{ color: t.mute }}>We'll use this to personalize your experience.</div>
      </div>
      <input
        className="w-full px-4 py-3 rounded-xl font-grotesk text-sm outline-none transition-colors"
        placeholder="Enter your full name"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        autoFocus
        style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}
      />
    </div>
  );
}

function StepSex({ form, setForm, t }) {
  const options = [
    { id: 'MALE', label: 'Male', icon: '♂' },
    { id: 'FEMALE', label: 'Female', icon: '♀' },
    { id: 'OTHER', label: 'Other', icon: '⚧' },
  ];
  return (
    <div className="space-y-4">
      <div>
        <div className="font-grotesk text-lg font-bold mb-1" style={{ color: t.ink }}>What's your sex?</div>
        <div className="text-[11px]" style={{ color: t.mute }}>Used for accurate calorie calculations.</div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {options.map((o) => (
          <button key={o.id} onClick={() => setForm({ ...form, sex: o.id })}
            className="p-4 rounded-xl text-center transition-all active:scale-95"
            style={{
              background: form.sex === o.id ? t.accentDim : t.glass,
              border: `1px solid ${form.sex === o.id ? t.accent + '50' : t.border}`,
              color: form.sex === o.id ? t.accent : t.ink,
              boxShadow: form.sex === o.id ? `0 0 15px ${t.accent}15` : 'none',
            }}>
            <div className="text-2xl mb-1">{o.icon}</div>
            <div className="font-grotesk text-[11px] font-semibold">{o.label}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function StepBody({ form, setForm, t }) {
  const errors = {};
  if (form.height && (Number(form.height) < 100 || Number(form.height) > 250)) errors.height = 'Height must be 100-250 cm';
  if (form.weight && (Number(form.weight) < 20 || Number(form.weight) > 400)) errors.weight = 'Weight must be 20-400 kg';

  return (
    <div className="space-y-4">
      <div>
        <div className="font-grotesk text-lg font-bold mb-1" style={{ color: t.ink }}>Your measurements</div>
        <div className="text-[11px]" style={{ color: t.mute }}>Used to calculate your daily nutrition targets.</div>
      </div>

      {/* Height */}
      <div>
        <label className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-1.5 block" style={{ color: t.mute }}>Height (cm)</label>
        <input
          className="w-full px-4 py-3 rounded-xl font-grotesk text-sm outline-none transition-colors"
          type="number"
          placeholder="e.g. 175"
          value={form.height}
          onChange={(e) => setForm({ ...form, height: e.target.value })}
          style={{ background: t.glass, border: `1px solid ${errors.height ? t.danger + '50' : t.border}`, color: t.ink }}
        />
        {errors.height && <div className="text-[10px] mt-1" style={{ color: t.danger }}>{errors.height}</div>}
      </div>

      {/* Weight */}
      <div>
        <label className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-1.5 block" style={{ color: t.mute }}>Weight (kg)</label>
        <input
          className="w-full px-4 py-3 rounded-xl font-grotesk text-sm outline-none transition-colors"
          type="number"
          placeholder="e.g. 75"
          value={form.weight}
          onChange={(e) => setForm({ ...form, weight: e.target.value })}
          style={{ background: t.glass, border: `1px solid ${errors.weight ? t.danger + '50' : t.border}`, color: t.ink }}
        />
        {errors.weight && <div className="text-[10px] mt-1" style={{ color: t.danger }}>{errors.weight}</div>}
      </div>

      {/* Age */}
      <div>
        <label className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-1.5 block" style={{ color: t.mute }}>Age</label>
        <input
          className="w-full px-4 py-3 rounded-xl font-grotesk text-sm outline-none transition-colors"
          type="number"
          placeholder="e.g. 25"
          value={form.age}
          onChange={(e) => setForm({ ...form, age: e.target.value })}
          style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.ink }}
        />
      </div>
    </div>
  );
}

function StepGoal({ form, setForm, t }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="font-grotesk text-lg font-bold mb-1" style={{ color: t.ink }}>What's your goal?</div>
        <div className="text-[11px]" style={{ color: t.mute }}>This shapes your nutrition and training plan.</div>
      </div>
      <div className="space-y-2">
        {GOALS.map((g) => (
          <button key={g.id} onClick={() => setForm({ ...form, goal: g.id })}
            className="w-full flex items-center gap-3 p-3.5 rounded-xl text-left transition-all active:scale-[.98]"
            style={{
              background: form.goal === g.id ? t.accentDim : t.glass,
              border: `1px solid ${form.goal === g.id ? t.accent + '50' : t.border}`,
              color: form.goal === g.id ? t.accent : t.ink,
            }}>
            <div className="text-xl shrink-0">{g.icon}</div>
            <div className="min-w-0">
              <div className="font-grotesk text-sm font-bold">{g.label}</div>
              <div className="text-[10px]" style={{ color: form.goal === g.id ? t.accent + 'AA' : t.mute }}>{g.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function StepActivity({ form, setForm, t }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="font-grotesk text-lg font-bold mb-1" style={{ color: t.ink }}>Training experience</div>
        <div className="text-[11px]" style={{ color: t.mute }}>This adjusts your activity multiplier for calorie calculations.</div>
      </div>
      <div className="space-y-2">
        {ACTIVITY.map((a) => (
          <button key={a.id} onClick={() => setForm({ ...form, experience: a.id })}
            className="w-full flex items-center gap-3 p-3.5 rounded-xl text-left transition-all active:scale-[.98]"
            style={{
              background: form.experience === a.id ? t.accentDim : t.glass,
              border: `1px solid ${form.experience === a.id ? t.accent + '50' : t.border}`,
              color: form.experience === a.id ? t.accent : t.ink,
            }}>
            <div className="min-w-0">
              <div className="font-grotesk text-sm font-bold">{a.label}</div>
              <div className="text-[10px]" style={{ color: form.experience === a.id ? t.accent + 'AA' : t.mute }}>{a.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   MAIN WIZARD
   ════════════════════════════════════════════════════════════════ */

const STEPS = ['Name', 'Sex', 'Body', 'Goal', 'Experience'];

export default function OnboardingWizard({ open, onComplete, initialName = '' }) {
  const { theme } = useTheme();
  const t = T[theme] || T.dark;
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: initialName || '',
    sex: '',
    height: '',
    weight: '',
    age: '',
    goal: '',
    experience: 'INTERMEDIATE',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canNext = useMemo(() => {
    if (step === 0) return form.name.trim().length >= 2;
    if (step === 1) return !!form.sex;
    if (step === 2) return Number(form.height) >= 100 && Number(form.height) <= 250 && Number(form.weight) >= 20 && Number(form.weight) <= 400 && Number(form.age) >= 10 && Number(form.age) <= 120;
    if (step === 3) return !!form.goal;
    if (step === 4) return !!form.experience;
    return false;
  }, [step, form]);

  const handleBack = () => { if (step > 0) setStep(step - 1); };

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      setError('');
    } else {
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    if (!canNext) return;
    setSaving(true);
    setError('');
    try {
      await api('/me/profile', {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name.trim(),
          sex: form.sex,
          height_cm: Number(form.height),
          current_weight: Number(form.weight),
          age: Number(form.age),
          goal: form.goal,
          experience: form.experience,
          onboarding_completed: true,
        }),
      });
      onComplete();
    } catch (e) {
      setError(e.message || 'Could not save profile');
    }
    setSaving(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(16px)' }}>
      <div className="w-full max-w-md rounded-3xl overflow-hidden anim-scaleIn" style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>

        {/* Progress */}
        <div className="px-6 pt-6">
          <StepIndicator current={step} total={STEPS.length} t={t} />
          <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-4" style={{ color: t.mute }}>
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </div>
        </div>

        {/* Step content */}
        <div className="px-6 pb-6 min-h-[280px]">
          {step === 0 && <StepName form={form} setForm={setForm} t={t} />}
          {step === 1 && <StepSex form={form} setForm={setForm} t={t} />}
          {step === 2 && <StepBody form={form} setForm={setForm} t={t} />}
          {step === 3 && <StepGoal form={form} setForm={setForm} t={t} />}
          {step === 4 && <StepActivity form={form} setForm={setForm} t={t} />}
        </div>

        {/* Error */}
        {error && (
          <div className="px-6 -mt-2 mb-2">
            <div className="text-[11px] font-grotesk px-3 py-2 rounded-xl" style={{ background: `${t.danger}10`, border: `1px solid ${t.danger}25`, color: t.danger }}>{error}</div>
          </div>
        )}

        {/* Actions */}
        <div className="px-6 pb-6 flex gap-3">
          {step > 0 && (
            <button onClick={handleBack} className="px-4 py-3 rounded-xl font-grotesk text-xs font-semibold transition-all active:scale-95"
              style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.mute }}>
              Back
            </button>
          )}
          <button onClick={handleNext} disabled={!canNext || saving}
            className="flex-1 py-3 rounded-xl font-grotesk text-sm font-bold transition-all active:scale-[.97]"
            style={{
              background: canNext && !saving ? t.accent : t.surface,
              color: canNext && !saving ? '#fff' : t.mute,
              border: `1px solid ${canNext && !saving ? t.accent : t.border}`,
              opacity: canNext && !saving ? 1 : 0.5,
              cursor: canNext && !saving ? 'pointer' : 'not-allowed',
            }}>
            {saving ? 'Saving…' : step === STEPS.length - 1 ? 'Continue to Nutrition →' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
