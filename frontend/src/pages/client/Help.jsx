import { useState } from 'react';
import Icon from '../../components/Icon.jsx';

const HELP_SECTIONS = [
  {
    id: 'overview',
    icon: 'home',
    title: 'How SK OS Works',
    content: 'SK OS is your personal fitness operating system. It connects you with your coach, tracks your workouts, nutrition, and progress — all in one place. Think of it as your fitness command center.',
    items: [
      'Your coach designs personalized workout and nutrition plans',
      'You track your daily activities — workouts, meals, sleep',
      'SK OS analyzes your data and provides insights',
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
      'Use "Ask SK OS" to quickly log foods ("220g paneer")',
      'Scan nutrition labels for packaged foods',
      'Take a meal photo for estimated calorie ranges',
    ]
  },
  {
    id: 'calories',
    icon: 'numbers',
    title: 'Food & Calorie Estimation',
    content: 'SK OS can estimate calories from multiple sources — typed input, label scans, and meal photos.',
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
    content: 'SK OS has an intelligent coach system that provides insights and recommendations.',
    items: [
      'Your Coach Brief shows daily priorities and insights',
      'Weekly reviews summarize what went well and needs attention',
      'Ask SK OS natural language questions about your fitness',
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
      'Update your goals and target weight',
      'Set your experience level and equipment preferences',
      'Customize your dashboard layout',
      'Track personal metrics (waist, steps, bench press, etc.)',
      'Configure coach preferences for personalized training',
    ]
  },
];

export default function Help() {
  const [expanded, setExpanded] = useState(null);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display font-bold text-2xl tracking-tight" style={{ color: 'var(--ink)' }}>Help</h1>
        <div className="text-xs mt-0.5" style={{ color: 'var(--mute)' }}>Your guide to using SK OS</div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl grid place-items-center border" style={{ background: 'linear-gradient(135deg, rgba(10,138,133,.2), rgba(20,196,188,.1))', borderColor: 'var(--line)' }}>

          </div>
          <div>
            <div className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>Welcome to SK OS</div>
            <div className="text-[11px]" style={{ color: 'var(--mute)' }}>Tap any section below to learn more</div>
          </div>
        </div>
      </div>

      {HELP_SECTIONS.map((section) => (
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
