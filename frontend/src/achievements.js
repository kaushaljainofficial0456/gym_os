/**
 * ACHIEVEMENTS — every one of them computed from something real.
 *
 * The rule that shaped this list: an achievement must read a number the
 * app genuinely has. Nothing here is awarded for opening a screen, and
 * nothing is awarded on a promise -- if the data to measure it does not
 * exist, the achievement does not exist either. That is why there are no
 * sleep or recovery badges for someone with no wearable, and why the
 * strength family is measured in sessions and records rather than in
 * "dedication".
 *
 * SHAPED AS FAMILIES WITH TIERS, not 120 separate things to remember. A
 * family is one idea ("train regularly") measured at several distances,
 * so the ladder tells you where you are and what is next instead of
 * handing you a wall of identical cards. Tiers are deliberately spaced
 * so the first is reachable in a week or two and the last takes a year --
 * a ladder whose rungs are all within a month stops being a horizon.
 *
 * THE NUMBERS ARE NOT DECORATION. Each family's `value` reads the same
 * progress payload every chart on the page reads, so a badge and the
 * chart above it can never disagree. `unit` is only used for the
 * "x to go" line; `format` exists for the families where the raw number
 * is not what a person would say out loud.
 */

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const len = (a) => (Array.isArray(a) ? a.length : 0);

/** Distinct calendar months that contain at least one active day. */
function activeMonths(intel) {
  const days = intel?.consistency?.activeDays || [];
  return new Set(days.map((d) => String(d).slice(0, 7))).size;
}

/** The longest run of consecutive days with something logged. */
const bestStreak = (intel) => n(intel?.consistency?.streak?.best);

/** Total volume across the loaded window, in kilograms. */
function totalVolume(intel) {
  return (intel?.training?.sessions || []).reduce((s, x) => s + n(x.volume), 0);
}

/** How many distinct exercises the person has ever set a record on. */
const distinctLifts = (intel) => len(intel?.prs?.byExercise);

/** Kilograms lost, when the trend is downward. Zero otherwise -- a gain
 *  is not a smaller loss, it is a different thing, and gets its own family. */
function weightLost(intel) {
  const c = n(intel?.weight?.analysis?.change);
  return c < 0 ? Math.abs(c) : 0;
}
function weightGained(intel) {
  const c = n(intel?.weight?.analysis?.change);
  return c > 0 ? c : 0;
}

/** Days where BOTH training and food were logged -- the hardest habit. */
const perfectDays = (intel) => len(intel?.consistency?.bothDays);

/** Sessions longer than an hour. */
function longSessions(intel) {
  return (intel?.training?.sessions || []).filter((s) => n(s.duration_min) >= 60).length;
}

/** Distinct muscle groups trained. */
const musclesTrained = (intel) => (intel?.training?.byMuscle || []).filter((m) => n(m.sets) > 0).length;

/** Days the protein target was met. */
function proteinDaysHit(intel) {
  const target = n(intel?.nutrition?.targets?.protein);
  if (!target) return 0;
  return (intel?.nutrition?.days || []).filter((d) => n(d.protein) >= target * 0.9).length;
}

/** Days calories landed within 10% of target. */
function calorieDaysHit(intel) {
  const target = n(intel?.nutrition?.targets?.calories);
  if (!target) return 0;
  return (intel?.nutrition?.days || []).filter((d) => Math.abs(n(d.calories) - target) <= target * 0.1).length;
}

/** Distinct measurement sites with at least two readings -- i.e. actually tracked. */
function measuredSites(intel) {
  const m = intel?.measurements || {};
  return Object.values(m).filter((series) => len(series) >= 2).length;
}

/** Total sets across the window. */
function totalSets(intel) {
  return (intel?.training?.sessions || []).reduce((s, x) => s + n(x.sets), 0);
}

/**
 * THE CATALOGUE.
 *
 * `hue` maps to the metric families in theme.css so a badge is coloured
 * by what it measures rather than by how impressive it is.
 */
