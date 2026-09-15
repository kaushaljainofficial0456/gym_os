import { useEffect, useRef, useState } from 'react';
import { useOutletContext, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, GOAL_LABEL } from '../../utils.js';
import { useTheme } from '../../themeContext.jsx';
import { useUnits } from '../../unitsContext.jsx';
import { DASH_CARDS, DEFAULT_ORDER, resolveDashboard, parseDashboardPrefs } from '../../dashboardCards.js';
import WeightInput, { LengthInput } from '../../components/WeightInput.jsx';
import { ErrorState, Ring, XIcon, PageSkeleton } from '../../components/UI.jsx';
// TWO components are called Ring and they mean OPPOSITE things by `label`:
// UI.jsx's renders it as visible 26px centre text, Ring.jsx's uses it as an
// aria-label. Writing a call for one while importing the other put a whole
// sentence across the goal card at 26px. Imported under a distinct name so
// the next reader cannot make the same swap by accident.
import ProgressArc from '../../components/Ring.jsx';
import { AdherenceBreakdown } from '../../components/charts.jsx';
import Icon from '../../components/Icon.jsx';
import InfoDot from '../../components/InfoDot.jsx';

const EQUIPMENT = [
  { id: 'barbell', label: 'Barbell' }, { id: 'dumbbells', label: 'Dumbbells' }, { id: 'cable', label: 'Cable machine' },
  { id: 'machine', label: 'Machine' }, { id: 'bench', label: 'Bench' },
  { id: 'pull_up_bar', label: 'Pull-up bar' }, { id: 'bands', label: 'Resistance bands' },
  { id: 'bodyweight', label: 'Bodyweight' }, { id: 'full_gym', label: 'Full gym' }
];
const GOALS = [
  ['FAT_LOSS', 'Fat loss'], ['MUSCLE_GAIN', 'Muscle gain'], ['RECOMP', 'Recomposition'],
  ['STRENGTH', 'Strength'], ['GENERAL', 'General fitness']
];
const EXP = [['BEGINNER', 'Beginner'], ['INTERMEDIATE', 'Intermediate'], ['ADVANCED', 'Advanced']];

const PROFILE_SECTIONS = [
  { id: 'goal', label: 'Goal & Setup', icon: 'target', desc: 'View progress and update your goals' },
  { id: 'equipment', label: 'My Equipment', icon: 'strength', desc: 'Manage your gym equipment' },
  /* "My Metrics" lived here and body measurements lived on Progress --
     two screens for "a number about me over time", and the sidebar row
     for this one was itself labelled "Measurements". They are one screen
     now (Progress), and this row points there rather than being a second
     half-version of it. */
  { id: 'metrics', label: 'Measurements', icon: 'ruler', desc: 'Body measurements and anything else you track',
    href: '/app/client/progress?section=measurements' },
  { id: 'nutrition-tracker', label: 'Nutrition Tracker', icon: 'food', desc: 'Calendar and full logging history' },
  { id: 'coach', label: 'Coach Preference', icon: 'chat', desc: 'Coach settings and messages' },
  { id: 'dashboard', label: 'Home Screen', icon: 'clipboard', desc: 'Choose which cards appear, and in what order' },
  // Was '❓' — a literal emoji where the other six rows pass an Icon name,
  // so this one row rendered Icon.jsx's fallback glyph instead of a real
  // icon. Same bug class ClientLayout.jsx already documents fixing at 9
  // other sites.
  { id: 'help', label: 'Help', icon: 'bulb', desc: 'Learn how to use Barbell' },
];

/**
 * JOURNEY HERO — where they started, where they are, where they're going.
 *
 * The profile header stated a current weight and nothing else, so the one
 * fact a person opens this page for -- am I actually moving? -- was not
 * on it. Progress owns the deep analysis; this is the single sentence
 * version, and it links there rather than duplicating it (§119).
 *
 * IT HAS TO HANDLE OVERSHOOT, because real people do. This client began
 * at 94, targets 82 and is now 75: seven kilos PAST the goal. A naive
 * "7 kg remaining" would render as a negative, and a progress bar clamped
 * to 100% would quietly hide that they have gone further than they
 * planned -- which for a fat-loss client is a thing a coach wants to see,
 * not a rounding detail.
 *
 * Renders nothing at all without a start and a current weight. A journey
 * with one end missing is not a journey, and a hero built from a single
 * number would just be the header again in a bigger font.
 */
