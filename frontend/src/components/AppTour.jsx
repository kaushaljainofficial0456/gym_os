/**
 * AppTour — guided first-run spotlight tour for EVERY new user entering Gym OS,
 * regardless of role.
 *
 * ARCHITECTURE:
 *   Steps are defined per-role (client, trainer, owner) with shared intro/outro
 *   steps. The component receives the user object and role flags from useAuth,
 *   builds the step list, and drives the tour.
 *
 * TRIGGER:
 *   For CLIENT/INDEPENDENT: mounted by ClientLayout after OnboardingWizard completes
 *   For TRAINER: mounted by TrainerLayout when localStorage 'sk-os-start-tour-next'
 *     is set (set by JoinGym.jsx after QR join + redirect)
 *   For GYM_OWNER: mounted by TrainerLayout when localStorage 'sk-os-start-tour-next'
 *     is set (set by EnterpriseOnboarding.jsx after payment + redirect)
 *
 * COMPLETION/SKIP:
 *   Stored per-user in localStorage (keyed by userId), so different accounts
 *   on the same device each get their own tour.
 *
 * MECHANICS:
 *   Each step optionally navigates to a route, then spotlights the real DOM
 *   element via its [data-tour] anchor. If the anchor is missing (data state,
 *   permissions, screen size), the card gracefully falls back to screen-center.
 *   The ✕ button advances to the next step (not exit). A separate "Skip Tour"
 *   exits the entire tour.
 */
