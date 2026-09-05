import Icon from './Icon.jsx';

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

/* Icons were '🏠' '💪' '🥗' '📈' — literal emoji. Four problems, all real:
   they render as a different artwork on every OS (and as a colour photo on
   most, next to a monochrome accent-tinted interface), they can't be tinted
   to the palette, they don't scale with the type ramp, and the bottom nav
   already ships an SVG for each of these four destinations — so the popup
   introducing a tab showed a different icon than the tab it introduced.
   These now reuse the exact icon each nav item uses. */
const FEATURES = {
  home: {
    title: 'Home',
    description: 'Your day at a glance — today\'s session, how your eating is tracking, and where you are against your goal.',
    icon: 'home',
  },
  workout: {
    title: 'Workout',
    description: 'Follow your programme, log the weight and reps you actually hit, and time your rests.',
    icon: 'strength',
  },
  nutrition: {
    title: 'Nutrition',
    description: 'Log meals in a few taps and watch your calories and macros against target for the day.',
    icon: 'food',
  },
  progress: {
    title: 'Progress',
    description: 'Weight, measurements and adherence over time, so you can see the trend rather than one day\'s number.',
    icon: 'trending',
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
    <div className="scrim grid place-items-center p-4 anim-fadeIn" onClick={handleDismiss}
      role="dialog" aria-modal="true" aria-labelledby="feature-popup-title">
      <div className="sheet-centered w-full max-w-sm p-6 anim-scaleIn" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3.5 mb-5">
          <div className="w-11 h-11 grid place-items-center shrink-0"
            style={{ borderRadius: 'var(--r-md)', background: 'rgb(var(--accent-rgb) / .12)', color: 'var(--accent)' }}>
            <Icon name={feature.icon} size={21} />
          </div>
          <div className="min-w-0">
            <h3 id="feature-popup-title" className="t-card">{feature.title}</h3>
            <p className="t-sub mt-1.5">{feature.description}</p>
          </div>
        </div>
        <button onClick={handleDismiss} className="btn-primary btn-block" autoFocus>Got it</button>
      </div>
    </div>
  );
}

export { getSeenFeatures, markFeatureSeen, FEATURES };
