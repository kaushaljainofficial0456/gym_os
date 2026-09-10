// ============================================================
// SK OS TRAINING LOAD — an ORIGINAL, SK OS-native daily load metric
// (spec §38). Deliberately NOT WHOOP's 0-21 strain scale or any other
// proprietary formula -- this is our own, on an open (unbounded, 0+)
// scale, documented here rather than copied from anywhere.
//
// Inputs used today: reconciled workout duration + active energy +
// (when available) average heart rate. This is a genuinely simple v1
// (spec §102: "do not overengineer v1") -- it is a real, deterministic,
// explainable number, not a placeholder, but it is intentionally not
// yet informed by multi-day training history (that's the natural next
// step once there's real longitudinal data to validate against).
// ============================================================

const HR_INTENSITY_MULTIPLIER = Object.freeze({ low: 0.8, moderate: 1.0, high: 1.3 });

function hrIntensityBand(avgHr) {
  if (!Number.isFinite(avgHr)) return null;
  if (avgHr < 110) return 'low';
  if (avgHr < 150) return 'moderate';
  return 'high';
}

/**
 * @param {object[]} workouts - reconciled workouts for the day, each
 *   { durationSeconds, activeKcal, heartRateAvg? }
 * @returns {{ load: number, breakdown: object[] }} load is unbounded --
 *   a rest day is 0, a hard 90-minute session with elevated HR scores
 *   noticeably higher than a light 20-minute walk. The exact scale has
 *   no meaning outside this app (spec §38: "the exact scale should be
 *   configurable") -- it is a RELATIVE, day-over-day/week-over-week
 *   signal, not an absolute clinical measure.
 */
export function computeTrainingLoad(workouts = []) {
  const breakdown = workouts.map((w) => {
    const minutes = (w.durationSeconds || 0) / 60;
    const band = hrIntensityBand(w.heartRateAvg);
    const multiplier = band ? HR_INTENSITY_MULTIPLIER[band] : 1.0;
    // kcal/min is itself already an intensity proxy even with no HR data
    // at all -- so the metric degrades gracefully rather than going to
    // zero just because a session has no heart-rate evidence.
    const kcalPerMin = minutes > 0 && Number.isFinite(w.activeKcal) ? w.activeKcal / minutes : 0;
    const sessionLoad = Math.round(minutes * (1 + kcalPerMin / 10) * multiplier);
    return { minutes, activeKcal: w.activeKcal ?? null, hrBand: band, multiplier, sessionLoad };
  });
  return { load: breakdown.reduce((sum, b) => sum + b.sessionLoad, 0), breakdown };
}
