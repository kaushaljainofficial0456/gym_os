import { useState } from 'react';
import Icon from '../../components/Icon.jsx';

const HELP_SECTIONS = [
  {
    id: 'overview',
    icon: 'home',
    title: 'How Barbell Works',
    content: 'Barbell is your personal fitness operating system. It connects you with your coach, tracks your workouts, nutrition, and progress — all in one place. Think of it as your fitness command center.',
    items: [
      'Your coach designs personalized workout and nutrition plans',
      'You track your daily activities — workouts, meals, sleep',
      'Barbell analyzes your data and provides insights',
      'Your coach gets real-time updates on your progress',
    ]
  },
  {
    id: 'home',
    icon: 'chart',
    title: 'Using the Home Page',
    content: 'Your Home page is the dashboard overview. It shows your daily status at a glance.',
    items: [
      'See your greeting and daily summary',
      "Check today's workout session",
      'View your macro progress (protein, carbs, fat)',
      'Monitor gym crowd levels',
      'Quick access to all major features',
    ]
  },
  {
    id: 'workouts',
    icon: 'strength',
    title: 'How Workouts Work',
    content: 'Your coach assigns structured workout plans. Each workout has exercises with sets, reps, and weights.',
    items: [
      'Open a workout to see all exercises for the day',
      'Complete exercises one by one',
      'Log your actual weights and reps for each set',
      'The timer helps you track rest between sets',
      'Complete all exercises to finish the session',
    ]
  },
  {
    id: 'sets',
    icon: 'note',
    title: 'How to Log Sets',
    content: 'Logging sets accurately helps your coach understand your progress and adjust your plan.',
    items: [
      'Tap on a set to mark it complete',
      'Enter the weight you actually used',
      'Enter the reps you completed',
      'The app compares planned vs. actual performance',
      'Rest timer starts automatically after each set',
    ]
  },
  {
    id: 'nutrition',
    icon: 'food',
    title: 'How Nutrition Works',
    content: 'Your nutrition plan is designed by your coach based on your goals — fat loss, muscle gain, or recomposition.',
    items: [
      'View your daily meal plan with assigned foods',
      'Mark meals as eaten when you complete them',
      'Use "Ask Barbell" to quickly log foods ("220g paneer")',
      'Scan nutrition labels for packaged foods',
      'Take a meal photo for estimated calorie ranges',
    ]
  },
  {
    id: 'calories',
    icon: 'numbers',
    title: 'Food & Calorie Estimation',
    content: 'Barbell can estimate calories from multiple sources — typed input, label scans, and meal photos.',
    items: [
      'Type foods naturally: "2 rotis + 150g rice"',
      'Scan a packaged food label for instant recognition',
      'Take a meal photo for an estimated calorie range',
      'All estimates are approximate — review before logging',
      'Exact tracking uses the SK food database',
    ]
  },
  {
    id: 'progress',
    icon: 'trending',
    title: 'Progress Tracking',
    content: 'Track your body transformation over time with weight, measurements, and photos.',
    items: [
      'Log your weight regularly on the Progress page',
      'View weight trends over time with charts',
      'Track body measurements (waist, chest, arms, etc.)',
      'Upload transformation photos (front, side, back)',
      'See your adherence score based on completed workouts and meals',
    ]
  },
  {
    id: 'coach',
    icon: 'robot',
    title: 'Coach & Intelligence Features',
    content: 'Barbell has an intelligent coach system that provides insights and recommendations.',
    items: [
      'Your Coach Brief shows daily priorities and insights',
      'Weekly reviews summarize what went well and needs attention',
      'Ask Barbell natural language questions about your fitness',
      'The coach adapts recommendations based on your data',
      'Message your coach directly from the Profile page',
    ]
  },
  {
    id: 'profile',
    icon: 'user',
    title: 'Profile & Settings',
    content: 'Manage your profile, goals, and preferences from the profile menu.',
    items: [
      'Update your goals, target weight and target date',
      'Set your experience level and equipment preferences',
      'Choose which cards appear on your home screen, and in what order (Profile → Home Screen)',
      'Switch between metric and imperial units — kg/cm or lb/ft-in (Settings → Units)',
      'Pick a light or dark appearance, or follow your device (Settings → Appearance)',
      'Track personal metrics (waist, steps, bench press, etc.)',
      'Configure coach preferences for personalized training',
    ]
  },
  {
    id: 'measurements',
    icon: 'chart',
    title: 'Weight & Measurements',
    content: 'Your weight and body measurements are stored in metric and shown in whichever units you have chosen, so switching units never changes your data.',
    items: [
      'Log your weight from Progress — the figure follows straight through to your trend and your goal',
      'Record waist, chest, arms, thighs, hips and neck from the Measurements section',
      'Pick the date a set was measured, so an entry typed in late still lands on the right day',
      'Open the measurement history to correct a reading, clear a single figure, or delete an entry you did not mean to save',
      'Anything wildly outside the normal range is flagged before you save, in case a decimal slipped',
    ]
  },
  {
    id: 'membership',
    icon: 'card',
    title: 'Membership & Payments',
    content: 'Your membership page shows the plan you are on at your gym, when it started, when it renews or expired, and everything you have been charged.',
    items: [
      'See your current plan and its real status',
      'Renew an expired or expiring membership',
      'Review every payment, with its amount, date and status',
      'A receipt number appears only where your gym has actually issued one',
      'If a charge looks wrong, your gym is the place to ask — they hold the billing record',
    ]
  },
  {
    id: 'community',
    icon: 'users',
    title: 'Community & Privacy',
    content: 'Your gym’s community shows workouts, personal records and streaks. You control what other members can see of yours.',
    items: [
      'Choose who sees your personal records: everyone at the gym, only your followers, or nobody',
      'Choose whether your feed shows everyone or only people you follow',
      'Both settings live in Settings → Privacy, and in the Community page itself',
      'Your weight, measurements, food log, sleep, recovery and wearable data are never shared with the community',
      'Sharing a workout is always something you do deliberately — nothing is posted for you',
    ]
  },
  {
    id: 'wearables',
    icon: 'trending',
    title: 'Wearables & Health Data',
    content: 'Connecting a wearable lets Barbell combine what it measures with your logged workouts for a fuller picture of your day.',
    items: [
      'Connect or disconnect a device from Settings → Health Intelligence',
      'Your burn estimate works without a wearable — Barbell models it from your profile and your logged sessions',
      'Every figure says where it came from, so you can tell a measured number from an estimate',
      'Disconnecting a device stops new data; what was already recorded stays in your history',
    ]
  },
];

