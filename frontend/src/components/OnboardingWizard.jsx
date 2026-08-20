import { useState } from 'react';
import { useAuth } from '../auth.jsx';

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'basics', label: 'About You' },
  { id: 'body', label: 'Body Info' },
  { id: 'goals', label: 'Goals' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'review', label: 'Review' },
];

const GOALS = [
  { value: 'FAT_LOSS', label: 'Fat Loss', icon: '🔥', desc: 'Lose weight and reduce body fat' },
  { value: 'MUSCLE_GAIN', label: 'Muscle Gain', icon: '💪', desc: 'Build muscle and increase strength' },
  { value: 'RECOMP', label: 'Recomposition', icon: '⚖️', desc: 'Lose fat while gaining muscle' },
  { value: 'STRENGTH', label: 'Strength', icon: '🏋️', desc: 'Get stronger and lift heavier' },
  { value: 'GENERAL', label: 'General Fitness', icon: '🏃', desc: 'Stay active and healthy' },
];

const EXPERIENCE = [
  { value: 'BEGINNER', label: 'Beginner', desc: 'New to training' },
  { value: 'INTERMEDIATE', label: 'Intermediate', desc: '1-3 years experience' },
  { value: 'ADVANCED', label: 'Advanced', desc: '3+ years experience' },
];

const DIET = [
  { value: 'NON_VEG', label: 'Non-Vegetarian' },
  { value: 'VEG', label: 'Vegetarian' },
  { value: 'VEGAN', label: 'Vegan' },
  { value: 'EGGETARIAN', label: 'Eggetarian' },
];

const EQUIPMENT = [
  { value: 'full_gym', label: 'Full Gym' },
  { value: 'dumbbells', label: 'Dumbbells' },
  { value: 'barbell', label: 'Barbell' },
  { value: 'bands', label: 'Resistance Bands' },
  { value: 'bodyweight', label: 'Bodyweight Only' },
  { value: 'machines', label: 'Machines' },
];

