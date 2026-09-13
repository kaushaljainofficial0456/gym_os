/**
 * WHAT SOMEONE GETS WHEN THEY ARE NOT IN A GYM.
 *
 * Two different things decide what a person can do, and keeping them
 * separate is the whole point of this file:
 *
 *   THE GYM gives gym features -- live crowd, the gym's community, a
 *   coach, assigned programmes. These come from belonging to a real gym
 *   org and stop the moment that ends. They are not something we sell.
 *
 *   THE PLAN gives app features, and is between the person and us. It
 *   survives leaving a gym, because their six months of history did too.
 *
 * So when an owner revokes a membership the person does not fall off a
 * cliff: they lose the gym half and keep everything they logged, on the
 * free plan, with an upgrade available. A tracker that took away your own
 * training history because a gym ended its relationship with you would be
 * holding your data hostage.
 *
 * FREE IS A REAL PRODUCT. Everything that makes the app worth opening
 * daily -- logging workouts, food, weight, measurements, seeing your own
 * progress and records -- is free and always will be, because a limit
 * there would corrupt the data rather than upsell anything: someone who
 * cannot log today's session simply has a gap in their history forever.
 * The limits are on stored breadth and on the expensive AI paths.
 */

export const TIERS = ['free', 'pro'];

/**
 * One place to tune. Anything absent from a tier's `limits` is unlimited.
 * `null` means no cap.
 */
export const TIER_LIMITS = {
  free: {
    label: 'Free',
    // Never limited: logging is how the product earns its place, and a
    // capped log is a corrupted history, not a smaller one.
    workoutLogging: null,
    foodLogging: null,
    weightLogging: null,
    // Breadth, not depth. You keep every day you ever logged; the free
    // plan charts a rolling window of it.
    progressHistoryDays: 90,
    customMetrics: 3,
    savedMeals: 10,
    customFoods: 25,
    progressPhotos: 20,
    // The genuinely expensive paths -- each of these is a paid API call.
    aiFoodEstimatesPerDay: 5,
    aiCoachMessagesPerDay: 3,
    aiWorkoutGenerationsPerWeek: 1,
  },
  pro: {
    label: 'Pro',
    workoutLogging: null,
    foodLogging: null,
    weightLogging: null,
    progressHistoryDays: null,
    customMetrics: null,
    savedMeals: null,
    customFoods: null,
    progressPhotos: null,
    aiFoodEstimatesPerDay: 50,
    aiCoachMessagesPerDay: 30,
    aiWorkoutGenerationsPerWeek: 10,
  },
};

export const normalizeTier = (t) => (TIERS.includes(t) ? t : 'free');

/**
 * The limits that actually apply to a person right now.
 *
 * A GYM MEMBER IS NOT ON A TIER. Their gym is paying for them, so none of
 * the app-plan caps apply while that lasts -- charging a member for what
 * their gym already bought would be charging twice for one thing.
 */
export function limitsFor({ tier, inGym }) {
  if (inGym) return { ...TIER_LIMITS.pro, label: 'Gym membership', source: 'gym' };
  const t = normalizeTier(tier);
  return { ...TIER_LIMITS[t], source: 'plan', tier: t };
}

/** `null`/undefined caps mean unlimited, so this is the only check needed. */
export const withinLimit = (used, cap) => cap == null || Number(used) < Number(cap);