export const ACHIEVEMENT_FAMILIES = [
  /* ---------------- training ---------------- */
  {
    id: 'sessions', group: 'Training', hue: 'training', icon: 'strength',
    name: 'Sessions logged', unit: 'sessions',
    describe: (t) => `Log ${t} training sessions`,
    tiers: [1, 5, 10, 25, 50, 100, 200, 365, 500],
    value: (i) => len(i?.training?.sessions),
  },
  {
    id: 'training-days', group: 'Training', hue: 'training', icon: 'calendar',
    name: 'Training days', unit: 'days',
    describe: (t) => `Train on ${t} separate days`,
    tiers: [5, 15, 30, 60, 120, 250],
    value: (i) => len(i?.training?.qualifyingDays),
  },
  {
    id: 'sets', group: 'Training', hue: 'training', icon: 'strength',
    name: 'Sets completed', unit: 'sets',
    describe: (t) => `Complete ${t.toLocaleString()} sets`,
    tiers: [50, 250, 500, 1000, 2500, 5000, 10000],
    value: totalSets,
  },
  {
    id: 'volume', group: 'Training', hue: 'training', icon: 'trending',
    name: 'Volume moved', unit: 'kg', isWeight: true,
    describe: (t, w) => `Move ${w(t)} in total`,
    tiers: [5000, 25000, 100000, 250000, 500000, 1000000, 2500000],
    value: totalVolume,
  },
  {
    id: 'long-sessions', group: 'Training', hue: 'training', icon: 'clock',
    name: 'Hour-long sessions', unit: 'sessions',
    describe: (t) => `Train for an hour or more, ${t} times`,
    tiers: [1, 10, 25, 50, 100],
    value: longSessions,
  },
  {
    id: 'muscles', group: 'Training', hue: 'training', icon: 'body',
    name: 'Muscle groups trained', unit: 'groups',
    describe: (t) => `Train ${t} different muscle groups`,
    tiers: [3, 6, 10, 15],
    value: musclesTrained,
  },

  /* ---------------- strength ---------------- */
  {
    id: 'prs', group: 'Strength', hue: 'strength', icon: 'bulb',
    name: 'Personal records', unit: 'records',
    describe: (t) => `Set ${t} personal records`,
    tiers: [1, 5, 10, 25, 50, 100, 200],
    value: (i) => n(i?.prs?.total),
  },
  {
    id: 'lifts', group: 'Strength', hue: 'strength', icon: 'strength',
    name: 'Lifts with a record', unit: 'lifts',
    describe: (t) => `Set a record on ${t} different exercises`,
    tiers: [1, 5, 10, 20, 35],
    value: distinctLifts,
  },
  {
    id: 'pr-month', group: 'Strength', hue: 'strength', icon: 'bulb',
    name: 'Records in a month', unit: 'records',
    describe: (t) => `Set ${t} records within 30 days`,
    tiers: [1, 3, 5, 10, 20],
    value: (i) => n(i?.prs?.recentCount),
  },

  /* ---------------- consistency ---------------- */
  {
    id: 'streak', group: 'Consistency', hue: 'nutrition', icon: 'target',
    name: 'Longest streak', unit: 'days',
    describe: (t) => `Log something ${t} days in a row`,
    tiers: [3, 7, 14, 30, 60, 100, 180, 365],
    value: bestStreak,
  },
  {
    id: 'active-days', group: 'Consistency', hue: 'nutrition', icon: 'calendar',
    name: 'Active days', unit: 'days',
    describe: (t) => `Log something on ${t} days`,
    tiers: [7, 30, 75, 150, 300, 500],
    value: (i) => len(i?.consistency?.activeDays),
  },
  {
    id: 'perfect-days', group: 'Consistency', hue: 'nutrition', icon: 'check',
    name: 'Complete days', unit: 'days',
    describe: (t) => `Log both training and food on ${t} days`,
    tiers: [1, 5, 15, 30, 60, 120],
    value: perfectDays,
  },
  {
    id: 'months', group: 'Consistency', hue: 'nutrition', icon: 'calendar',
    name: 'Months active', unit: 'months',
    describe: (t) => `Stay active across ${t} different months`,
    tiers: [1, 3, 6, 12, 24],
    value: activeMonths,
  },

  /* ---------------- nutrition ---------------- */
  {
    id: 'food-days', group: 'Nutrition', hue: 'nutrition', icon: 'food',
    name: 'Days food logged', unit: 'days',
    describe: (t) => `Log your food on ${t} days`,
    tiers: [1, 7, 21, 50, 100, 200, 365],
    value: (i) => len(i?.consistency?.nutritionDays),
  },
  {
    id: 'protein-days', group: 'Nutrition', hue: 'body', icon: 'food',
    name: 'Protein target hit', unit: 'days',
    describe: (t) => `Hit your protein target on ${t} days`,
    tiers: [1, 5, 15, 30, 75, 150],
    value: proteinDaysHit,
  },
  {
    id: 'calorie-days', group: 'Nutrition', hue: 'nutrition', icon: 'target',
    name: 'Calories on target', unit: 'days',
    describe: (t) => `Land within 10% of your calorie target on ${t} days`,
    tiers: [1, 5, 15, 30, 75, 150],
    value: calorieDaysHit,
  },

  /* ---------------- body ---------------- */
  {
    id: 'weight-lost', group: 'Body', hue: 'body', icon: 'trending',
    name: 'Weight down', unit: 'kg', isWeight: true,
    describe: (t, w) => `Be ${w(t)} down from where you started`,
    tiers: [1, 2, 5, 10, 15, 20, 30],
    value: weightLost,
  },
  {
    id: 'weight-gained', group: 'Body', hue: 'body', icon: 'trending',
    name: 'Weight up', unit: 'kg', isWeight: true,
    describe: (t, w) => `Be ${w(t)} up from where you started`,
    tiers: [1, 2, 5, 10, 15],
    value: weightGained,
  },
  {
    id: 'weigh-ins', group: 'Body', hue: 'body', icon: 'chart',
    name: 'Weigh-ins', unit: 'readings',
    describe: (t) => `Record your weight ${t} times`,
    tiers: [1, 10, 30, 75, 150, 365],
    value: (i) => len(i?.weight?.series),
  },
  {
    id: 'measured', group: 'Body', hue: 'body', icon: 'ruler',
    name: 'Sites measured', unit: 'sites',
    describe: (t) => `Track ${t} body measurements over time`,
    tiers: [1, 3, 6],
    value: measuredSites,
  },
];

