/**
 * OnboardingWizard — premium multi-step onboarding for first-time clients.
 *
 * Collects: Name, Sex, Height, Weight, Goal, Activity Level
 * Persists via existing PUT /me/profile
 * Marks onboarding_completed = true on submit.
 *
 * Zero new dependencies — pure React + inline theme tokens.
 */
import { useState, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme } from '../themeContext.jsx';
import { api } from '../api.js';
import { useCountUp } from '../utils.js';
import ScrollWheel from './ScrollWheel.jsx';
import HeightSelector from './HeightSelector.jsx';
import WeightSelector from './WeightSelector.jsx';
import Icon from './Icon.jsx';

// Stepper's directional slide+fade, adapted from its stepVariants --
// entering forward comes from the right, back comes from the left, so
// the motion itself tells you which way you're moving through the flow.
const stepVariants = {
  enter: (dir) => ({ x: dir >= 0 ? 24 : -24, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir) => ({ x: dir >= 0 ? -24 : 24, opacity: 0 }),
};

/* ════════════════════════════════════════════════════════════════
   THEME TOKENS
   ════════════════════════════════════════════════════════════════ */
const T = {
  dark: {
    bg: 'var(--bg)', surface: 'rgba(255,255,255,0.03)', glass: 'rgba(255,255,255,0.04)',
    border: 'var(--line)', borderHover: 'rgba(255,255,255,0.14)',
    ink: 'var(--ink)', mute: 'var(--mute)', faint: 'var(--faint)',
    accent: 'var(--accent)', accentDim: 'var(--accent-soft)',
    gold: 'rgb(var(--warn-rgb))', goldDim: 'rgb(var(--warn-rgb) / .12)',
    danger: 'rgb(var(--bad-rgb))',
  },
  light: {
    // surface was rgba(0,0,0,0.03) -- a near-invisible tint over the peach
    // page background. var(--panel) matches the app's actual white .card.
    bg: 'var(--bg)', surface: 'var(--panel)', glass: 'rgba(255,255,255,0.6)',
    border: 'var(--line)', borderHover: 'rgba(0,0,0,0.16)',
    ink: 'var(--ink)', mute: 'var(--mute)', faint: 'var(--faint)',
    accent: 'var(--accent)', accentDim: 'var(--accent-soft)',
    gold: 'rgb(var(--warn-rgb))', goldDim: 'rgb(var(--warn-rgb) / .10)',
    danger: 'rgb(var(--bad-rgb))',
  },
};

/* Icons were emoji. This is the very first screen a new client sees,
   and emoji there is the fastest possible way to say "improvised": the
   artwork differs per OS, it cannot be tinted to the accent, and the
   weightlifter in particular renders as a full-colour photographic
   person on Apple platforms beside four flat monochrome shapes. These
   are names from the shared Icon set the rest of the app uses. */
const GOALS = [
  { id: 'FAT_LOSS', label: 'Fat Loss', icon: 'trending', desc: 'Reduce body fat while preserving muscle' },
  { id: 'MUSCLE_GAIN', label: 'Muscle Gain', icon: 'strength', desc: 'Build lean muscle mass' },
  { id: 'RECOMP', label: 'Recomposition', icon: 'numbers', desc: 'Simultaneously lose fat and gain muscle' },
  { id: 'STRENGTH', label: 'Strength', icon: 'target', desc: 'Increase maximal strength' },
  { id: 'GENERAL', label: 'General Fitness', icon: 'chart', desc: 'Overall health and wellness' },
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
    /* The three gender glyphs were Unicode symbols with no consistent
       rendering, and the transgender sign has patchy font coverage that
       shows a tofu box on plenty of Android builds. The labels already
       say which is which, so the tiles are label + selection state. */
    { id: 'MALE', label: 'Male' },
    { id: 'FEMALE', label: 'Female' },
    { id: 'OTHER', label: 'Other' },
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
            {o.icon && <div className="text-2xl mb-1">{o.icon}</div>}
            <div className="font-grotesk text-[11px] font-semibold">{o.label}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function StepHeight({ form, setForm, t }) {
  return (
    <div className="flex flex-col items-center text-center space-y-5">
      <div>
        <div className="font-grotesk text-lg font-bold mb-1" style={{ color: t.ink }}>HEIGHT</div>
        <div className="text-[13px]" style={{ color: t.mute }}>How tall are you?</div>
      </div>
      <HeightSelector
        value={form.height}
        onChange={(v) => setForm({ ...form, height: v })}
        t={t}
      />
    </div>
  );
}

function StepWeight({ form, setForm, t }) {
  return (
    <div className="flex flex-col items-center text-center space-y-5">
      <div>
        <div className="font-grotesk text-lg font-bold mb-1" style={{ color: t.ink }}>WEIGHT</div>
        <div className="text-[13px]" style={{ color: t.mute }}>What's your weight?</div>
      </div>
      <WeightSelector
        value={form.weight}
        onChange={(v) => setForm({ ...form, weight: v })}
        t={t}
      />
    </div>
  );
}

function StepAge({ form, setForm, t }) {
  return (
    <div className="flex flex-col items-center text-center space-y-5">
      <div>
        <div className="font-grotesk text-lg font-bold mb-1" style={{ color: t.ink }}>AGE</div>
        <div className="text-[13px]" style={{ color: t.mute }}>How old are you?</div>
      </div>
      <div className="flex flex-col items-center">
        <ScrollWheel
          value={Number(form.age) || 25}
          onChange={(v) => setForm({ ...form, age: v })}
          min={10}
          max={120}
          formatItem={(v) => `${v}`}
          style={{ background: 'transparent' }}
        />
        <div
          className="font-grotesk text-[9px] uppercase tracking-[.14em] mt-1"
          style={{ color: t.faint }}
        >
          years
        </div>
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
            <div className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name={g.icon} size={20} /></div>
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

const STEPS = ['Name', 'Sex', 'Height', 'Weight', 'Age', 'Goal', 'Experience'];

export default function OnboardingWizard({ open, onComplete, initialName = '' }) {
  const { theme } = useTheme();
  const t = T[theme] || T.dark;
  const [step, setStep] = useState(0);
  const direction = useRef(1); // 1 = forward, -1 = back; read once per step change, not reactive state
  const [form, setForm] = useState({
    name: initialName || '',
    sex: '',
    height: 170,
    weight: 70,
    age: 25,
    goal: '',
    experience: 'INTERMEDIATE',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canNext = useMemo(() => {
    if (step === 0) return form.name.trim().length >= 2;
    if (step === 1) return !!form.sex;
    if (step === 2) return Number(form.height) >= 100 && Number(form.height) <= 250;
    if (step === 3) return Number(form.weight) >= 20 && Number(form.weight) <= 400;
    if (step === 4) return Number(form.age) >= 10 && Number(form.age) <= 120;
    if (step === 5) return !!form.goal;
    if (step === 6) return !!form.experience;
    return false;
  }, [step, form]);

  const handleBack = () => { if (step > 0) { direction.current = -1; setStep(step - 1); } };

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      direction.current = 1;
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

        {/* Step content — Stepper's directional slide+fade (see
            stepVariants above), not the instant swap this had before. */}
        <div className="px-6 pb-6 min-h-[280px] overflow-visible relative">
          <AnimatePresence mode="wait" custom={direction.current} initial={false}>
            <motion.div key={step} custom={direction.current} variants={stepVariants}
              initial="enter" animate="center" exit="exit"
              transition={{ duration: 0.28, ease: [0.22, 0.8, 0.3, 1] }}>
              {step === 0 && <StepName form={form} setForm={setForm} t={t} />}
              {step === 1 && <StepSex form={form} setForm={setForm} t={t} />}
              {step === 2 && <StepHeight form={form} setForm={setForm} t={t} />}
              {step === 3 && <StepWeight form={form} setForm={setForm} t={t} />}
              {step === 4 && <StepAge form={form} setForm={setForm} t={t} />}
              {step === 5 && <StepGoal form={form} setForm={setForm} t={t} />}
              {step === 6 && <StepActivity form={form} setForm={setForm} t={t} />}
            </motion.div>
          </AnimatePresence>
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
              color: canNext && !saving ? 'var(--accent-contrast)' : t.mute,
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
