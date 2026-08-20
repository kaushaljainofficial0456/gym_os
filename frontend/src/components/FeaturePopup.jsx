import { useState, useEffect } from 'react';

const STORAGE_KEY = 'sk-os-seen-features';

function getSeenFeatures() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch { return {}; }
}

function markFeatureSeen(id) {
  const seen = getSeenFeatures();
  seen[id] = true;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
}

const FEATURES = {
  home: {
    title: 'Home',
    description: 'Your personal fitness dashboard. See today\'s plan, recent activity, and quick actions at a glance.',
    icon: '🏠',
  },
  workout: {
    title: 'Workout',
    description: 'Track your exercises, log sets and reps, and follow your personalized training program.',
    icon: '💪',
  },
  nutrition: {
    title: 'Nutrition',
    description: 'Log your meals, track calories and macros, and stay on top of your nutrition goals.',
    icon: '🥗',
  },
  progress: {
    title: 'Progress',
    description: 'Visualize your journey with charts, track body measurements, and celebrate milestones.',
    icon: '📈',
  },
};

export default function FeaturePopup({ featureId, onClose }) {
  const feature = FEATURES[featureId];
  if (!feature) return null;

  // Check if already seen
  const seen = getSeenFeatures();
  if (seen[featureId]) return null;

  const handleDismiss = () => {
    markFeatureSeen(featureId);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center p-4 anim-fadeIn" onClick={handleDismiss} style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-sm rounded-2xl p-6 anim-scaleIn" style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--card-shadow)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <div className="w-12 h-12 rounded-xl grid place-items-center text-2xl shrink-0" style={{ background: 'var(--accent-soft)' }}>
            {feature.icon}
          </div>
          <div>
            <h3 className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>{feature.title}</h3>
            <p className="text-sm mt-1" style={{ color: 'var(--mute)' }}>{feature.description}</p>
          </div>
        </div>
        <button onClick={handleDismiss} className="w-full py-2.5 rounded-xl font-grotesk text-sm font-bold transition-all active:scale-[.97]" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
          Got it
        </button>
      </div>
    </div>
  );
}

export { getSeenFeatures, markFeatureSeen, FEATURES };