/* Searches the sections above and nothing else.
 *
 * There is no help backend, and a box that posts a query somewhere and
 * shrugs would be exactly the fake control section 65 rules out. This
 * searches the real local content -- titles, the paragraph, and every
 * bullet -- so a result is always a section that genuinely says
 * something about the query, and the matching bullets are surfaced
 * rather than making the reader open the section and hunt. */
/* Words that carry no signal in a six-word question. Without dropping
   them, "who sees my records" fails: the section says "who sees your
   personal records", and requiring "my" to appear excludes the exact
   topic the reader was asking for. */
const STOPWORDS = new Set(['a', 'an', 'the', 'my', 'me', 'i', 'is', 'are', 'do', 'does', 'to', 'of', 'in', 'on', 'for', 'how', 'can', 'what', 'and', 'it']);

function matchSections(query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const all = q.split(/\s+/).filter(Boolean);
  // Keep the stopwords if that is genuinely all they typed.
  const terms = all.filter((t) => !STOPWORDS.has(t));
  const useful = terms.length ? terms : all;

  return HELP_SECTIONS
    .map((s) => {
      // Matched against the WHOLE section, so terms spread across the
      // title, the intro and a bullet still count as one answer -- a
      // real question rarely lands entirely inside one sentence.
      const whole = [s.title, s.content, ...s.items].join(' ').toLowerCase();
      if (!useful.every((t) => whole.includes(t))) return null;
      const inTitle = useful.some((t) => s.title.toLowerCase().includes(t));
      const inBody = useful.some((t) => s.content.toLowerCase().includes(t));
      // Bullets that carry at least one of the terms are worth surfacing.
      const items = s.items.filter((i) => useful.some((t) => i.toLowerCase().includes(t)));
      return { section: s, items, score: (inTitle ? 2 : 0) + (inBody ? 1 : 0) + (items.length ? 1 : 0) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

export default function Help() {
  const [expanded, setExpanded] = useState(null);
  const [query, setQuery] = useState('');
  const results = matchSections(query);
  // While searching, the list IS the results -- an accordion of every
  // section with three of them highlighted is not an answer.
  const shown = results ? results.map((r) => r.section) : HELP_SECTIONS;
  const matchedItems = new Map((results || []).map((r) => [r.section.id, r.items]));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display font-bold text-2xl tracking-tight" style={{ color: 'var(--ink)' }}>Help</h1>
        <div className="text-xs mt-0.5" style={{ color: 'var(--mute)' }}>Your guide to using Barbell</div>
      </div>

      <div className="card p-3">
        <label className="block">
          <span className="sr-only">Search help</span>
          <input
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setExpanded(null); }}
            placeholder="Search help — try “log a set” or “units”"
            aria-label="Search help"
            className="input w-full text-[13px]"
            style={{ minHeight: 44 }}
          />
        </label>
        {results && (
          <div className="mt-2 text-[11px]" style={{ color: 'var(--faint)' }}>
            {results.length
              ? `${results.length} ${results.length === 1 ? 'topic' : 'topics'} match “${query.trim()}”`
              : `Nothing here mentions “${query.trim()}”. Your coach can help with anything this guide doesn't cover.`}
          </div>
        )}
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl grid place-items-center border" style={{ background: 'linear-gradient(135deg, rgb(var(--accent-deep-rgb) / .2), rgb(var(--accent-rgb) / .1))', borderColor: 'var(--line)' }}>

          </div>
          <div className="flex-1">
            <div className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>Welcome to Barbell</div>
            <div className="text-[11px]" style={{ color: 'var(--mute)' }}>Tap any section below to learn more</div>
          </div>
        </div>
        {/* Replay of the guided first-run tour (AppTour). Dispatches an event
            that ClientLayout listens for — same activation path as the
            automatic post-onboarding start, so behaviour stays identical. */}
        <button
          onClick={() => window.dispatchEvent(new Event('sk-os:start-tour'))}
          className="w-full py-2.5 rounded-xl font-grotesk text-[12px] font-bold transition-all active:scale-[.97]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent)' }}
        >
          Replay app tour
        </button>
      </div>

      {shown.map((section) => (
        <div key={section.id} className="card overflow-hidden">
          <button
            onClick={() => setExpanded(expanded === section.id ? null : section.id)}
            className="w-full flex items-center gap-3 p-4 text-left transition-colors"
            style={{ color: 'var(--ink)' }}
          >
            <span className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name={section.icon} size={20} /></span>
            <span className="flex-1 min-w-0">
              <span className="font-grotesk font-bold text-sm block">{section.title}</span>
            </span>
            <span className="text-lg transition-transform duration-200" style={{ color: 'var(--mute)', transform: expanded === section.id ? 'rotate(45deg)' : 'none' }}>+</span>
          </button>

          {/* The lines that actually matched, shown without opening the
              section -- otherwise a search result is just a title and the
              reader still has to go looking. */}
          {results && expanded !== section.id && (matchedItems.get(section.id) || []).length > 0 && (
            <div className="px-4 pb-3 -mt-1 space-y-1.5">
              {(matchedItems.get(section.id) || []).slice(0, 3).map((item, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="text-[10px] mt-1 shrink-0" style={{ color: 'var(--accent)' }}>•</span>
                  <span className="text-[12px] leading-relaxed" style={{ color: 'var(--mute)' }}>{item}</span>
                </div>
              ))}
            </div>
          )}

          {expanded === section.id && (
            <div className="px-4 pb-4 border-t border-line/40 pt-3 anim-fadeUp">
              <p className="text-[13px] leading-relaxed mb-3" style={{ color: 'var(--mute)' }}>{section.content}</p>
              <div className="space-y-2">
                {section.items.map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className="text-gold text-xs mt-0.5 shrink-0">•</span>
                    <span className="text-[12px] leading-relaxed" style={{ color: 'var(--mute)' }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      <div className="card p-5 text-center">
        <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium mb-2" style={{ color: 'var(--mute)' }}>Need more help?</div>
        <div className="text-xs" style={{ color: 'var(--mute)' }}>
          Contact your coach through the Profile → Messages section for personalized support.
        </div>
      </div>
    </div>
  );
}