/**
 * Flattens the families into individual achievements, each knowing
 * whether it is earned and how close it is.
 *
 * EVERY TIER IS RETURNED, earned or not. A cabinet that shows only what
 * you have already done cannot tell you what to aim at, and hiding the
 * unearned ones is what made the old four-family version feel like a
 * summary rather than a map.
 */
export function buildAchievements(intel, formatWeight) {
  /* The weight families describe themselves in the reader's unit. Without
     this a person reading in pounds is told to be "10 kg down" by a badge
     sitting under a chart that says lb -- the one inconsistency that makes
     the whole unit preference look broken. Falls back to kilograms so the
     catalogue is still usable without a formatter. */
  const w = typeof formatWeight === 'function' ? formatWeight : (v) => `${v} kg`;
  const out = [];
  for (const fam of ACHIEVEMENT_FAMILIES) {
    let value = 0;
    try { value = n(fam.value(intel)); } catch { value = 0; }
    fam.tiers.forEach((tier, idx) => {
      out.push({
        key: `${fam.id}:${tier}`,
        familyId: fam.id,
        group: fam.group,
        hue: fam.hue,
        icon: fam.icon,
        name: fam.name,
        tier,
        level: idx + 1,
        levels: fam.tiers.length,
        unit: fam.unit,
        isWeight: !!fam.isWeight,
        description: fam.describe(tier, w),
        value,
        earned: value >= tier,
        progress: tier > 0 ? Math.max(0, Math.min(1, value / tier)) : 0,
        remaining: Math.max(0, tier - value),
      });
    });
  }
  return out;
}

/** Totals for the header, so the count shown is the count that exists. */
export function achievementSummary(list) {
  const earned = list.filter((a) => a.earned).length;
  return { earned, total: list.length };
}

export const ACHIEVEMENT_GROUPS = ['Training', 'Strength', 'Consistency', 'Nutrition', 'Body'];
