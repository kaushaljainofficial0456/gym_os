/**
 * OnboardingWizard — the first two minutes of SK OS.
 *
 * WHAT THIS REDESIGN CHANGES, and why each one was actually a problem:
 *
 *  - IT OPENED COLD. The first thing a brand-new user saw was "What's
 *    your name?" with no indication of what this is, how long it takes,
 *    or what they get for answering. A welcome step now frames it, and
 *    says plainly that the numbers are used to compute their targets.
 *
 *  - THE DEAD SPACE. The content area was pinned to min-h-[280px], so the
 *    single-field Name step rendered one input floating in a tall empty
 *    box with the button stranded at the bottom. The area now sizes to
 *    its content with a much smaller floor, and the frame is a flex
 *    column so short steps look composed rather than unfinished.
 *
 *  - DOUBLED PROGRESS. A bar-per-step AND a "Step 3 of 7 · Height" line
 *    said the same thing twice. One treatment now: the bar carries
 *    position, the label names the step.
 *
 *  - INCONSISTENT STEPS. Name/Sex/Goal/Experience asked a question and
 *    explained why; Height/Weight/Age shouted an uppercase noun instead.
 *    Every step now uses the same header: the question, then one honest
 *    line about why it is being asked.
 *
 *  - NO KEYBOARD. Typing a name and pressing Enter did nothing. Enter now
 *    advances whenever the step is satisfied.
 *
 *  - NO CONFIRMATION. It committed straight from the last question. A
 *    review step now shows everything captured, with each answer tappable
 *    to jump back and change it.
 *
 * The data contract is untouched: same seven fields, same single
 * PUT /me/profile. Nothing here computes a target or a calorie figure --
 * that is the backend's job, and guessing one on this screen just to look
 * clever would be a second source of truth for the number the whole app
 * is built on.
 */
import { useState, useMemo, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme } from '../themeContext.jsx';
import { api } from '../api.js';
import ScrollWheel from './ScrollWheel.jsx';
import HeightSelector from './HeightSelector.jsx';
import WeightSelector from './WeightSelector.jsx';
import Icon from './Icon.jsx';

const stepVariants = {
  enter: (dir) => ({ x: dir >= 0 ? 22 : -22, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir) => ({ x: dir >= 0 ? -22 : 22, opacity: 0 }),
};

const T = {
  dark: {
    bg: 'var(--bg)', surface: 'rgba(255,255,255,0.03)', glass: 'rgba(255,255,255,0.04)',
    border: 'var(--line)', ink: 'var(--ink)', mute: 'var(--mute)', faint: 'var(--faint)',
    accent: 'var(--accent)', accentDim: 'var(--accent-soft)', danger: 'rgb(var(--bad-rgb))',
  },
  light: {
    bg: 'var(--bg)', surface: 'var(--panel)', glass: 'var(--panel)',
    border: 'var(--line)', ink: 'var(--ink)', mute: 'var(--mute)', faint: 'var(--faint)',
    accent: 'var(--accent)', accentDim: 'var(--accent-soft)', danger: 'rgb(var(--bad-rgb))',
  },
};

const GOALS = [
  { id: 'FAT_LOSS', label: 'Fat Loss', icon: 'trending', desc: 'Reduce body fat while keeping muscle' },
  { id: 'MUSCLE_GAIN', label: 'Muscle Gain', icon: 'strength', desc: 'Build lean muscle mass' },
  { id: 'RECOMP', label: 'Recomposition', icon: 'numbers', desc: 'Lose fat and gain muscle together' },
  { id: 'STRENGTH', label: 'Strength', icon: 'target', desc: 'Increase maximal strength' },
  { id: 'GENERAL', label: 'General Fitness', icon: 'chart', desc: 'Overall health and wellness' },
];

const ACTIVITY = [
  { id: 'BEGINNER', label: 'Beginner', desc: 'New to training, or under 6 months' },
  { id: 'INTERMEDIATE', label: 'Intermediate', desc: '6-24 months training consistently' },
  { id: 'ADVANCED', label: 'Advanced', desc: '2+ years of serious training' },
];

/* ════════════ shared step chrome ════════════ */

/** One header shape for every step: the question, then why it is asked.
 *  "Why" is never a sales line -- it says what the number is used for,
 *  because being asked for your weight deserves a real answer. */
function StepHead({ title, why, t }) {
  return (
    <div className="mb-5">
      <h2 className="font-grotesk font-bold leading-snug" style={{ fontSize: 21, color: t.ink }}>
        {title}
      </h2>
      {why && (
        <p className="text-[12px] mt-1.5 leading-relaxed" style={{ color: t.mute }}>{why}</p>
      )}
    </div>
  );
}

/** Selection tile. Carries a check mark as well as colour, so the choice
 *  is not communicated by hue alone. */
function Choice({ selected, onClick, children, t, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`w-full text-left rounded-2xl transition-all active:scale-[.98] ${className}`}
      style={{
        minHeight: 56,
        background: selected ? t.accentDim : t.glass,
        border: `1.5px solid ${selected ? t.accent : t.border}`,
        color: t.ink,
      }}
    >
      {children}
    </button>
  );
}