import { useEffect, useState, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const STORAGE_KEY = 'sk-os-app-tour-done';

function readMap() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

/** Has this user already completed/skipped the tour on this device? */
export function isTourDone(userId) {
  return !!readMap()[String(userId || 'anon')];
}

function markTourDone(userId) {
  const m = readMap();
  m[String(userId || 'anon')] = true;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch { /* private mode */ }
}

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ════════════════════════════════════════════════════════════════
   STEP DEFINITIONS — grouped by role. Every description matches
   the CURRENT implementation. Anchors are added as data-tour
   attributes to the existing pages; nothing about the pages'
   behaviour changes.
   ════════════════════════════════════════════════════════════════ */

// Shared intro step (same for all roles)
const INTRO_STEP = {
  title: 'Welcome to Gym OS',
  body: 'Your training, nutrition and progress — all coached from one app. This quick tour shows you where everything lives. Tap ✕ to keep going, or Skip Tour anytime.',
};

// Shared navigation step
const NAV_STEP = {
  route: '/app/client',
  target: '[data-tour="bottom-nav"]',
  title: 'Getting around',
  body: 'Your main pages sit on this bar at the bottom of every screen.',
  placement: 'top',
};

// ─── CLIENT / INDEPENDENT STEPS ────────────────────────────────
const CLIENT_STEPS = [
  {
    route: '/app/client',
    target: '[data-tour="header-profile"]',
    title: 'Your profile menu',
    body: 'Tap your avatar top-left anytime to reach your Profile, Measurements, Goals, Settings and Sign out.',
    placement: 'bottom',
  },
  {
    route: '/app/client',
    target: '[data-tour="home-hero"]',
    title: "Today's workout",
    body: "Home opens on your session: today's workout name, focus muscles and exercise count. Hit Start workout to begin — or you'll see a Rest day card when nothing is scheduled.",
    placement: 'bottom',
  },
  {
    route: '/app/client',
    target: '[data-tour="home-fuel"]',
    title: 'Fuel today',
    body: 'The ring shows calories LEFT against your daily target, with protein, carbs and fat bars beside it — your eating at a glance.',
    placement: 'bottom',
  },
  {
    route: '/app/client/workout',
    target: '[data-tour="workout-week"]',
    title: 'This week',
    body: 'Your training week at the top. Tap any day to preview that session before you get to the gym.',
    placement: 'bottom',
  },
  {
    route: '/app/client/workout',
    target: '[data-tour="workout-actions"]',
    title: 'My workout tools',
    body: 'My Workout keeps reusable sessions and a weekly plan, Build Today picks exercises from the library for today, and My PR jumps to your records.',
    placement: 'bottom',
  },
  {
    route: '/app/client/workout',
    target: '[data-tour="workout-today"]',
    title: 'Start a session',
    body: "Today's prescription lists sets, reps and weights. START SESSION begins live tracking — tick off each set with what you actually lifted, then finish for volume, duration and a calorie-burn estimate.",
    placement: 'bottom',
  },
  {
    route: '/app/client/nutrition',
    target: '[data-tour="nutrition-hero"]',
    title: "Today's fuel",
    body: 'Your calorie ring and macro bars against the plan targets. The small pencil by the target lets you adjust your calorie goal.',
    placement: 'bottom',
  },
  {
    route: '/app/client/nutrition',
    target: '[data-tour="nutrition-meals"]',
    title: "Today's eaten meals",
    body: 'Everything you log lands here. Edit quantities, mark items eaten, and use Log / Estimate Food to add more.',
    placement: 'bottom',
  },
  {
    route: '/app/client/nutrition',
    target: '[data-tour="nutrition-tools"]',
    title: 'Food & meal tools',
    body: "Log / Estimate Food searches foods, scans barcodes, takes voice input and estimates with AI. Customize My Meals swaps your planned meals, and Meal Information explains what's on your plan.",
    placement: 'bottom',
  },
  {
    route: '/app/client/nutrition',
    target: '[data-tour="nutrition-water"]',
    title: 'Water & supplements',
    body: 'Tap the glasses to log water toward your daily goal. Your supplement checklist sits just above — tick each one as you take it.',
    placement: 'top',
  },
  {
    route: '/app/client/progress',
    target: '[data-tour="progress-weight"]',
    title: 'Log your weight',
    body: "Enter today's weight here. As history builds, weight trend and adherence charts appear automatically.",
    placement: 'bottom',
  },
  {
    route: '/app/client/progress',
    target: '[data-tour="progress-photos"]',
    title: 'Track the journey',
    body: 'Below your charts: measurements over time and private transformation photos, visible only to you and your coach.',
    placement: 'top',
  },
  {
    route: '/app/client/profile',
    target: '[data-tour="profile-header"]',
    title: 'Your profile',
    body: 'Your photo and name lead into sections for Goal & setup, Equipment, Metrics, Dashboard customization and messaging your coach.',
    placement: 'bottom',
  },
  {
    route: '/app/client/settings',
    target: '[data-tour="settings-account"]',
    title: 'Settings',
    body: 'Update your name and phone number here. Your email is fixed to keep the account secure.',
    placement: 'bottom',
  },
  {
    route: '/app/client/settings',
    target: '[data-tour="settings-security"]',
    title: 'Security',
    body: "Change your password anytime — you'll confirm your current one first.",
    placement: 'bottom',
  },
];

// ─── TRAINER STEPS ─────────────────────────────────────────────
const TRAINER_STEPS = [
  {
    route: '/app/trainer',
    target: '[data-tour="trainer-hamburger"]',
    title: 'Navigation menu',
    body: 'Tap the menu icon to access Dashboard, Clients, Workouts, Nutrition, Alerts, Reports and Messages.',
    placement: 'bottom',
  },
  {
    route: '/app/trainer',
    target: '[data-tour="trainer-dashboard-hero"]',
    title: 'Your dashboard',
    body: 'The headline shows how many clients need your attention today. This is your command center — the first thing you check each morning.',
    placement: 'bottom',
  },
  {
    route: '/app/trainer',
    target: '[data-tour="trainer-dashboard-kpis"]',
    title: 'Key metrics',
    body: 'Active clients, on-track count, needs-attention and at-risk clients at a glance. Tap any KPI card to dive deeper.',
    placement: 'bottom',
  },
  {
    route: '/app/trainer/clients',
    target: '[data-tour="trainer-clients-list"]',
    title: 'Client management',
    body: 'Search, filter by status, sort by adherence or weight change. Tap a client to see their full profile, workouts, nutrition and progress.',
    placement: 'bottom',
  },
  {
    route: '/app/trainer/clients',
    target: '[data-tour="trainer-clients-new"]',
    title: 'Add a new client',
    body: "Create a client account directly — they'll get their login and can start training immediately.",
    placement: 'bottom',
  },
  {
    route: '/app/trainer/workouts',
    target: '[data-tour="trainer-workouts-templates"]',
    title: 'Workout templates',
    body: 'Build reusable workout templates with exercises, sets, reps and rest times. Duplicate templates and assign to any client.',
    placement: 'bottom',
  },
  {
    route: '/app/trainer/workouts',
    target: '[data-tour="trainer-workouts-programs"]',
    title: 'Training programs',
    body: 'Assign a weekly split (PPL, Upper/Lower, Full Body) to a client — their workout page then serves the right session for each day automatically.',
    placement: 'bottom',
  },
  {
    route: '/app/trainer/nutrition',
    target: '[data-tour="trainer-nutrition-plans"]',
    title: 'Nutrition plans',
    body: 'Create calorie-targeted plans with realistic Indian meals — assign them to clients so their Nutrition page fills in automatically.',
    placement: 'bottom',
  },
];

// ─── OWNER/ADMIN EXTRA STEPS (appended after trainer steps) ────
const OWNER_STEPS = [
  {
    route: '/app/trainer/business',
    target: '[data-tour="trainer-business"]',
    title: 'Business management',
    body: 'Manage membership plans, pricing, and payment collection for your gym. Set up plans that clients purchase when they join.',
    placement: 'bottom',
  },
  {
    route: '/app/trainer/enterprise',
    target: '[data-tour="trainer-enterprise"]',
    title: 'Enterprise dashboard',
    body: 'Your SK OS subscription: package details, client capacity, QR onboarding codes, and billing. This is where you manage your gym\'s SK OS membership.',
    placement: 'bottom',
  },
];

// ─── TRAINER NAV STEP (sidebar-based, not bottom-nav) ──────────
const TRAINER_NAV_STEP = {
  route: '/app/trainer',
  target: '[data-tour="trainer-hamburger"]',
  title: 'Navigation menu',
  body: 'Tap the menu icon to open the sidebar with Dashboard, Clients, Workouts, Nutrition, Alerts, Reports and Messages.',
  placement: 'bottom',
};

/* ════════════════════════════════════════════════════════════════
   STEP BUILDER — assembles the final step array from role
   ════════════════════════════════════════════════════════════════ */
function buildSteps({ isClient, isIndependent, isTrainer, isOwner }) {
  const steps = [INTRO_STEP];

  if (isClient || isIndependent) {
    // Client & independent share the same client app layout
    steps.push(
      { route: '/app/client', target: '[data-tour="header-profile"]', title: 'Your profile menu', body: 'Tap your avatar top-left anytime to reach your Profile, Measurements, Goals, Settings and Sign out.', placement: 'bottom' },
      NAV_STEP,
      ...CLIENT_STEPS,
    );
  } else if (isTrainer || isOwner) {
    steps.push(
      TRAINER_NAV_STEP,
      ...TRAINER_STEPS,
    );
    if (isOwner) steps.push(...OWNER_STEPS);
  }

  return steps;
}

/* ════════════════════════════════════════════════════════════════
   COMPONENT
   ════════════════════════════════════════════════════════════════ */

export default function AppTour({ active, userId, onDone, isClient = false, isIndependent = false, isTrainer = false, isOwner = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState(null);     // spotlight rect when an anchor was found
  const [hasTarget, setHasTarget] = useState(false);

  // Build steps once from role flags
  const steps = useMemo(
    () => buildSteps({ isClient, isIndependent, isTrainer, isOwner }),
    [isClient, isIndependent, isTrainer, isOwner]
  );

  const step = steps[idx];
  const last = idx === steps.length - 1;

  const finish = () => { markTourDone(userId); onDone(); };
  // ✕ means "understood — continue", never "exit the tour".
  const next = () => { if (!last) setIdx(idx + 1); else finish(); };

  /* Route + spotlight engine. Deliberately keyed on [active, idx] only:
     the navigation WE trigger must not restart the step. */
  useEffect(() => {
    if (!active) return undefined;
    const s = steps[idx];
    let cancelled = false;
    let timer = null;

    setRect(null);
    setHasTarget(false);

    const measure = () => {
      if (cancelled) return;
      const el = s.target ? document.querySelector(s.target) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        setHasTarget(true);
      }
    };

    const begin = () => {
      if (cancelled) return;
      if (s.route && location.pathname !== s.route) navigate(s.route);
      let tries = 0;
      const poll = () => {
        if (cancelled) return;
        const el = s.target ? document.querySelector(s.target) : null;
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
          measure();
          // Keep re-measuring while the smooth scroll settles.
          let n = 0;
          const settle = () => {
            if (cancelled || n++ > 14) return;
            measure();
            timer = setTimeout(settle, 70);
          };
          timer = setTimeout(settle, 70);
        } else if (s.target && ++tries < 30) {
          timer = setTimeout(poll, 100); // lazy page still loading
        } else {
          setHasTarget(false); // centered fallback card, no fake highlight
        }
      };
      poll();
    };

    timer = setTimeout(begin, 60);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, idx]);

  // Reset index when tour becomes active (fresh start)
  useEffect(() => {
    if (active) setIdx(0);
  }, [active]);

  if (!active) return null;

  /* ── layout math ── */
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 7;                       // breathing room around the spotlight
  const cardW = Math.min(330, vw - 28);
  const CARD_H_EST = 216;              // estimate used only for flip/clamp decisions

  let spotlightStyle = null;
  let cardStyle = {};
  if (hasTarget && rect) {
    spotlightStyle = {
      position: 'fixed',
      top: rect.top - pad,
      left: rect.left - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
      borderRadius: 16,
      border: '1.5px solid var(--accent)',
      boxShadow: '0 0 0 6px rgba(var(--accent-rgb, 200,169,138), .12), 0 0 0 9999px rgba(4,4,6,.66)',
      transition: prefersReducedMotion() ? 'none' : 'all .38s cubic-bezier(.22,.8,.3,1)',
    };
    const spaceBelow = vh - rect.bottom;
    const placeBelow = step.placement !== 'top' ? spaceBelow >= CARD_H_EST + 24 : rect.top > CARD_H_EST + 24;
    const top = placeBelow ? rect.bottom + 12 : Math.max(12, rect.top - CARD_H_EST - 12);
    const left = Math.min(Math.max(rect.left + rect.width / 2 - cardW / 2, 12), vw - cardW - 12);
    cardStyle = { top: Math.min(top, vh - 150), left };
  } else {
    // Centered fallback (intro / outro / missing anchor)
    cardStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }

  return (
    <div className="anim-fadeIn" style={{ position: 'fixed', inset: 0, zIndex: 95 }}>
      {/* Dim for center-mode steps; the spotlight's huge box-shadow dims the
          rest of the page when an element is highlighted. */}
      {!spotlightStyle && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(4,4,6,.66)' }} />
      )}
      {spotlightStyle && <div style={spotlightStyle} className="anim-fadeIn" />}

      {/* Explanation card */}
      <div
        role="dialog"
        aria-label={`Tour step ${idx + 1} of ${steps.length}: ${step.title}`}
        className="anim-scaleIn"
        style={{
          position: 'fixed',
          width: cardW,
          maxHeight: vh - 40,
          overflowY: 'auto',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 18,
          boxShadow: '0 18px 50px rgba(0,0,0,.45), 0 0 24px rgba(var(--accent-rgb, 200,169,138), .08)',
          padding: '14px 16px 12px',
          ...cardStyle,
        }}
      >
        {/* Header: progress kicker + ✕ (✕ = continue, per spec) */}
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span
            className="font-grotesk text-[9.5px] uppercase tracking-[.18em] font-semibold"
            style={{ color: 'var(--faint)' }}
          >
            Gym OS Tour · {idx + 1} / {steps.length}
          </span>
          <button
            onClick={next}
            aria-label={last ? 'Finish tour' : 'Next tip'}
            className="w-8 h-8 rounded-full grid place-items-center shrink-0 transition-all active:scale-90"
            style={{
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              color: 'var(--accent)',
            }}
          >
            {last ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            )}
          </button>
        </div>

        <h3 className="font-grotesk font-bold text-[15px] leading-snug" style={{ color: 'var(--ink)' }}>
          {step.title}
        </h3>
        <p className="text-[12.5px] leading-relaxed mt-1.5" style={{ color: 'var(--mute)' }}>
          {step.body}
        </p>

        {/* Footer: Skip Tour (left) + progress dots */}
        <div className="flex items-center justify-between mt-3 pt-2.5" style={{ borderTop: '1px solid var(--line)' }}>
          <button
            onClick={finish}
            className="font-grotesk text-[10.5px] font-semibold px-2 py-1 rounded-lg transition-all active:scale-95"
            style={{ color: 'var(--mute)' }}
          >
            Skip Tour
          </button>
          <div className="flex items-center gap-1">
            {steps.map((_, i) => (
              <span
                key={i}
                className="rounded-full transition-all duration-300"
                style={{
                  width: i === idx ? 14 : 4,
                  height: 4,
                  background: i === idx ? 'var(--accent)' : 'var(--line)',
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