function JourneyHero({ client }) {
  const u = useUnits();
  const start = Number(client?.startWeight);
  const now = Number(client?.currentWeight);
  const target = Number(client?.targetWeight);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return null;

  const moved = Math.round((now - start) * 10) / 10;
  const hasTarget = Number.isFinite(target);
  // Which way this goal is meant to go, taken from the journey itself
  // rather than the goal label -- the two can disagree, and the numbers
  // are the thing actually happening.
  const losing = hasTarget ? target < start : moved < 0;
  const remaining = hasTarget ? Math.round((now - target) * 10) / 10 : null;
  const overshot = hasTarget && (losing ? now < target : now > target);

  const span = hasTarget ? Math.abs(target - start) : 0;
  const done = hasTarget && span > 0
    ? Math.max(0, Math.min(100, (Math.abs(now - start) / span) * 100))
    : null;

  return (
    <div
      className="rounded-2xl p-4 mb-3"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="t-micro">Your journey</div>
        {moved !== 0 && (
          <div
            className="font-grotesk font-bold text-[13px] tabular-nums"
            style={{ color: losing === moved < 0 ? 'var(--m-body)' : 'var(--mute)' }}
          >
            {u.fmtWeightDelta(moved)}
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 mt-2 tabular-nums">
        <Leg label="Start" value={u.weightNum(start)} unit={u.weightUnit} />
        <Arrow />
        <Leg label="Now" value={u.weightNum(now)} unit={u.weightUnit} emphasis />
        {hasTarget && <><Arrow /><Leg label="Target" value={u.weightNum(target)} unit={u.weightUnit} /></>}
      </div>

      {done != null && (
        <div className="mt-3">
          <div className="meter" style={{ height: 6 }}>
            <span
              className="meter-fill"
              style={{ width: `${done}%`, background: overshot ? 'var(--m-body)' : 'var(--accent-grad)' }}
            />
          </div>
          <div className="text-[11px] mt-1.5" style={{ color: 'var(--mute)' }}>
            {overshot
              /* Stated as a fact, not as a failure. Going past a target is
                 information, and calling it "-7 kg remaining" would be
                 both wrong and discouraging. */
              ? <>Target reached — you're <strong style={{ color: 'var(--ink)' }}>{u.fmtWeight(Math.abs(remaining))}</strong> past it.</>
              : <><strong style={{ color: 'var(--ink)' }}>{u.fmtWeight(Math.abs(remaining))}</strong> to go · {Math.round(done)}% of the way</>}
          </div>
        </div>
      )}
    </div>
  );
}

function Leg({ label, value, unit, emphasis }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-[.12em]" style={{ color: 'var(--faint)' }}>{label}</div>
      <div
        className="font-grotesk font-bold leading-none mt-0.5"
        style={{ fontSize: emphasis ? 22 : 15, color: emphasis ? 'var(--ink)' : 'var(--mute)' }}
      >
        {value}<span className="text-[10px] font-semibold" style={{ color: 'var(--faint)' }}> {unit}</span>
      </div>
    </div>
  );
}

function Arrow() {
  return <span className="text-[13px] pb-1" style={{ color: 'var(--faint)' }} aria-hidden="true">→</span>;
}

function MiniSpark({ values, color = 'var(--accent)' }) {
  if (!values?.length) return <div className="text-[10px] text-faint">No entries yet</div>;
  const pts = values.slice(-8).map((v, i, a) => {
    const min = Math.min(...a), max = Math.max(...a);
    const x = (i / Math.max(1, a.length - 1)) * 80 + 6;
    const y = 26 - ((v - min) / (max - min || 1)) * 20 - 3;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg viewBox="0 0 92 30" className="w-full h-8">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackButton({ onClick }) {
  return (
    <button onClick={onClick} className="chrome-btn gap-2 mb-4 -ml-2 px-2 py-1.5">
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
      <span className="font-grotesk text-sm font-semibold">Back to Profile</span>
    </button>
  );
}

function HelpInline() {
  const [expanded, setExpanded] = useState(null);
  const HELP_SECTIONS = [
    { id: 'overview', icon: 'home', title: 'How Barbell Works', content: 'Barbell is your personal fitness operating system. It connects you with your coach, tracks your workouts, nutrition, and progress — all in one place.', items: ['Your coach designs personalized plans', 'Track daily activities — workouts, meals, sleep', 'Barbell analyzes your data and provides insights', 'Your coach gets real-time updates'] },
    { id: 'workouts', icon: 'strength', title: 'How Workouts Work', content: 'Your coach assigns structured workout plans with exercises, sets, reps, and weights.', items: ['Open a workout to see all exercises', 'Log your actual weights and reps', 'Rest timer helps track between sets', 'Complete all exercises to finish the session'] },
    { id: 'nutrition', icon: 'food', title: 'How Nutrition Works', content: 'Your nutrition plan is designed by your coach based on your goals.', items: ['View your daily meal plan', 'Mark meals as eaten when complete', 'Use Ask Barbell to quickly log foods', 'Take a meal photo for calorie estimates'] },
    { id: 'progress', icon: 'trending', title: 'Progress Tracking', content: 'Track your body transformation over time with weight, measurements, and photos.', items: ['Log weight regularly on Progress page', 'View weight trends with charts', 'Track body measurements', 'See your adherence score'] },
    { id: 'coach', icon: 'robot', title: 'Coach & Intelligence', content: 'Barbell provides intelligent coaching insights and recommendations.', items: ['Coach Brief shows daily priorities', 'Weekly reviews summarize performance', 'Ask Barbell natural language questions', 'Message your coach from Profile'] },
  ];
  return (
    <div className="space-y-3">
      <div className="font-display font-bold text-lg" style={{ color: 'var(--ink)' }}>Help</div>
      {HELP_SECTIONS.map((section) => (
        <div key={section.id} className="card overflow-hidden">
          <button onClick={() => setExpanded(expanded === section.id ? null : section.id)} className="w-full flex items-center gap-3 p-4 text-left" style={{ color: 'var(--ink)' }}>
            <span className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name={section.icon} size={20} /></span>
            <span className="flex-1 font-grotesk font-bold text-sm">{section.title}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className="shrink-0 transition-transform duration-200"
              style={{ color: 'var(--mute)', transform: expanded === section.id ? 'rotate(180deg)' : 'none' }}>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {expanded === section.id && (
            <div className="px-4 pb-4 border-t border-line/40 pt-3 anim-fadeUp">
              <p className="text-[13px] leading-relaxed mb-3" style={{ color: 'var(--mute)' }}>{section.content}</p>
              <div className="space-y-2">
                {section.items.map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className="text-xs mt-0.5 shrink-0" style={{ color: 'var(--accent)' }}>•</span>
                    <span className="text-[12px] leading-relaxed" style={{ color: 'var(--mute)' }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Appearance now lives in Settings, where someone looking for it goes.
 *
 * This was a two-state switch, and Settings offers System / Light / Dark.
 * Leaving both meant the switch could silently destroy a "System" choice
 * -- flipping it has to resolve to an explicit light or dark, because
 * there is no third position on a toggle. Two controls for one
 * preference, disagreeing about what the preference even is.
 *
 * Kept as a row rather than deleted outright: this is where people have
 * been changing the theme, so it says where it moved to instead of
 * vanishing.
 */
/* ════════════════════════════════════════════════════════════════
   COACH PREFERENCES — a conversation, not a form to endure.

   Every field was a bare text box whose placeholder repeated its own
   label word for word ("PREFERRED TRAINING TIME" over a box reading
   "Preferred training time"). That is zero information twice: the hint
   tells you nothing the label didn't, and the moment you type it's gone.
   Nothing on the screen said what any of it was FOR, so the honest
   response to "Equipment preference" was to skip it.

   Three of these have a small, knowable set of answers, and typing prose
   where a choice exists is both slower and worse input. Those are chips
   now. The two that are genuinely open keep free text but carry a real
   example, and the note becomes the textarea it always was.

   Each field says what it CHANGES, because these feed the plans the
   coach writes -- and a field that visibly does something gets filled in.
   ──────────────────────────────────────────────────────────────── */
const COACH_FIELDS = [
  { key: 'training_time', label: 'When you train',
    why: 'Sessions get scheduled when you actually have energy.',
    options: ['Early morning', 'Morning', 'Afternoon', 'Evening', 'Late night'] },
  { key: 'workout_duration', label: 'Time per session',
    why: 'The plan is built to fit this, not trimmed to fit later.',
    options: ['30 min', '45 min', '60 min', '75 min', '90 min'] },
  { key: 'equipment_pref', label: 'What you can train with',
    why: 'Anything you have no kit for is left out entirely.',
    options: ['Full gym', 'Home basics', 'Dumbbells only', 'Bodyweight only', 'Resistance bands'] },
  { key: 'liked_foods', label: 'Foods you actually eat',
    why: 'Meal suggestions are built from these first.',
    placeholder: 'paneer, oats, eggs, rajma…' },
  { key: 'disliked_exercises', label: 'Exercises to avoid',
    why: 'Each one gets swapped for something that trains the same muscle.',
    placeholder: 'burpees, overhead press…' },
  { key: 'note', label: 'Anything else worth knowing',
    why: 'Injuries, a competition, travel coming up.',
    placeholder: 'Bad left knee — no deep lunges. Wedding in March.',
    multiline: true },
];

function CoachField({ field, value, onChange }) {
  const val = value ?? '';
  // A value typed before these were chips (or set by the coach) must stay
  // selectable, or opening this screen and saving would silently delete it.
  const opts = field.options
    ? (val && !field.options.includes(val) ? [...field.options, val] : field.options)
    : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold" style={{ color: 'var(--ink)' }}>{field.label}</span>
        {val ? null : <span className="text-[9.5px]" style={{ color: 'var(--faint)' }}>optional</span>}
      </div>
      <div className="text-[10.5px] mt-0.5 mb-1.5 leading-snug" style={{ color: 'var(--faint)' }}>{field.why}</div>

      {opts ? (
        <div className="flex flex-wrap gap-1.5">
          {opts.map((o) => {
            const on = val === o;
            return (
              <button
                key={o} type="button" aria-pressed={on}
                onClick={() => onChange(on ? '' : o)}
                className="rounded-full px-3 text-[11.5px] font-semibold transition-colors"
                style={{
                  minHeight: 38,
                  background: on ? 'var(--cta-solid)' : 'transparent',
                  color: on ? 'var(--cta-ink)' : 'var(--mute)',
                  border: `1px solid ${on ? 'transparent' : 'var(--line)'}`,
                }}
              >{o}</button>
            );
          })}
        </div>
      ) : field.multiline ? (
        <textarea
          className="input w-full" rows={3} value={val} placeholder={field.placeholder}
          aria-label={field.label}
          onChange={(e) => onChange(e.target.value)}
          style={{ minHeight: 76, resize: 'vertical' }}
        />
      ) : (
        <input
          type="text" className="input w-full" value={val} placeholder={field.placeholder}
          aria-label={field.label}
          onChange={(e) => onChange(e.target.value)}
          style={{ minHeight: 44 }}
        />
      )}
    </div>
  );
}

function ThemeToggle() {
  const { theme: choice, resolved } = useTheme();
  const label = choice === 'system'
    ? `System · currently ${resolved}`
    : resolved === 'dark' ? 'Dark' : 'Light';
  return (
    <Link to="/app/client/settings" className="card p-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="t-micro">Appearance</div>
        <div className="text-sm font-grotesk mt-0.5" style={{ color: 'var(--ink)' }}>{label}</div>
      </div>
      <span className="text-[11.5px] shrink-0" style={{ color: 'var(--accent)' }}>Change in Settings</span>
    </Link>
  );
}

export default function Profile() {
  const units = useUnits();
  const nav = useNavigate();
  /* Which panel is open lives in the URL, not only in state, so the
     header menu's "Measurements" / "Goals" rows can land on the panel they
     name instead of dumping you on the hub to find it yourself. Back still
     works: closing a panel clears the param rather than pushing history. */
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get('section');
  const [activeSection, setActiveSectionState] = useState(
    () => (PROFILE_SECTIONS.some((s) => s.id === requestedSection) ? requestedSection : null)
  );
  const setActiveSection = (id) => {
    setActiveSectionState(id);
    setSearchParams(id ? { section: id } : {}, { replace: true });
  };
  // A later navigation to ?section=… (menu row tapped while already on
  // Profile) doesn't remount, so the param has to be watched, not just read
  // once at mount.
  useEffect(() => {
    if (requestedSection && PROFILE_SECTIONS.some((s) => s.id === requestedSection)) {
      setActiveSectionState(requestedSection);
    } else if (!requestedSection) {
      setActiveSectionState(null);
    }
  }, [requestedSection]);

  // Already fetched once by the persistent ClientLayout — reuse it instead
  // of re-fetching /tracking/me/home on every mount (see ClientLayout.jsx).
  const home = useOutletContext();
  const meDash = useFetch(() => api('/me/dashboard'));
  const metrics = useFetch(() => api('/me/metrics'));
  const profile = useFetch(() => api('/me/profile'));
  const [msgs, setMsgs] = useState(null);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  // metric form
  const [mForm, setMForm] = useState({ name: '', unit: '', frequency: 'weekly', target: '', type: 'number' });
  const [mLog, setMLog] = useState({});
  const [savingM, setSavingM] = useState(false);
  const [editingM, setEditingM] = useState(null);
  // dashboard prefs
  const [order, setOrder] = useState([]);
  const [hidden, setHidden] = useState([]);
  const [savingPrefs, setSavingPrefs] = useState(false);
  // goal editor
  const [gForm, setGForm] = useState(null);
  const [savingG, setSavingG] = useState(false);
  const [toast, setToast] = useState('');
  const [localAvatar, setLocalAvatar] = useState(null);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  // coach memory/preferences
  const coachMem = useFetch(() => api('/intel/coach/memory'));
  const [coachPrefs, setCoachPrefs] = useState({});
  const [savingPrefs2, setSavingPrefs2] = useState(false);

  const data = home.data;
  const clientId = data?.client?.id;

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setToast('Only JPG, PNG, or WebP images are supported'); return; }
    // Matches POST /me/avatar's 1 MB cap — smaller than progress photos'
    // 5 MB since this round-trips through GET /auth/me on every page load.
    if (file.size > 1 * 1024 * 1024) { setToast('Image too large (max 1 MB)'); return; }
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file);
      });
      const res = await api('/me/avatar', { method: 'POST', body: JSON.stringify({ image: b64 }) });
      setLocalAvatar(res.avatar);
      // silent: true -- this page gates its whole render on `home.loading`
      // (below); a bare reload() would unmount everything for the
      // duration of the refetch, same class of bug already fixed for
      // Nutrition.jsx (see useFetch's own comment on why).
      home.reload({ silent: true });
      setToast('Profile photo updated ✓');
    } catch (err) { setToast(err.message || 'Upload failed'); }
    e.target.value = '';
  };

  const handleRemoveAvatar = async () => {
    try {
      await api('/me/avatar', { method: 'DELETE' });
      setLocalAvatar(null);
      home.reload({ silent: true });
      setRemoveConfirmOpen(false);
      setToast('Profile photo removed');
    } catch (err) { setToast(err.message || 'Failed to remove photo'); }
  };

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(h);
  }, [toast]);

  useEffect(() => {
    if (!meDash.data) return;
    // Resolved, not raw: rows saved before the catalogue was corrected
    // still name cards that no longer exist ('water', 'sleep', 'coach',
    // 'adherence' -- offered for months, rendered never). Running the
    // stored value through the same resolver Home uses means the editor
    // shows exactly the list Home will lay out, instead of offering
    // switches for cards that are not on the screen.
    const parsed = parseDashboardPrefs(meDash.data.prefs);
    const resolved = resolveDashboard(parsed.order, parsed.hidden);
    setOrder(resolved.order);
    setHidden([...resolved.hidden]);
  }, [meDash.data]);

  useEffect(() => {
    if (profile.data?.client) {
      const c = profile.data.client, p = profile.data.profile || {};
      let eq = [];
      try { eq = p.equipment ? JSON.parse(p.equipment) : (c.equipment ? JSON.parse(c.equipment) : []); } catch { eq = []; }
      setGForm({ goal: c.goal, targetWeight: c.target_weight, goalDate: c.goal_date || '', experience: p.experience || 'INTERMEDIATE', equipment: eq, heightCm: c.height_cm ?? '', currentWeight: c.current_weight ?? '', age: c.age ?? '', sex: c.sex || '' });
    }
  }, [profile.data]);

  useEffect(() => {
    if (clientId) {
      api(`/messages?client_id=${clientId}`).then((r) => setMsgs(r.messages || [])).catch(() => {});
    }
  }, [clientId]);

  useEffect(() => {
    if (coachMem.data?.memory) {
      const map = {};
      /* JSON IS NOT SOMETHING TO SHOW A PERSON.
       *
       * ai_memory stores values as JSON, and GET /intel/coach/memory
       * parses them back -- so a list arrives here as a real array. This
       * ran JSON.stringify over it and dropped the result into a text
       * box, so the field for "foods you actually eat" literally read
       * ["paneer","grilled chicken"], brackets and quotes included. It is
       * then also what you would edit and save back, one stray quote away
       * from being unparseable.
       *
       * A list reads as a list. Saving it back as plain comma-separated
       * text is fine and arguably better: the value's only consumer is
       * the AI context builder, which passes it to a language model. */
      for (const m of coachMem.data.memory) {
        map[m.key] = Array.isArray(m.value)
          ? m.value.join(', ')
          : (m.value && typeof m.value === 'object' ? Object.values(m.value).join(', ') : String(m.value ?? ''));
      }
      setCoachPrefs(map);
    }
  }, [coachMem.data]);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  if (home.loading || meDash.loading) return <PageSkeleton variant="list" label="Loading your profile" />;
  if (home.error) return <ErrorState error={home.error} onRetry={home.reload} />;

  const c = data.client;
  const total = c.startWeight - c.targetWeight;
  const progress = total > 0 ? Math.min(100, Math.max(0, ((c.startWeight - c.currentWeight) / total) * 100)) : 0;

  const send = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      const res = await api('/messages', { method: 'POST', body: JSON.stringify({ client_id: clientId, type: 'message', body }) });
      setMsgs((m) => [...(m || []), { id: res.id, body, from_name: c.name, type: 'message', created_at: new Date().toISOString(), mine: true }]);
      setBody('');
    } catch (e) {
      // Was `catch { /* keep body */ }` -- the input text was preserved
      // (good), but nothing ever told the user the send failed, so a
      // network hiccup or a validation error looked identical to a
      // successful send that just... didn't appear. Real errors now
      // surface instead of vanishing silently.
      setToast(e.message || 'Could not send message');
    }
    setSending(false);
  };

  const createMetric = async () => {
    if (!mForm.name.trim()) return;
    setSavingM(true);
    try {
      await api('/me/metrics', { method: 'POST', body: JSON.stringify({ ...mForm, target: mForm.target === '' ? null : Number(mForm.target) }) });
      setMForm({ name: '', unit: '', frequency: 'weekly', target: '', type: 'number' });
      metrics.reload({ silent: true });
      setToast('Metric created');
    } catch (e) { setToast(e.message); }
    setSavingM(false);
  };

  const saveMetricEdit = async () => {
    if (!editingM?.name?.trim()) return;
    setSavingM(true);
    try {
      await api(`/me/metrics/${editingM.id}`, { method: 'PUT', body: JSON.stringify({
        name: editingM.name, unit: editingM.unit, frequency: editingM.frequency,
        target: editingM.target === '' ? null : Number(editingM.target), type: editingM.type
      }) });
      setEditingM(null);
      metrics.reload({ silent: true });
      setToast('Metric updated');
    } catch (e) { setToast(e.message); }
    setSavingM(false);
  };

  const logBoolean = async (mId, val) => {
    setSavingM(true);
    try {
      await api(`/me/metrics/${mId}/entries`, { method: 'POST', body: JSON.stringify({ value: val ? 1 : 0 }) });
      metrics.reload({ silent: true });
      setToast(val ? 'Done ✓' : 'Logged');
    } catch (e) { setToast(e.message); }
    setSavingM(false);
  };

  const deleteEntry = async (mId, eId, label) => {
    /* Measurements are history, and this control is an 11px x sitting
       inside a chip -- eleven of them on screen at once, each one tap
       from permanently destroying a data point somebody stood on a scale
       to produce. There is no undo and no soft delete behind it, so the
       confirm names the exact reading rather than asking "are you sure?",
       which tells the reader nothing about what is about to vanish. */
    const ok = window.confirm(
      label
        ? `Delete this measurement?

${label}

This cannot be undone.`
        : 'Delete this measurement? This cannot be undone.');
    if (!ok) return;
    try {
      await api(`/me/metrics/${mId}/entries/${eId}`, { method: 'DELETE' });
      metrics.reload({ silent: true });
      setToast('Entry removed');
    } catch (e) { setToast(e.message); }
  };

  const logEntry = async (mId) => {
    const v = Number(mLog[mId]?.value);
    if (Number.isNaN(v)) return;
    setSavingM(true);
    try {
      await api(`/me/metrics/${mId}/entries`, { method: 'POST', body: JSON.stringify({ value: v, date: mLog[mId]?.date || undefined }) });
      setMLog((x) => ({ ...x, [mId]: {} }));
      metrics.reload({ silent: true });
      setToast('Logged');
    } catch (e) { setToast(e.message); }
    setSavingM(false);
  };

  /* DELETING A METRIC TAKES ITS ENTIRE HISTORY WITH IT -- the server
     removes every metric_entries row before the metric itself. This had
     no confirmation of any kind: one tap on a small icon permanently
     destroyed months of readings, with no undo and no soft delete
     anywhere behind it. Proven the hard way while testing this screen,
     which is exactly how a real user would lose their data.

     The count is in the prompt because "Delete Waist?" and "Delete
     Waist, including 4 recorded measurements?" are different questions,
     and only the second one lets someone decide properly. */
  const deleteMetric = async (mId) => {
    const metric = (metrics.data?.metrics || []).find((x) => x.id === mId);
    const n = metric?.entriesCount ?? (metric?.entries || []).length;
    const ok = window.confirm(
      `Delete "${metric?.name || 'this metric'}"?

`
      + (n > 0
        ? `Its ${n} recorded ${n === 1 ? 'measurement' : 'measurements'} will be deleted too. `
        : '')
      + 'This cannot be undone.');
    if (!ok) return;
    await api(`/me/metrics/${mId}`, { method: 'DELETE' }).then(() => { metrics.reload({ silent: true }); setToast('Metric deleted'); }).catch((e) => setToast(e.message));
  };

  /* Declared above savePrefs deliberately: a `const` used by a handler
     defined earlier in the same body is in the temporal dead zone for
     the rest of that render, and this file has already been bitten once
     by exactly that (see Workout.jsx's buildSets note). */
  const dashOrder = order.length ? order : DEFAULT_ORDER;

  const savePrefs = async () => {
    setSavingPrefs(true);
    try {
      await api('/me/dashboard', { method: 'PUT', body: JSON.stringify({ order: dashOrder, hidden }) });
      meDash.reload({ silent: true });
      setToast('Home screen saved');
    } catch (e) { setToast(e.message); }
    setSavingPrefs(false);
  };

  /* Reorders within the VISIBLE list only. Swapping with a hidden
     neighbour looked like a broken button: the row did not move, because
     the card it traded places with is not on the screen. */
  const move = (key, dir) => {
    setOrder((prev) => {
      const o = prev.length ? [...prev] : [...DEFAULT_ORDER];
      const visible = o.filter((k) => !hidden.includes(k));
      const vi = visible.indexOf(key);
      const vj = vi + dir;
      if (vi < 0 || vj < 0 || vj >= visible.length) return prev;
      const i = o.indexOf(key);
      const j = o.indexOf(visible[vj]);
      [o[i], o[j]] = [o[j], o[i]];
      return o;
    });
  };

  const resetDash = () => { setOrder([...DEFAULT_ORDER]); setHidden([]); };

  const saveGoal = async () => {
    if (!gForm) return;
    setSavingG(true);
    try {
      // Validate physical profile fields before saving
      const heightVal = gForm.heightCm !== '' && gForm.heightCm != null ? Number(gForm.heightCm) : null;
      const weightVal = gForm.currentWeight !== '' && gForm.currentWeight != null ? Number(gForm.currentWeight) : null;
      const ageVal = gForm.age !== '' && gForm.age != null ? Number(gForm.age) : null;
      if (heightVal !== null && (heightVal < 100 || heightVal > 250)) { setToast(`Height must be between ${units.fmtLength(100)} and ${units.fmtLength(250)}`); setSavingG(false); return; }
      if (weightVal !== null && (weightVal < 20 || weightVal > 400)) { setToast(`Weight must be between ${units.fmtWeight(20)} and ${units.fmtWeight(400)}`); setSavingG(false); return; }
      if (ageVal !== null && (ageVal < 10 || ageVal > 120)) { setToast('Age must be between 10–120'); setSavingG(false); return; }

      const targetVal = gForm.targetWeight !== '' && gForm.targetWeight != null ? Number(gForm.targetWeight) : null;
      if (targetVal !== null && (targetVal < 20 || targetVal > 400)) {
        setToast(`Target weight must be between ${units.fmtWeight(20)} and ${units.fmtWeight(400)}`); setSavingG(false); return;
      }

      /* A TARGET THAT CONTRADICTS THE GOAL. A fat-loss client at 75 kg
         could save a target of 95 kg and be told "Goal updated" -- the
         app then cheerfully reported 0% progress toward getting heavier,
         on a plan built to make them lighter. Almost always a typo (95
         for 85, or the target typed into the wrong box), and the app was
         the only thing in a position to notice.

         Asked, not blocked, and the value is never silently changed:
         someone may genuinely be reverse dieting or recovering weight,
         and the app does not get to overrule that. Only the two goals
         with an unambiguous direction are checked -- recomposition,
         strength and general fitness imply nothing about which way the
         number should move. */
      /* Compared against the START weight, not the current one. Measuring
         from current punishes success: this client began at 94, targets
         82 and is already down to 75 -- a perfectly good fat-loss goal
         they have overshot -- and comparing to current flagged their own
         real target as contradictory every time they opened the form.
         The direction of a goal is a property of the journey, so it is
         judged from where the journey started. */
      const startW = Number(data?.client?.startWeight);
      const compare = Number.isFinite(startW) ? startW : (weightVal ?? null);
      if (targetVal !== null && compare != null) {
        const wrongWay =
          (gForm.goal === 'FAT_LOSS' && targetVal > compare) ? 'heavier'
          : (gForm.goal === 'MUSCLE_GAIN' && targetVal < compare) ? 'lighter'
          : null;
        if (wrongWay) {
          const label = gForm.goal === 'FAT_LOSS' ? 'fat loss' : 'muscle gain';
          const ok = window.confirm(
            `Your target (${units.fmtWeight(targetVal)}) is ${wrongWay} than your starting weight (${units.fmtWeight(compare)}), `
            + `but your goal is ${label}.

Save it anyway?`);
          if (!ok) { setSavingG(false); return; }
        }
      }

      await api('/me/profile', { method: 'PUT', body: JSON.stringify({
        goal: gForm.goal, target_weight: targetVal,
        goal_date: gForm.goalDate || null, experience: gForm.experience, equipment: gForm.equipment,
        height_cm: heightVal, current_weight: weightVal, age: ageVal, sex: gForm.sex || null
      }) });
      home.reload({ silent: true });
      setToast('Goal updated');
    } catch (e) { setToast(e.message); }
    setSavingG(false);
  };

  const toggleEq = (id) => {
    setGForm((f) => {
      const eq = f.equipment.includes(id) ? f.equipment.filter((x) => x !== id) : [...f.equipment, id];
      return { ...f, equipment: eq };
    });
  };

  const visibleCards = dashOrder.filter((k) => !hidden.includes(k));

  // ── Profile section renderers ──

  const renderSection = (sectionId) => {
    const goBack = () => setActiveSection(null);

    switch (sectionId) {
      case 'goal': {
        /* GOAL & SETUP — two different jobs, told apart.
         *
         * This was one flat card: a micro-label, then seven inputs in a
         * grid, then a save button. Nothing said which fields were the
         * GOAL (what you are aiming at, which you change when your mind
         * changes) and which were YOU (height, age, sex — facts the
         * calorie model needs, set once and rarely touched). So every
         * visit presented seven equally-weighted boxes and left you to
         * work out which two mattered today.
         *
         * The journey now leads, because that is what the page is for.
         * Then the goal itself. Then, quietly and last, the physical
         * details — present, editable, and not competing.
         */
        const reached = c.targetWeight != null && c.startWeight != null
          && Math.sign(c.targetWeight - c.currentWeight) !== Math.sign(c.targetWeight - c.startWeight);
        const remaining = c.targetWeight != null ? Math.abs(c.currentWeight - c.targetWeight) : null;

        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />

            {/* ── where you are ── */}
            <div className="card p-4">
              <div className="flex items-center gap-4">
                <ProgressArc
                  value={Math.max(0, Math.min(100, progress)) / 100}
                  size={72} stroke={7} color="var(--m-body)"
                  label={c.targetWeight == null
                    ? 'No goal target set yet'
                    : `${Math.round(progress)} percent of the way to your target weight`}
                />
                <div className="min-w-0 flex-1">
                  <div className="t-micro">Goal progress</div>
                  <div className="mt-0.5 flex items-baseline gap-1.5">
                    <span className="font-grotesk text-[26px] font-black leading-none tabular-nums"
                          style={{ color: 'var(--ink)' }}>{Math.round(progress)}</span>
                    <span className="text-[12px]" style={{ color: 'var(--faint)' }}>%</span>
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--mute)' }}>
                    {c.targetWeight == null
                      ? 'No target set yet'
                      : reached
                        ? `Target reached — ${units.fmtWeight(remaining)} past it`
                        : `${units.fmtWeight(remaining)} to go`}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-2 text-[10.5px] tabular-nums"
                   style={{ color: 'var(--faint)' }}>
                <span>Start {units.fmtWeight(c.startWeight)}</span>
                <span style={{ color: 'var(--ink)' }}>Now {units.fmtWeight(c.currentWeight)}</span>
                <span>Target {units.fmtWeight(c.targetWeight)}</span>
              </div>
              {c.goalDate && (
                <div className="mt-1 text-[10.5px] text-center" style={{ color: 'var(--faint)' }}>
                  by {c.goalDate.slice(0, 10)}
                </div>
              )}
            </div>

            {gForm && (
              <>
                {/* ── what you are aiming at ── */}
                <div className="card p-4">
                  <div className="t-micro mb-3">What you're working toward</div>

                  <div className="text-[10px] mb-1.5 font-grotesk" style={{ color: 'var(--faint)' }}>PRIMARY GOAL</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {GOALS.map(([v, l]) => {
                      const on = gForm.goal === v;
                      return (
                        <button key={v} onClick={() => setGForm((f) => ({ ...f, goal: v }))}
                          aria-pressed={on}
                          className="rounded-xl px-3 text-left text-[12.5px] font-semibold transition-colors"
                          style={{
                            minHeight: 44,
                            border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                            background: on ? 'var(--bg2)' : 'transparent',
                            color: on ? 'var(--ink)' : 'var(--mute)',
                          }}>{l}</button>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <label className="block">
                      <span className="text-[10px] font-grotesk" style={{ color: 'var(--faint)' }}>
                        TARGET WEIGHT ({units.weightUnit.toUpperCase()})
                      </span>
                      <WeightInput className="input mt-1" valueKg={gForm.targetWeight} emptyValue={''}
                        ariaLabel={`Target weight in ${units.isImperial ? 'pounds' : 'kilograms'}`}
                        onChangeKg={(kg) => setGForm((f) => ({ ...f, targetWeight: kg }))} />
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-grotesk" style={{ color: 'var(--faint)' }}>TARGET DATE</span>
                      <input type="date" className="input mt-1" value={gForm.goalDate || ''}
                        aria-label="Target date"
                        onChange={(e) => setGForm((f) => ({ ...f, goalDate: e.target.value }))} />
                    </label>
                  </div>
                  <p className="text-[10.5px] mt-2 leading-snug" style={{ color: 'var(--faint)' }}>
                    A date turns the target into a pace you can check against — without one, Progress
                    can only say how far you've come.
                  </p>
                </div>

                {/* ── who the maths is about ── */}
                <div className="card p-4">
                  <div className="t-micro">About you</div>
                  <p className="text-[10.5px] mt-0.5 mb-3 leading-snug" style={{ color: 'var(--faint)' }}>
                    Used to work out your calorie and energy targets. Set once — you'll rarely come back here.
                  </p>

                  <div className="text-[10px] mb-1.5 font-grotesk" style={{ color: 'var(--faint)' }}>EXPERIENCE</div>
                  <div className="flex gap-1.5">
                    {EXP.map(([v, l]) => {
                      const on = gForm.experience === v;
                      return (
                        <button key={v} onClick={() => setGForm((f) => ({ ...f, experience: v }))}
                          aria-pressed={on}
                          className="flex-1 rounded-xl px-2 text-[12px] font-semibold transition-colors"
                          style={{
                            minHeight: 42,
                            border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                            background: on ? 'var(--bg2)' : 'transparent',
                            color: on ? 'var(--ink)' : 'var(--mute)',
                          }}>{l}</button>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-3">
                    {/* THE UNIT IN THE LABEL HAS TO BE THE UNIT IN THE BOX.
                        These were labelled "(CM)" and "(KG)" and wrote
                        whatever was typed straight to the canonical column,
                        so once imperial existed, typing 165 meaning pounds
                        stored 165 kg. */}
                    <label className="block">
                      <span className="text-[10px] font-grotesk" style={{ color: 'var(--faint)' }}>
                        HEIGHT ({units.lengthUnit.toUpperCase()})
                      </span>
                      <LengthInput className="input mt-1" placeholder={units.isImperial ? '69' : '170'}
                        valueCm={gForm.heightCm} emptyValue={''}
                        ariaLabel={`Height in ${units.isImperial ? 'inches' : 'centimetres'}`}
                        onChangeCm={(cm) => setGForm((f) => ({ ...f, heightCm: cm }))} />
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-grotesk" style={{ color: 'var(--faint)' }}>
                        CURRENT WEIGHT ({units.weightUnit.toUpperCase()})
                      </span>
                      <WeightInput className="input mt-1" placeholder={units.isImperial ? '165' : '75'}
                        valueKg={gForm.currentWeight} emptyValue={''}
                        ariaLabel={`Current weight in ${units.isImperial ? 'pounds' : 'kilograms'}`}
                        onChangeKg={(kg) => setGForm((f) => ({ ...f, currentWeight: kg }))} />
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-grotesk" style={{ color: 'var(--faint)' }}>AGE</span>
                      <input type="number" className="input mt-1" placeholder="25" aria-label="Age"
                        value={gForm.age ?? ''}
                        onChange={(e) => setGForm((f) => ({ ...f, age: e.target.value }))} />
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-grotesk" style={{ color: 'var(--faint)' }}>SEX</span>
                      <select className="input mt-1" value={gForm.sex || ''} aria-label="Sex"
                        onChange={(e) => setGForm((f) => ({ ...f, sex: e.target.value }))}>
                        <option value="">Select…</option>
                        <option value="MALE">Male</option>
                        <option value="FEMALE">Female</option>
                        <option value="OTHER">Other</option>
                      </select>
                    </label>
                  </div>
                </div>

                {/* One save for the screen, pinned to the bottom of the
                    flow rather than buried inside one of the cards. */}
                <button className="btn-primary w-full" onClick={saveGoal} disabled={savingG}
                        style={{ minHeight: 48 }}>
                  {savingG ? 'Saving…' : 'Save changes'}
                </button>
              </>
            )}
          </div>
        );
      }

      case 'equipment':
        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />
            <div className="card p-4">
              <div className="flex items-center gap-1 mb-3">
                <div className="t-micro">My Equipment</div>
                <InfoDot label="My Equipment" title="Why this matters">
                  Pick what you can actually get to. Your coach plans around it, and the
                  exercise library stops suggesting kit you do not have.
                </InfoDot>
              </div>
              {gForm ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {EQUIPMENT.map((eq) => (
                      <button key={eq.id} onClick={() => toggleEq(eq.id)}
                        className={`chip ${gForm.equipment.includes(eq.id) ? '!border-cyanx/50 !text-cyanx bg-cyanx/10' : ''}`}>
                        {gForm.equipment.includes(eq.id) ? '✓ ' : ''}{eq.label}
                      </button>
                    ))}
                  </div>
                  <button className="btn-primary w-full" onClick={saveGoal} disabled={savingG}>{savingG ? 'Saving…' : 'Save equipment'}</button>
                </div>
              ) : (
                <div className="text-xs text-mute py-3 text-center">Loading equipment data…</div>
              )}
            </div>
          </div>
        );

      case 'metrics':
        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />
            <div className="card p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="t-micro">My metrics</div>
                <span className="text-[10px] text-faint font-grotesk">track what matters to you</span>
              </div>
              {/* create form */}
              <div className="rounded-xl border border-line bg-tint/[.03] p-3 space-y-2 mt-2">
                <div className="grid grid-cols-2 gap-2">
                  <input className="input" placeholder="Metric name (e.g. Waist, Steps, Bench)" value={mForm.name} onChange={(e) => setMForm((f) => ({ ...f, name: e.target.value }))} />
                  <input className="input" placeholder="Unit (cm, kg, steps…)" value={mForm.unit} onChange={(e) => setMForm((f) => ({ ...f, unit: e.target.value }))} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <select className="input" value={mForm.type} onChange={(e) => setMForm((f) => ({ ...f, type: e.target.value }))}>
                    <option value="number">Number</option><option value="count">Count</option><option value="duration">Duration (h)</option><option value="boolean">Yes / No</option>
                  </select>
                  <select className="input" value={mForm.frequency} onChange={(e) => setMForm((f) => ({ ...f, frequency: e.target.value }))}>
                    <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                  </select>
                  <input className="input" placeholder="Target (optional)" type="number" value={mForm.target} onChange={(e) => setMForm((f) => ({ ...f, target: e.target.value }))} />
                </div>
                <button className="btn-primary w-full" onClick={createMetric} disabled={savingM || !mForm.name.trim()}>Add tracking metric</button>
              </div>
              {/* edit metric form */}
              {editingM && (
                <div className="rounded-xl border border-gold/30 bg-gold/5 p-3 space-y-2 mt-2">
                  <div className="text-[10px] text-gold font-grotesk uppercase tracking-wider">EDIT METRIC</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input className="input" value={editingM.name} onChange={(e) => setEditingM((f) => ({ ...f, name: e.target.value }))} />
                    <input className="input" placeholder="Unit" value={editingM.unit || ''} onChange={(e) => setEditingM((f) => ({ ...f, unit: e.target.value }))} />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <select className="input" value={editingM.type} onChange={(e) => setEditingM((f) => ({ ...f, type: e.target.value }))}>
                      <option value="number">Number</option><option value="count">Count</option><option value="duration">Duration (h)</option><option value="boolean">Yes / No</option>
                    </select>
                    <select className="input" value={editingM.frequency} onChange={(e) => setEditingM((f) => ({ ...f, frequency: e.target.value }))}>
                      <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                    </select>
                    <input className="input" placeholder="Target" type="number" value={editingM.target ?? ''} onChange={(e) => setEditingM((f) => ({ ...f, target: e.target.value }))} />
                  </div>
                  <div className="flex gap-2">
                    <button className="btn flex-1" onClick={() => setEditingM(null)}>Cancel</button>
                    <button className="btn-primary flex-1" onClick={saveMetricEdit} disabled={savingM}>Save</button>
                  </div>
                </div>
              )}
              {/* metric list */}
              <div className="space-y-2 mt-3">
                {(metrics.data?.metrics || []).map((m) => {
                  const vals = (m.entries || []).map((e) => e.value).reverse();
                  return (
                    <div key={m.id} className="rounded-xl border border-line bg-tint/[.03] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <span className="font-grotesk text-sm font-bold">{m.name}</span>
                          {m.unit && <span className="text-[10px] text-mute font-grotesk"> ({m.unit})</span>}
                          {m.target != null && <span className="text-[10px] text-faint font-grotesk"> · target {m.target}</span>}
                          {m.latest && <span className="block text-[11px] text-gold font-grotesk">latest {m.latest.value} {m.unit || ''} · {m.latest.date}</span>}
                        </div>
                        <div className="flex gap-1.5 shrink-0">
                          <button className="text-[10px] text-mute hover:text-ink tap-target" onClick={() => setEditingM({ id: m.id, name: m.name, unit: m.unit || '', frequency: m.frequency, target: m.target ?? '', type: m.type || 'number' })} aria-label={`Edit ${m.name}`}>Edit</button>
                          <button className="text-[10px] text-bad/80 hover:text-bad tap-target" onClick={() => deleteMetric(m.id)} aria-label={`Delete ${m.name}`}><XIcon /></button>
                        </div>
                      </div>
                      <MiniSpark values={vals} color={m.color || 'var(--accent)'} />
                      {(m.entries || []).slice(0, 4).length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {(m.entries || []).slice(0, 4).map((e) => (
                            <span key={e.id} className="inline-flex items-center gap-1 chip border-line !px-2 !py-0.5 text-[10px]">
                              {m.type === 'boolean' ? (e.value ? '✓ done' : '✗ no') : `${e.value}${m.unit ? ' ' + m.unit : ''}`} · {e.date}
                              <button
                                className="text-faint hover:text-bad tap-target"
                                onClick={() => deleteEntry(
                                  m.id,
                                  e.id,
                                  `${m.name}: ${m.type === 'boolean' ? (e.value ? 'done' : 'not done') : `${e.value}${m.unit ? ` ${m.unit}` : ''}`} on ${e.date}`,
                                )}
                                aria-label={`Delete ${m.name} entry from ${e.date}`}
                              ><XIcon /></button>
                            </span>
                          ))}
                        </div>
                      )}
                      {m.type === 'boolean' ? (
                        <div className="flex gap-2 mt-1.5">
                          <button className="btn btn-sm flex-1" onClick={() => logBoolean(m.id, true)} disabled={savingM}>✓ Yes</button>
                          <button className="btn btn-sm flex-1" onClick={() => logBoolean(m.id, false)} disabled={savingM}>✗ No</button>
                        </div>
                      ) : (
                        <div className="flex gap-2 mt-1.5">
                          <input type="number" step="any" className="input !py-1.5 !text-xs flex-1" placeholder={`Value (${m.unit || '…'})`}
                            value={mLog[m.id]?.value ?? ''} onChange={(e) => setMLog((x) => ({ ...x, [m.id]: { ...x[m.id], value: e.target.value } }))} />
                          <input type="date" className="input !py-1.5 !text-xs" value={mLog[m.id]?.date || ''}
                            onChange={(e) => setMLog((x) => ({ ...x, [m.id]: { ...x[m.id], date: e.target.value } }))} />
                          <button className="btn btn-sm shrink-0" onClick={() => logEntry(m.id)} disabled={savingM}>Log</button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {!metrics.data?.metrics?.length && <div className="text-center text-xs text-mute py-3">No personal metrics yet — create your first one above (e.g. waist, steps, bench press).</div>}
              </div>
            </div>
          </div>
        );

      case 'coach':
        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />
            {/* adherence breakdown */}
            <div className="card p-4">
              <div className="t-micro mb-3">This week</div>
              <AdherenceBreakdown components={data.adherenceComponents} />
            </div>
            {/* coach message */}
            <div className="rounded-2xl p-4" style={{ background: 'var(--accent-soft)', border: '1px solid var(--line)' }}>
              <div className="text-[10px] uppercase tracking-wider text-ember font-grotesk mb-1.5">Coach message</div>
              <p className="text-sm leading-relaxed">{data.coachMessage}</p>
            </div>
            {/* coach preferences */}
            <div className="card p-4">
              <div className="t-micro">Coach preferences</div>
              <p className="text-[10.5px] mt-0.5 mb-3 leading-snug" style={{ color: 'var(--faint)' }}>
                What the coach knows about you before it writes anything. Fill in what's
                true — every one of these changes the plans you get.
              </p>

              <div className="space-y-4">
                {COACH_FIELDS.map((f) => (
                  <CoachField
                    key={f.key}
                    field={f}
                    value={coachPrefs[f.key]}
                    onChange={(v) => setCoachPrefs((p) => ({ ...p, [f.key]: v }))}
                  />
                ))}
              </div>

              <button className="btn-primary w-full mt-4" style={{ minHeight: 48 }}
                      disabled={savingPrefs2} onClick={async () => {
                setSavingPrefs2(true);
                try {
                  // SEND THE EMPTIES TOO. This filtered them out, so clearing
                  // a preference never reached the server -- and the server has
                  // always treated an empty value as "delete this row" (see
                  // PUT /intel/coach/memory). You could set a preference and
                  // never un-set it; it simply came back on reload. Harmless
                  // now, visible the moment chips let you tap a choice off.
                  const entries = COACH_FIELDS.map(({ key }) => ({
                    key,
                    value: typeof coachPrefs[key] === 'string' ? coachPrefs[key].trim() : (coachPrefs[key] ?? ''),
                  }));
                  await api('/intel/coach/memory', { method: 'PUT', body: JSON.stringify({ entries }) });
                  coachMem.reload({ silent: true });
                  setToast('Coach preferences saved');
                } catch (e) { setToast(e.message); }
                setSavingPrefs2(false);
              }}>{savingPrefs2 ? 'Saving…' : 'Save coach preferences'}</button>
            </div>
            {/* messages -- a real human-trainer thread (POST /messages),
                distinct from the AI "Coach Brief"/"Coach preferences" above.
                Gated on having a trainer at all: an independent client's
                org has no trainer to receive it, so the composer would send
                into a void. Gating on trainerId directly (rather than an
                "is independent" flag) also correctly covers a gym client
                who simply hasn't been assigned a trainer yet. `c` here is
                /tracking/me/home's camelCase client object (via ClientLayout's
                outlet context), not /me/profile's raw snake_case row -- see
                tracking.js, where trainerId was added alongside this. */}
            {c.trainerId ? (
              <div className="card p-4">
                <div className="t-micro mb-3">Message your coach</div>
                <div className="h-44 overflow-y-auto space-y-2 pr-1 mb-3">
                  {(msgs || []).map((m) => {
                    const mine = m.from_name === c.name || m.mine;
                    return (
                      <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-[13px] ${mine ? 'bg-gradient-to-br from-ember/25 to-gold/15 border border-gold/30 rounded-br-md' : 'bg-tint/[.05] border border-line rounded-bl-md'}`}>
                          {!mine && <div className="text-[9px] text-mute font-grotesk mb-0.5">{m.from_name}</div>}
                          <div>{m.body}</div>
                          <div className="text-[8px] text-faint mt-1 font-grotesk">{new Date(m.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                      </div>
                    );
                  })}
                  {!msgs?.length && <div className="text-center text-xs text-mute py-6">No messages yet — say hi to your coach.</div>}
                  <div ref={endRef} />
                </div>
                <div className="flex gap-2">
                  <input className="input flex-1" placeholder="Type a message…" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
                  <button className="btn-primary shrink-0" onClick={send} disabled={sending || !body.trim()}>Send</button>
                </div>
              </div>
            ) : (
              <div className="card p-4 text-center">
                <div className="t-micro mb-1.5">Training independently</div>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--mute)' }}>No human coach assigned — SK Coach above still tracks your data and gives you priorities.</p>
              </div>
            )}
          </div>
        );

      case 'dashboard': {
        /* The list is split into what IS on the home screen and what is
           not, rather than one list where hidden rows are just faded.
           A person editing this is answering two different questions --
           "what do I want to see" and "in what order" -- and ordering
           only has meaning for the cards that are actually shown. */
        const hiddenCards = DASH_CARDS.filter((cd) => hidden.includes(cd.key));
        const isDefault =
          visibleCards.length === DEFAULT_ORDER.length
          && visibleCards.every((k, i) => k === DEFAULT_ORDER[i]);

        const Row = ({ cd, shown, index, total }) => (
          <div
            className="flex items-start gap-2 rounded-xl border border-line px-3 py-2.5"
            style={{ background: shown ? 'var(--bg2)' : 'transparent', opacity: shown ? 1 : 0.6 }}
          >
            {shown && (
              /* REAL, NON-OVERLAPPING TARGETS. These were 16px-tall glyphs
                 wearing `.tap-target`, whose -12px inset expands the hit
                 area 12px in every direction: stacked 16px apart, the two
                 arrows' expanded areas overlapped, and the lower one --
                 painted last, so on top -- swallowed every click aimed at
                 the upper. On the last row that lower button is disabled,
                 so "move up" did nothing at all. Caught by clicking it.
                 They are now 30px tall and claim only their own box. */
              <div className="flex flex-col gap-px shrink-0">
                <button
                  type="button"
                  className="rounded-md text-[13px] leading-none h-[30px] w-7 grid place-items-center transition-colors disabled:opacity-20"
                  style={{ color: 'var(--mute)', background: 'var(--line)' }}
                  onClick={() => move(cd.key, -1)} disabled={index === 0}
                  aria-label={`Move ${cd.label} up`}
                >↑</button>
                <button
                  type="button"
                  className="rounded-md text-[13px] leading-none h-[30px] w-7 grid place-items-center transition-colors disabled:opacity-20"
                  style={{ color: 'var(--mute)', background: 'var(--line)' }}
                  onClick={() => move(cd.key, 1)} disabled={index === total - 1}
                  aria-label={`Move ${cd.label} down`}
                >↓</button>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{cd.label}</div>
              <div className="text-[10.5px] leading-snug mt-0.5" style={{ color: 'var(--faint)' }}>{cd.desc}</div>
            </div>
            <button
              onClick={() => setHidden((h) => (shown ? [...h, cd.key] : h.filter((x) => x !== cd.key)))}
              className={`tap-target chip !text-[10px] shrink-0 ${shown ? '!border-line text-mute' : '!border-good/40 !text-good'}`}
              aria-label={`${shown ? 'Hide' : 'Show'} ${cd.label} on your home screen`}
            >
              {shown ? 'Hide' : 'Show'}
            </button>
          </div>
        );

        return (
          <div className="space-y-4 anim-fadeUp">
            <BackButton onClick={goBack} />
            <div className="card p-4">
              <div className="t-micro">My home screen</div>
              <p className="text-[11px] leading-snug mt-1" style={{ color: 'var(--mute)' }}>
                Choose which cards appear on Home and the order they appear in.
                Cards still only show when there is something to put in them.
              </p>

              <div className="space-y-1.5 mt-3">
                {visibleCards.map((key, i) => {
                  const cd = DASH_CARDS.find((x) => x.key === key);
                  return cd ? <Row key={key} cd={cd} shown index={i} total={visibleCards.length} /> : null;
                })}
                {!visibleCards.length && (
                  <div className="rounded-xl border border-line px-3 py-4 text-center">
                    <div className="text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>Nothing on your home screen</div>
                    <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>
                      Turn a card back on below.
                    </div>
                  </div>
                )}
              </div>

              {hiddenCards.length > 0 && (
                <>
                  <div className="t-micro mt-4 mb-1.5">Hidden</div>
                  <div className="space-y-1.5">
                    {hiddenCards.map((cd) => <Row key={cd.key} cd={cd} shown={false} index={0} total={1} />)}
                  </div>
                </>
              )}

              <div className="flex gap-2 mt-4">
                <button className="btn-primary flex-1" onClick={savePrefs} disabled={savingPrefs}>
                  {savingPrefs ? 'Saving…' : 'Save layout'}
                </button>
                <button className="btn" onClick={resetDash} disabled={isDefault || savingPrefs}>
                  Reset
                </button>
              </div>
              <p className="text-[10px] mt-2" style={{ color: 'var(--faint)' }}>
                Home picks up your layout as soon as you open it.
              </p>
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  };

  // ── Main Profile View ──

  return (
    <div className="space-y-4">
      {toast && <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 rounded-xl border border-gold/40 px-4 py-2 text-sm shadow-card anim-fadeUp" style={{ background: 'var(--panel)', color: 'var(--ink)' }}>{toast}</div>}

      {/* Profile header — always visible */}
      <div data-tour="profile-header" className="card p-5 flex items-center gap-4">
        {/* Avatar with photo menu */}
        <div className="relative shrink-0">
          <button onClick={() => setAvatarMenuOpen(!avatarMenuOpen)} className="w-14 h-14 rounded-full grid place-items-center font-grotesk font-bold text-lg border transition-all hover:scale-105 active:scale-95" style={{ background: (localAvatar || c.avatar) ? 'none' : 'linear-gradient(135deg, var(--accent-soft), rgba(200,169,138,.08))', borderColor: 'var(--line)', overflow: 'hidden' }} title="Change profile photo">
            {(localAvatar || c.avatar) ? (
              <img src={localAvatar || c.avatar} alt="Profile" className="w-full h-full object-cover" />
            ) : (
              <span>{c.name[0]}</span>
            )}
          </button>
          {/* X/remove button when photo exists */}
          {(localAvatar || c.avatar) && (
            <button onClick={(e) => { e.stopPropagation(); setRemoveConfirmOpen(true); }} className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full grid place-items-center text-[8px] font-bold border transition-all hover:scale-110" style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--mute)' }} title="Remove photo"><XIcon /></button>
          )}
          {/* Photo menu */}
          {avatarMenuOpen && (
            /* All three rows here set their hover with an inline handler
               assigning `var(--surfaceHover)` — a token that does not exist
               anywhere in theme.css. `background: var(--<undefined>)` is an
               invalid declaration, so it was dropped: this menu has had NO
               hover feedback at all, on any row, since it was written. The
               icons were also emoji (📷 / 🖼️), the only two left in the
               client app after the nav and popup passes. */
            <div className="absolute top-full left-0 mt-2 z-30 overflow-hidden anim-scaleIn"
              role="menu"
              style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', boxShadow: 'var(--e-3)', minWidth: 168 }}>
              <button role="menuitem" onClick={() => { setAvatarMenuOpen(false); document.getElementById('avatar-camera').click(); }} className="menu-row">
                <span className="menu-icon"><Icon name="camera" size={16} /></span>
                Camera
              </button>
              <button role="menuitem" onClick={() => { setAvatarMenuOpen(false); document.getElementById('avatar-gallery').click(); }} className="menu-row">
                <span className="menu-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
                  </svg>
                </span>
                Gallery
              </button>
              <button role="menuitem" onClick={() => setAvatarMenuOpen(false)} className="menu-row" style={{ borderTop: '1px solid var(--line)', color: 'var(--mute)' }}>
                <span className="menu-icon" />
                Cancel
              </button>
            </div>
          )}
        </div>
        {/* Hidden file inputs */}
        {/* Named even though they are visually hidden: a screen reader can
            still land on a `display:none`-adjacent input in some modes,
            and "file upload, blank" is not an answer to what it does. */}
        <input id="avatar-camera" aria-label="Take a profile photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden" onChange={handleAvatarUpload} />
        <input id="avatar-gallery" aria-label="Choose a profile photo from your device" type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleAvatarUpload} />
        {/* Remove photo confirmation */}
        {removeConfirmOpen && (
          <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) setRemoveConfirmOpen(false); }} style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}>
            <div className="w-full max-w-xs rounded-2xl p-5 anim-scaleIn" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
              <div className="text-center mb-4">
                <div className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>Remove profile photo?</div>
                <div className="text-[11px] mt-1" style={{ color: 'var(--mute)' }}>Your initial letter will be shown instead.</div>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setRemoveConfirmOpen(false)} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-semibold" style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--mute)' }}>Cancel</button>
                <button onClick={handleRemoveAvatar} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold" style={{ background: 'var(--bad)', color: '#fff' }}>Remove</button>
              </div>
            </div>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-display font-bold text-lg" style={{ color: 'var(--ink)' }}>{c.name}</div>
          {/* `c.height_cm` never existed on this object -- the API sends
              heightCm -- so the height segment silently never rendered.
              Each fact is also dropped when absent rather than leaving a
              stray separator behind. */}
          <div className="text-xs" style={{ color: 'var(--mute)' }}>
            {[
              GOAL_LABEL[c.goal] || String(c.goal || '').replace(/_/g, ' ').toLowerCase(),
              c.currentWeight ? units.fmtWeight(c.currentWeight) : null,
              c.heightCm ? units.fmtHeight(c.heightCm) : null,
              c.age ? `${c.age} yrs` : null,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        {/* A ring label is a glance, not a readout: "25.2%" spends two
            characters on precision nobody acts on. Absent adherence shows
            a dash rather than an empty "%" -- see the NaN fix in
            services/adherence.js for how that used to happen. */}
        <Ring
          value={data.adherence ?? 0}
          max={100}
          size={72}
          stroke={7}
          color={data.adherence == null ? 'var(--line)' : undefined}
          label={(
            <span className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>
              {data.adherence == null ? '—' : `${Math.round(data.adherence)}%`}
            </span>
          )}
          sub={<span className="text-[7px]" style={{ color: 'var(--mute)' }}>adh.</span>}
        />
      </div>

      <JourneyHero client={c} />

      {/* Theme toggle */}
      <ThemeToggle />

      {/* Active section or section list */}
      {activeSection === 'help' ? (
        <div className="anim-fadeUp">
          <BackButton onClick={() => setActiveSection(null)} />
          <HelpInline />
        </div>
      ) : activeSection ? (
        renderSection(activeSection)
      ) : (
        <div className="space-y-2 anim-fadeUp">
          {PROFILE_SECTIONS.map((section) => (
            <button
              key={section.id}
              onClick={() => {
                /* A row with an href goes somewhere real instead of
                   opening a panel here -- which is how "My Metrics" came
                   to be a second, weaker version of the Measurements
                   screen that already existed on Progress. */
                if (section.href) { nav(section.href); return; }
                if (section.id === 'help') { nav('/app/client/help'); return; }
                if (section.id === 'nutrition-tracker') { nav('/app/client/nutrition-tracker'); return; }
                setActiveSection(section.id);
              }}
              className="w-full card p-4 flex items-center gap-4 text-left hover:border-gold/40 transition-colors group"
            >
              <span className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name={section.icon} size={22} /></span>
              <div className="flex-1 min-w-0">
                <div className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>{section.label}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>{section.desc}</div>
              </div>
              <svg className="w-4 h-4 group-hover:text-gold transition-colors shrink-0" viewBox="0 0 16 16" fill="none" stroke="var(--faint)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 3L11 8L6 13" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