function Check({ on, t }) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 grid place-items-center rounded-full"
      style={{
        width: 20, height: 20,
        border: `1.5px solid ${on ? t.accent : t.border}`,
        background: on ? t.accent : 'transparent',
      }}
    >
      {on && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent-contrast)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )}
    </span>
  );
}

/* ════════════ steps ════════════ */

function StepWelcome({ t, name }) {
  return (
    <div className="text-center py-2">
      <div
        className="mx-auto grid place-items-center rounded-2xl mb-4"
        style={{ width: 56, height: 56, background: t.accentDim, border: `1px solid ${t.accent}` }}
      >
        <Icon name="strength" size={26} />
      </div>
      <h2 className="font-grotesk font-black leading-tight" style={{ fontSize: 24, color: t.ink }}>
        {name ? `Welcome, ${name.split(' ')[0]}` : 'Welcome to Barbell'}
      </h2>
      <p className="text-[13px] mt-2.5 leading-relaxed" style={{ color: t.mute }}>
        Six quick questions so your training and nutrition targets are built around
        you rather than an average. It takes about a minute.
      </p>
      <ul className="mt-5 space-y-2 text-left">
        {[
          ['Calorie and macro targets', 'calculated from your own body and goal'],
          ['A plan that fits your level', 'not a generic beginner template'],
          ['Progress measured against you', 'your starting point, not someone else’s'],
        ].map(([h, s]) => (
          <li key={h} className="flex items-start gap-2.5">
            <span className="mt-1.5 shrink-0 rounded-full" style={{ width: 5, height: 5, background: t.accent }} />
            <span>
              <span className="text-[12.5px] font-semibold" style={{ color: t.ink }}>{h}</span>
              <span className="text-[12px]" style={{ color: t.mute }}> — {s}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] mt-5" style={{ color: t.faint }}>
        You can change any of this later in your profile.
      </p>
    </div>
  );
}

function StepName({ form, setForm, t }) {
  return (
    <div>
      <StepHead t={t} title="What should we call you?" why="Used across the app and shown to your coach." />
      <input
        className="w-full px-4 rounded-2xl font-grotesk outline-none transition-colors"
        style={{
          minHeight: 52, fontSize: 16,
          background: t.glass, border: `1.5px solid ${t.border}`, color: t.ink,
        }}
        placeholder="Your full name"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        autoFocus
        autoComplete="name"
        aria-label="Your full name"
      />
    </div>
  );
}

function StepSex({ form, setForm, t }) {
  const options = [{ id: 'MALE', label: 'Male' }, { id: 'FEMALE', label: 'Female' }, { id: 'OTHER', label: 'Other' }];
  return (
    <div>
      <StepHead
        t={t}
        title="What's your sex?"
        why="Energy expenditure formulas differ, so this changes your calorie target."
      />
      <div className="grid grid-cols-3 gap-2">
        {options.map((o) => (
          <Choice key={o.id} t={t} selected={form.sex === o.id} onClick={() => setForm({ ...form, sex: o.id })}>
            <div className="px-2 py-3 flex flex-col items-center gap-2">
              <Check on={form.sex === o.id} t={t} />
              <span className="font-grotesk text-[12px] font-semibold">{o.label}</span>
            </div>
          </Choice>
        ))}
      </div>
    </div>
  );
}

function StepHeight({ form, setForm, t }) {
  return (
    <div>
      <StepHead t={t} title="How tall are you?" why="Part of the body-composition baseline your targets start from." />
      <div className="flex justify-center">
        <HeightSelector value={form.height} onChange={(v) => setForm({ ...form, height: v })} t={t} />
      </div>
    </div>
  );
}

function StepWeight({ form, setForm, t }) {
  return (
    <div>
      <StepHead t={t} title="What do you weigh?" why="Your starting point. Log it again whenever you like — nothing here is fixed." />
      <div className="flex justify-center">
        <WeightSelector value={form.weight} onChange={(v) => setForm({ ...form, weight: v })} t={t} />
      </div>
    </div>
  );
}

function StepAge({ form, setForm, t }) {
  return (
    <div>
      <StepHead t={t} title="How old are you?" why="Metabolic rate shifts with age, so it affects your daily target." />
      <div className="flex flex-col items-center">
        <ScrollWheel
          value={Number(form.age) || 25}
          onChange={(v) => setForm({ ...form, age: v })}
          min={10}
          max={120}
          label="Your age in years"
          style={{ background: 'transparent' }}
        />
        <div className="font-grotesk text-[10px] uppercase tracking-[.14em] mt-1" style={{ color: t.faint }}>
          years
        </div>
      </div>
    </div>
  );
}

function StepGoal({ form, setForm, t }) {
  return (
    <div>
      <StepHead t={t} title="What are you training for?" why="Sets the direction of your calorie target and your programme." />
      <div className="space-y-2">
        {GOALS.map((g) => (
          <Choice key={g.id} t={t} selected={form.goal === g.id} onClick={() => setForm({ ...form, goal: g.id })}>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="shrink-0" style={{ color: t.accent }}><Icon name={g.icon} size={20} /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-grotesk text-[13.5px] font-bold">{g.label}</span>
                <span className="block text-[11px] mt-0.5" style={{ color: t.mute }}>{g.desc}</span>
              </span>
              <Check on={form.goal === g.id} t={t} />
            </div>
          </Choice>
        ))}
      </div>
    </div>
  );
}

function StepActivity({ form, setForm, t }) {
  return (
    <div>
      <StepHead t={t} title="How much training have you done?" why="Sets your starting volume so week one is neither trivial nor punishing." />
      <div className="space-y-2">
        {ACTIVITY.map((a) => (
          <Choice key={a.id} t={t} selected={form.experience === a.id} onClick={() => setForm({ ...form, experience: a.id })}>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="min-w-0 flex-1">
                <span className="block font-grotesk text-[13.5px] font-bold">{a.label}</span>
                <span className="block text-[11px] mt-0.5" style={{ color: t.mute }}>{a.desc}</span>
              </span>
              <Check on={form.experience === a.id} t={t} />
            </div>
          </Choice>
        ))}
      </div>
    </div>
  );
}

/** Review. Every row jumps back to its own step, so correcting a typo
 *  does not mean restarting. Deliberately shows only what was entered --
 *  it does NOT preview a calorie target, because this screen has no
 *  business computing the number the backend owns. */
function StepReview({ form, t, goTo }) {
  const goal = GOALS.find((g) => g.id === form.goal);
  const exp = ACTIVITY.find((a) => a.id === form.experience);
  const sexLabel = { MALE: 'Male', FEMALE: 'Female', OTHER: 'Other' }[form.sex] || '—';
  const rows = [
    ['Name', form.name, 1],
    ['Sex', sexLabel, 2],
    ['Height', `${form.height} cm`, 3],
    ['Weight', `${form.weight} kg`, 4],
    ['Age', `${form.age}`, 5],
    ['Goal', goal?.label || '—', 6],
    ['Experience', exp?.label || '—', 7],
  ];
  return (
    <div>
      <StepHead t={t} title="Does this look right?" why="Tap anything to change it. You can also edit all of it later in your profile." />
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${t.border}` }}>
        {rows.map(([label, val, stepIdx], i) => (
          <button
            key={label}
            type="button"
            onClick={() => goTo(stepIdx)}
            className="w-full flex items-center justify-between gap-3 px-3.5 text-left transition-colors"
            style={{
              minHeight: 46,
              background: t.glass,
              borderTop: i === 0 ? 'none' : `1px solid ${t.border}`,
            }}
          >
            <span className="text-[11.5px]" style={{ color: t.mute }}>{label}</span>
            <span className="text-[12.5px] font-semibold truncate" style={{ color: t.ink }}>{val}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ════════════ wizard ════════════ */

const STEPS = ['Welcome', 'Name', 'Sex', 'Height', 'Weight', 'Age', 'Goal', 'Experience', 'Review'];

export default function OnboardingWizard({ open, onComplete, initialName = '' }) {
  // `resolved` (never the raw choice): 'system' is now a storable
  // value, and every comparison below is against light/dark.
  const { resolved: theme } = useTheme();
  const t = T[theme] || T.dark;
  const [step, setStep] = useState(0);
  const direction = useRef(1);
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
    switch (step) {
      case 0: return true;                       // welcome
      case 1: return form.name.trim().length >= 2;
      case 2: return !!form.sex;
      case 3: return Number(form.height) >= 100 && Number(form.height) <= 250;
      case 4: return Number(form.weight) >= 20 && Number(form.weight) <= 400;
      case 5: return Number(form.age) >= 10 && Number(form.age) <= 120;
      case 6: return !!form.goal;
      case 7: return !!form.experience;
      case 8: return true;                       // review
      default: return false;
    }
  }, [step, form]);

  const goTo = (i) => { direction.current = i > step ? 1 : -1; setStep(i); setError(''); };
  const handleBack = () => { if (step > 0) goTo(step - 1); };

  const handleNext = () => {
    if (!canNext) return;
    if (step < STEPS.length - 1) goTo(step + 1);
    else handleSubmit();
  };

  const handleSubmit = async () => {
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
      setError(e.message || 'Could not save your profile');
    }
    setSaving(false);
  };

  /* Enter advances. Typing a name and pressing Enter previously did
     nothing at all, which is the single most common way to move through
     a form. Ignored on the wheels, where Enter has no meaning and the
     arrow keys do the work. */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Enter') return;
      if (e.target?.getAttribute?.('role') === 'listbox') return;
      if (canNext && !saving) { e.preventDefault(); handleNext(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, canNext, saving, step]);

  if (!open) return null;

  const isWelcome = step === 0;
  const isReview = step === STEPS.length - 1;
  // The welcome screen is not a question, so it is not counted in the
  // progress the user is asked to get through.
  const questionIndex = Math.max(0, step - 1);
  const questionCount = STEPS.length - 2;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn"
      style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(14px)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Set up your profile"
    >
      <div
        className="w-full max-w-md rounded-3xl overflow-hidden anim-scaleIn flex flex-col"
        style={{
          background: t.bg,
          border: `1px solid ${t.border}`,
          boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
          maxHeight: 'min(92vh, 760px)',
        }}
      >
        {/* One progress treatment, not two. Hidden on the welcome screen,
            which is not something to get through. */}
        {!isWelcome && (
          <div className="px-6 pt-5 shrink-0">
            <div className="flex items-center gap-1" aria-hidden="true">
              {Array.from({ length: questionCount }).map((_, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-full transition-all duration-500"
                  style={{ height: 3, background: i <= questionIndex ? t.accent : t.border }}
                />
              ))}
            </div>
            <div
              className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mt-2.5"
              style={{ color: t.faint }}
            >
              {isReview ? 'Review' : `${questionIndex + 1} of ${questionCount} · ${STEPS[step]}`}
            </div>
          </div>
        )}

        {/* Sizes to its content. The old fixed 280px floor is what left
            the one-field steps looking half-empty. */}
        <div className="px-6 pt-5 pb-5 overflow-y-auto flex-1" style={{ minHeight: 180 }}>
          <AnimatePresence mode="wait" custom={direction.current} initial={false}>
            <motion.div
              key={step}
              custom={direction.current}
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.26, ease: [0.22, 0.8, 0.3, 1] }}
            >
              {step === 0 && <StepWelcome t={t} name={form.name} />}
              {step === 1 && <StepName form={form} setForm={setForm} t={t} />}
              {step === 2 && <StepSex form={form} setForm={setForm} t={t} />}
              {step === 3 && <StepHeight form={form} setForm={setForm} t={t} />}
              {step === 4 && <StepWeight form={form} setForm={setForm} t={t} />}
              {step === 5 && <StepAge form={form} setForm={setForm} t={t} />}
              {step === 6 && <StepGoal form={form} setForm={setForm} t={t} />}
              {step === 7 && <StepActivity form={form} setForm={setForm} t={t} />}
              {step === 8 && <StepReview form={form} t={t} goTo={goTo} />}
            </motion.div>
          </AnimatePresence>
        </div>

        {error && (
          <div className="px-6 pb-2 shrink-0">
            <div
              className="text-[11.5px] font-grotesk px-3 py-2 rounded-xl"
              role="alert"
              style={{ background: `${t.danger}12`, border: `1px solid ${t.danger}30`, color: t.danger }}
            >
              {error}
            </div>
          </div>
        )}

        <div className="px-6 pb-6 pt-1 flex gap-2.5 shrink-0">
          {step > 0 && (
            <button
              type="button"
              onClick={handleBack}
              className="px-4 rounded-2xl font-grotesk text-[12.5px] font-semibold transition-all active:scale-95"
              style={{ minHeight: 50, background: 'transparent', border: `1px solid ${t.border}`, color: t.mute }}
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={handleNext}
            disabled={!canNext || saving}
            className="flex-1 rounded-2xl font-grotesk text-[14px] font-bold transition-all active:scale-[.97]"
            style={{
              minHeight: 50,
              background: canNext && !saving ? t.accent : t.surface,
              color: canNext && !saving ? 'var(--accent-contrast)' : t.mute,
              border: `1px solid ${canNext && !saving ? t.accent : t.border}`,
              opacity: canNext && !saving ? 1 : 0.55,
              cursor: canNext && !saving ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? 'Saving…' : isWelcome ? 'Get started' : isReview ? 'Looks right — finish' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