export default function OnboardingWizard({ onComplete }) {
  const { register, completeOnboarding } = useAuth();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [data, setData] = useState({
    name: '', email: '', password: '',
    age: '', sex: '', height_cm: '', weight: '', target_weight: '',
    goal: '', experience: '', equipment: [],
    diet_type: '', meals_per_day: 5, water_target_l: 3,
  });

  const update = (key, val) => setData((d) => ({ ...d, [key]: val }));
  const toggleEquipment = (val) => {
    setData((d) => ({
      ...d,
      equipment: d.equipment.includes(val)
        ? d.equipment.filter((e) => e !== val)
        : [...d.equipment, val]
    }));
  };

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const finish = async () => {
    setBusy(true); setErr('');
    try {
      // Register the user
      const { clientId } = await register({
        name: data.name,
        email: data.email,
        password: data.password,
      });
      // Complete onboarding with profile data
      await completeOnboarding({
        age: data.age ? Number(data.age) : undefined,
        sex: data.sex || undefined,
        height_cm: data.height_cm ? Number(data.height_cm) : undefined,
        weight: data.weight ? Number(data.weight) : undefined,
        target_weight: data.target_weight ? Number(data.target_weight) : undefined,
        goal: data.goal || undefined,
        experience: data.experience || undefined,
        equipment: data.equipment.length ? JSON.stringify(data.equipment) : undefined,
        diet_type: data.diet_type || undefined,
        meals_per_day: Number(data.meals_per_day) || 5,
        water_target_l: Number(data.water_target_l) || 3,
      });
      onComplete();
    } catch (e) {
      setErr(e.message || 'Something went wrong');
    }
    setBusy(false);
  };

  const canProceed = () => {
    if (step === 0) return true; // welcome
    if (step === 1) return data.name.trim() && data.email.trim() && data.password.length >= 6;
    if (step === 2) return true; // body info is optional
    if (step === 3) return true; // goals optional
    if (step === 4) return true; // preferences optional
    return true;
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-md">
        {/* Progress bar */}
        <div className="flex gap-1.5 mb-6">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex-1 h-1 rounded-full transition-all duration-300" style={{
              background: i <= step ? 'var(--accent)' : 'var(--line)',
              boxShadow: i === step ? '0 0 8px var(--accent-soft)' : 'none'
            }} />
          ))}
        </div>

        {/* Step indicator */}
        <div className="text-[10px] uppercase tracking-[.16em] font-grotesk font-semibold mb-2" style={{ color: 'var(--accent)' }}>
          Step {step + 1} of {STEPS.length} · {STEPS[step].label}
        </div>

        {/* Step content */}
        <div className="rounded-2xl p-6 min-h-[360px] flex flex-col" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>

          {/* WELCOME */}
          {step === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 rounded-2xl grid place-items-center text-3xl mb-4" style={{ background: 'var(--accent-soft)' }}>🏋️</div>
              <h2 className="font-grotesk font-bold text-xl mb-2" style={{ color: 'var(--ink)' }}>Welcome to SK OS</h2>
              <p className="text-sm max-w-xs" style={{ color: 'var(--mute)' }}>Let's set up your profile so we can personalize your fitness journey.</p>
            </div>
          )}

          {/* ABOUT YOU */}
          {step === 1 && (
            <div className="flex-1 space-y-4">
              <h3 className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>About You</h3>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold" style={{ color: 'var(--mute)' }}>Full Name</label>
                <input className="input mt-1" placeholder="Your name" value={data.name} onChange={(e) => update('name', e.target.value)} autoFocus />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold" style={{ color: 'var(--mute)' }}>Email</label>
                <input className="input mt-1" type="email" placeholder="you@example.com" value={data.email} onChange={(e) => update('email', e.target.value)} />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold" style={{ color: 'var(--mute)' }}>Password (min 6 characters)</label>
                <input className="input mt-1" type="password" placeholder="••••••" value={data.password} onChange={(e) => update('password', e.target.value)} />
              </div>
            </div>
          )}

          {/* BODY INFO */}
          {step === 2 && (
            <div className="flex-1 space-y-4">
              <h3 className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>Body Info</h3>
              <p className="text-xs" style={{ color: 'var(--mute)' }}>Optional — helps us personalize your experience.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold" style={{ color: 'var(--mute)' }}>Age</label>
                  <input className="input mt-1" type="number" placeholder="25" value={data.age} onChange={(e) => update('age', e.target.value)} />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold" style={{ color: 'var(--mute)' }}>Sex</label>
                  <div className="flex gap-1.5 mt-1">
                    {[['male', 'Male'], ['female', 'Female'], ['other', 'Other']].map(([v, l]) => (
                      <button key={v} onClick={() => update('sex', v)} className="flex-1 py-2 rounded-lg text-[11px] font-grotesk font-semibold transition-all" style={{
                        background: data.sex === v ? 'var(--accent-soft)' : 'var(--bg2)',
                        border: `1px solid ${data.sex === v ? 'var(--accent)' : 'var(--line)'}`,
                        color: data.sex === v ? 'var(--accent)' : 'var(--mute)'
                      }}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold" style={{ color: 'var(--mute)' }}>Height (cm)</label>
                  <input className="input mt-1" type="number" placeholder="170" value={data.height_cm} onChange={(e) => update('height_cm', e.target.value)} />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold" style={{ color: 'var(--mute)' }}>Current Weight (kg)</label>
                  <input className="input mt-1" type="number" placeholder="70" value={data.weight} onChange={(e) => update('weight', e.target.value)} />
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold" style={{ color: 'var(--mute)' }}>Target Weight (kg)</label>
                <input className="input mt-1" type="number" placeholder="65" value={data.target_weight} onChange={(e) => update('target_weight', e.target.value)} />
              </div>
            </div>
          )}

          {/* GOALS */}
          {step === 3 && (
            <div className="flex-1 space-y-4">
              <h3 className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>Fitness Goal</h3>
              <p className="text-xs" style={{ color: 'var(--mute)' }}>What's your primary fitness goal?</p>
              <div className="space-y-2">
                {GOALS.map((g) => (
                  <button key={g.value} onClick={() => update('goal', g.value)} className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all" style={{
                    background: data.goal === g.value ? 'var(--accent-soft)' : 'var(--bg2)',
                    border: `1px solid ${data.goal === g.value ? 'var(--accent)' : 'var(--line)'}`,
                  }}>
                    <span className="text-xl">{g.icon}</span>
                    <div>
                      <div className="font-grotesk text-sm font-semibold" style={{ color: data.goal === g.value ? 'var(--accent)' : 'var(--ink)' }}>{g.label}</div>
                      <div className="text-[11px]" style={{ color: 'var(--mute)' }}>{g.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* PREFERENCES */}
          {step === 4 && (
            <div className="flex-1 space-y-4">
              <h3 className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>Preferences</h3>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold mb-1.5 block" style={{ color: 'var(--mute)' }}>Experience Level</label>
                <div className="flex gap-1.5">
                  {EXPERIENCE.map((e) => (
                    <button key={e.value} onClick={() => update('experience', e.value)} className="flex-1 py-2.5 rounded-lg text-center transition-all" style={{
                      background: data.experience === e.value ? 'var(--accent-soft)' : 'var(--bg2)',
                      border: `1px solid ${data.experience === e.value ? 'var(--accent)' : 'var(--line)'}`,
                      color: data.experience === e.value ? 'var(--accent)' : 'var(--mute)'
                    }}>
                      <div className="font-grotesk text-[11px] font-semibold">{e.label}</div>
                      <div className="text-[9px]" style={{ color: 'var(--faint)' }}>{e.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold mb-1.5 block" style={{ color: 'var(--mute)' }}>Equipment Available</label>
                <div className="flex flex-wrap gap-1.5">
                  {EQUIPMENT.map((e) => (
                    <button key={e.value} onClick={() => toggleEquipment(e.value)} className="px-3 py-1.5 rounded-full text-[11px] font-grotesk font-semibold transition-all" style={{
                      background: data.equipment.includes(e.value) ? 'var(--accent-soft)' : 'var(--bg2)',
                      border: `1px solid ${data.equipment.includes(e.value) ? 'var(--accent)' : 'var(--line)'}`,
                      color: data.equipment.includes(e.value) ? 'var(--accent)' : 'var(--mute)'
                    }}>{e.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold mb-1.5 block" style={{ color: 'var(--mute)' }}>Diet Type</label>
                <div className="flex gap-1.5">
                  {DIET.map((d) => (
                    <button key={d.value} onClick={() => update('diet_type', d.value)} className="flex-1 py-2 rounded-lg text-[11px] font-grotesk font-semibold transition-all" style={{
                      background: data.diet_type === d.value ? 'var(--accent-soft)' : 'var(--bg2)',
                      border: `1px solid ${data.diet_type === d.value ? 'var(--accent)' : 'var(--line)'}`,
                      color: data.diet_type === d.value ? 'var(--accent)' : 'var(--mute)'
                    }}>{d.label}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* REVIEW */}
          {step === 5 && (
            <div className="flex-1 space-y-4">
              <h3 className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>Review</h3>
              <div className="space-y-2">
                {[
                  ['Name', data.name],
                  ['Email', data.email],
                  ['Age', data.age || '—'],
                  ['Sex', data.sex || '—'],
                  ['Height', data.height_cm ? `${data.height_cm} cm` : '—'],
                  ['Weight', data.weight ? `${data.weight} kg` : '—'],
                  ['Target', data.target_weight ? `${data.target_weight} kg` : '—'],
                  ['Goal', GOALS.find((g) => g.value === data.goal)?.label || '—'],
                  ['Experience', data.experience || '—'],
                  ['Equipment', data.equipment.length ? data.equipment.join(', ') : '—'],
                  ['Diet', data.diet_type || '—'],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between py-2 border-b" style={{ borderColor: 'var(--line)' }}>
                    <span className="text-[11px] font-grotesk font-semibold uppercase tracking-wider" style={{ color: 'var(--mute)' }}>{label}</span>
                    <span className="text-sm font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>{value}</span>
                  </div>
                ))}
              </div>
              {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5">{err}</div>}
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex gap-3 mt-4">
          {step > 0 && (
            <button onClick={back} className="flex-1 py-3 rounded-xl font-grotesk text-sm font-semibold transition-all" style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--mute)' }}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button onClick={next} disabled={!canProceed()} className="flex-1 py-3 rounded-xl font-grotesk text-sm font-bold transition-all" style={{
              background: canProceed() ? 'var(--accent)' : 'var(--bg2)',
              color: canProceed() ? 'var(--accent-contrast)' : 'var(--mute)',
              opacity: canProceed() ? 1 : 0.5,
            }}>
              Continue
            </button>
          ) : (
            <button onClick={finish} disabled={busy} className="flex-1 py-3 rounded-xl font-grotesk text-sm font-bold transition-all" style={{
              background: busy ? 'var(--bg2)' : 'var(--accent)',
              color: busy ? 'var(--mute)' : 'var(--accent-contrast)',
            }}>
              {busy ? 'Creating account…' : 'Get Started 🚀'}
            </button>
          )}
        </div>

        {/* Skip */}
        <button onClick={onComplete} className="w-full mt-3 py-2 text-center font-grotesk text-[11px] font-semibold transition-colors" style={{ color: 'var(--faint)' }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
