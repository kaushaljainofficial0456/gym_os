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
 *
 * WHAT THIS PASS FIXED, because the tour was actively working against
 * itself:
 *
 *   ✕ MEANT "NEXT". The close button advanced the tour. Everywhere else
 *   in software ✕ means dismiss, so the one control a person reaches for
 *   to GET OUT was the one that kept them in -- through seventeen steps,
 *   with the real exit a small grey "Skip Tour" link. ✕ now exits, and
 *   moving on is an explicit Next button.
 *
 *   NO WAY BACK. There was no Back control at all: miss something and
 *   your only option was to finish and replay the whole thing.
 *
 *   THE PROFILE STEP APPEARED TWICE. buildSteps pushed it explicitly AND
 *   included it as CLIENT_STEPS[0], so clients saw the same card at
 *   position 2 and again at position 4.
 *
 *   SEVENTEEN STEPS OF NARRATION. Each one described what a piece of UI
 *   contains, which is what a person can already see. The client tour is
 *   now the handful of things that are NOT obvious -- what to do first,
 *   where the non-obvious tools live -- and each card says what you can
 *   DO, not what is on screen.
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
  title: 'A quick look around',
  body: 'Six short stops covering the things that are not obvious. About thirty seconds — and you can leave at any point with the ✕.',
};

/** A real ending, rather than stopping dead on the last anchored step. */
const OUTRO_STEP = {
  title: "That's the tour",
  body: 'Everything else is where you would expect it. You can replay this any time from Help.',
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
    target: '[data-tour="home-hero"]',
    title: 'Start here each day',
    body: "Home opens on today's session. Start workout begins live tracking — you tick off each set with what you actually lifted, and it works out volume, duration and calories from that.",
    placement: 'bottom',
  },
  {
    route: '/app/client/nutrition',
    target: '[data-tour="nutrition-tools"]',
    title: 'Logging food is the quick bit',
    body: 'Search a food, scan a barcode, speak it, or photograph a plate and let the AI estimate it. Anything you eat often can be saved once and re-logged in a tap.',
    placement: 'bottom',
  },
  {
    route: '/app/client/workout',
    target: '[data-tour="workout-actions"]',
    title: 'Build your own sessions',
    body: 'My Workout stores sessions you reuse and your weekly plan. Build Today picks exercises for a one-off. Trained without the app? You can log that session afterwards.',
    placement: 'bottom',
  },
  {
    route: '/app/client/progress',
    target: '[data-tour="progress-weight"]',
    title: 'One number, most days',
    body: 'Log your weight here. Charts, trends and your measurement history build themselves from it — the app only needs the number.',
    placement: 'bottom',
  },
  {
    route: '/app/client',
    target: '[data-tour="header-profile"]',
    title: 'Your settings live here',
    body: 'Your avatar, top-left, opens Profile, Measurements, Goals, Settings and Sign out — including your equipment and dashboard preferences.',
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
    // NOTE: the profile step lives in CLIENT_STEPS and nowhere else. It
    // used to be pushed here as well, so the same card showed twice.
    steps.push(NAV_STEP, ...CLIENT_STEPS);
  } else if (isTrainer || isOwner) {
    steps.push(
      TRAINER_NAV_STEP,
      ...TRAINER_STEPS,
    );
    if (isOwner) steps.push(...OWNER_STEPS);
  }

  steps.push(OUTRO_STEP);
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
  const next = () => { if (!last) setIdx(idx + 1); else finish(); };
  const back = () => { if (idx > 0) setIdx(idx - 1); };
  // ✕ exits, as it does everywhere else. Leaving early still counts as
  // done -- re-showing a tour someone deliberately dismissed is how a
  // first-run experience becomes an irritant.
  const dismiss = finish;

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

  /* Keyboard. A full-screen overlay that traps you with no Escape is the
     most frustrating shape a modal can take, and this one covered the
     entire app. */
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, idx, last]);

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
    // Clamping to vh-150 could drag the card back UP over the very
    // element it is describing when the anchor sits low on the screen.
    // Never let the clamp push it above the spotlight's bottom edge.
    const floor = placeBelow ? Math.max(rect.bottom + 12, vh - 150) : vh - 150;
    cardStyle = { top: Math.min(top, floor), left };
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
            onClick={dismiss}
            aria-label="Close tour"
            title="Close tour"
            className="w-9 h-9 rounded-full grid place-items-center shrink-0 transition-all active:scale-90"
            style={{ border: '1px solid var(--line)', color: 'var(--mute)' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <h3 className="font-grotesk font-bold text-[15px] leading-snug" style={{ color: 'var(--ink)' }}>
          {step.title}
        </h3>
        <p className="text-[12.5px] leading-relaxed mt-1.5" style={{ color: 'var(--mute)' }}>
          {step.body}
        </p>

        {/* Footer: real Back / Next controls. Moving through the tour was
            previously only possible via the ✕, which is also the one
            control that should have got you out of it. */}
        <div className="mt-3.5 pt-3 flex items-center gap-2" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="flex items-center gap-1 flex-1" aria-hidden="true">
            {steps.map((_, i) => (
              <span
                key={i}
                className="rounded-full transition-all duration-300"
                style={{
                  width: i === idx ? 12 : 4,
                  height: 4,
                  background: i === idx ? 'var(--accent)' : 'var(--line)',
                }}
              />
            ))}
          </div>
          {idx > 0 && (
            <button
              onClick={back}
              className="font-grotesk text-[11.5px] font-semibold px-3 rounded-xl transition-all active:scale-95"
              style={{ minHeight: 38, border: '1px solid var(--line)', color: 'var(--mute)' }}
            >
              Back
            </button>
          )}
          <button
            onClick={next}
            className="font-grotesk text-[11.5px] font-bold px-4 rounded-xl transition-all active:scale-95"
            style={{
              minHeight: 38,
              background: 'var(--cta-solid)',
              border: '1px solid var(--cta-edge)',
              color: 'var(--cta-ink)',
            }}
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
