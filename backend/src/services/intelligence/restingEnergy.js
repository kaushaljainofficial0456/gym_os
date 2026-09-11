// ============================================================
// RESTING ENERGY + NON-EXERCISE MOVEMENT — the two energy components
// that are NOT workouts.
//
// Extracted from routes/me.js, which had the Mifflin-St Jeor formula
// inline for nutrition targets. It is now needed in a second place (the
// daily burn breakdown, which shows resting energy as its own line), and
// two copies of a body-energy formula that must agree is exactly how
// they silently stop agreeing. One formula, one file -- same discipline
// as frontend/src/healthProviderLabels.js.
//
// SCOPE BOUNDARY (important): this file computes RESTING energy (BMR)
// and NON-EXERCISE movement only. Workout energy comes from
// calorieModel.js (skos-cal-v1) or, when a wearable measured the
// session, straight from the wearable -- see
// services/health/reconciliation.js. Nothing here ever estimates a
// workout, and nothing here returns TDEE: a TDEE already contains an
// activity multiplier, so adding measured workouts to it would count the
// same effort twice. The daily total is composed as
// resting + active, never TDEE + active.
// ============================================================

/** Mifflin-St Jeor basal metabolic rate, kcal per 24h.
 *  Returns null when any input is missing -- an incomplete profile must
 *  produce "we don't know yet", never a fabricated number. */
export function mifflinStJeorBmr({ weightKg, heightCm, age, sex }) {
  const w = Number(weightKg); const h = Number(heightCm); const a = Number(age);
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(a)) return null;
  if (w <= 0 || h <= 0 || a <= 0) return null;
  const base = 10 * w + 6.25 * h - 5 * a;
  // Mifflin-St Jeor is only defined for male/female constants. An
  // unspecified/other sex uses the midpoint of the two (-78) rather than
  // defaulting to one of them, which would bias the figure by ~166 kcal.
  const s = String(sex || '').toUpperCase();
  if (s === 'MALE' || s === 'M') return base + 5;
  if (s === 'FEMALE' || s === 'F') return base - 161;
  return base - 78;
}

/** BMR for a PARTIAL day -- "resting energy so far today".
 *  Today's ring should not show a full 24h of resting burn at 9am. */
export function restingEnergyForSeconds(bmrPerDay, seconds) {
  if (!Number.isFinite(bmrPerDay) || !Number.isFinite(seconds) || seconds <= 0) return null;
  const capped = Math.min(seconds, 86400);
  return (bmrPerDay / 86400) * capped;
}

/** How much of `date` has elapsed, in seconds, from the user's own
 *  perspective: the whole day for any past date, and only the elapsed
 *  part for today. `nowMs`/`dayStartMs` are passed in so this stays a
 *  pure function (the caller owns timezone resolution). */
export function elapsedSecondsOfDay({ dayStartMs, nowMs }) {
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(nowMs)) return 86400;
  const elapsed = (nowMs - dayStartMs) / 1000;
  if (elapsed <= 0) return 0;          // a future date -- nothing has happened yet
  return Math.min(elapsed, 86400);      // a past date -- the full day
}

// Steps -> energy. Deliberately conservative and NET of resting: this
// number is added to resting energy, so it must contain only the energy
// spent ABOVE lying still, or the total double-counts BMR.
//
// Derivation (the same MET arithmetic calorieModel.js uses, so the two
// stay dimensionally consistent): casual walking is ~3 METs, and net
// kcal/min = (MET - 1) x 3.5 x kg / 200. At a typical 110 steps/min,
// one step is 1/110 min, giving:
//   kcal/step = (3 - 1) x 3.5 x kg / 200 / 110  ~=  0.000318 x kg
// ~0.025 kcal/step for a 78 kg person, or ~250 kcal per 10,000 steps
// above resting. Public "10k steps = 400-500 kcal" figures are GROSS
// (resting included) and would double-count here.
const NET_KCAL_PER_STEP_PER_KG = (3 - 1) * 3.5 / 200 / 110;

/** Non-exercise movement energy implied by a day's step count, net of
 *  resting. Returns null (never 0) when there is no usable input, so the
 *  UI can distinguish "no step data" from "genuinely didn't move". */
export function stepsToActiveKcal(steps, weightKg) {
  const s = Number(steps); const w = Number(weightKg);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (!Number.isFinite(w) || w <= 0) return null;
  return s * w * NET_KCAL_PER_STEP_PER_KG;
}

// Activities whose energy cost is ALREADY expressed in the day's step
// count -- if one of these is also a logged/measured workout, its steps
// are inside the daily step total and its energy is inside the workout
// figure, so counting both double-counts that stretch of the day.
const STEP_DRIVEN_ACTIVITIES = new Set(['running', 'walking', 'hiking', 'treadmill', 'jogging', 'trail_running', 'stair_climbing']);

/** Estimates how many of the day's steps were taken DURING step-driven
 *  workouts, so the caller can exclude them before converting the
 *  remainder to movement energy.
 *
 *  This is an approximation, and an honest one: we usually have a daily
 *  step TOTAL rather than a timestamped step series, so the overlap
 *  cannot be computed exactly. Strength/cycling/swimming sessions
 *  contribute negligible steps and are ignored entirely rather than
 *  guessed at. */
export function stepsDuringWorkouts(workouts, { cadenceStepsPerMin = 110 } = {}) {
  if (!Array.isArray(workouts) || !workouts.length) return 0;
  return workouts.reduce((total, w) => {
    const activity = String(w?.activityType || w?.activity_type || '').toLowerCase();
    if (!STEP_DRIVEN_ACTIVITIES.has(activity)) return total;
    const seconds = Number(w?.durationSeconds ?? w?.duration_seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return total;
    return total + (seconds / 60) * cadenceStepsPerMin;
  }, 0);
}

/**
 * Composes one day's complete energy picture from its already-reconciled
 * parts. Pure: every input is supplied by the caller.
 *
 * THE DOUBLE-COUNTING RULES, all in one place:
 *  - `wearableDailyActive` (a provider's own whole-day active-energy
 *    figure) is AUTHORITATIVE when present: it already includes both
 *    workouts and everyday movement, so steps are not added on top and
 *    the workout sum is not added to it either.
 *  - Otherwise active = workout energy + movement energy from the steps
 *    that were NOT taken during step-driven workouts.
 *  - Resting is always separate, and is prorated for a day in progress.
 */
export function composeDailyEnergy({
  bmrPerDay, elapsedSeconds, workoutKcal, steps, weightKg, workouts, wearableDailyActive = null,
}) {
  const resting = restingEnergyForSeconds(bmrPerDay, elapsedSeconds);
  const workout = Number.isFinite(workoutKcal) ? workoutKcal : 0;

  let movement = null;
  let activeSource = 'skos_composed';
  let active;

  if (Number.isFinite(wearableDailyActive)) {
    // The wearable measured the whole day. Trust it wholesale.
    active = wearableDailyActive;
    activeSource = 'wearable_daily_total';
  } else {
    const workoutSteps = stepsDuringWorkouts(workouts);
    const remainingSteps = Number.isFinite(Number(steps)) ? Math.max(0, Number(steps) - workoutSteps) : null;
    movement = remainingSteps != null ? stepsToActiveKcal(remainingSteps, weightKg) : null;
    active = workout + (movement || 0);
  }

  return {
    restingKcal: resting,
    workoutKcal: workout,
    movementKcal: movement,
    activeKcal: active,
    // Resting is unknown when the profile is incomplete -- report the
    // total as unknown too rather than passing off "active only" as a
    // whole-day total.
    totalKcal: resting == null ? null : resting + active,
    activeSource,
  };
}
