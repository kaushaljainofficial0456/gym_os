// ============================================================
// SK OS RECOVERY / READINESS — architecture only, per spec §37/§39.
//
// "Recovery unavailable" is correct output when evidence is
// insufficient -- NEVER a fabricated number just because the UI has a
// slot for one (spec §37's exact example: "Recovery unavailable" beats
// "Recovery 83"). Today's minimum viable evidence set: resting heart
// rate AND sleep duration for the prior night, both from a connected
// wearable (this app has no other way to observe either yet). Until a
// provider is actually connected and syncing, this will almost always
// return null -- that is the HONEST state for a dev environment with no
// live wearable credentials, not a bug in this module.
//
// Uses ORIGINAL SK OS methodology -- no WHOOP/Oura formula is
// reproduced. The exact weighting below is a first, deliberately simple
// pass (spec §102), meant to be replaced once real longitudinal data
// exists to validate against, not presented as clinically calibrated.
// ============================================================

const MIN_BASELINE_SAMPLES = 3; // fewer than this many prior nights -> no personal baseline yet, only single-night guidance

/**
 * @param {object} input
 *   restingHr: number|null - last night's resting HR
 *   sleepDurationSeconds: number|null
 *   hrv: number|null
 *   baselineRestingHr: number|null - trailing average, if enough history exists
 *   baselineSleepSeconds: number|null
 *   trainingLoadYesterday: number|null
 * @returns {{ recoveryScore: number|null, reasons: string[] }}
 */
export function computeRecovery({ restingHr, sleepDurationSeconds, hrv, baselineRestingHr, baselineSleepSeconds, trainingLoadYesterday }) {
  const reasons = [];
  if (restingHr == null || sleepDurationSeconds == null) {
    reasons.push('insufficient evidence: needs both resting heart rate and sleep duration from a connected wearable');
    return { recoveryScore: null, reasons };
  }

  let score = 70; // neutral starting point, adjusted by the signals actually present
  if (baselineRestingHr != null) {
    const delta = restingHr - baselineRestingHr;
    score -= delta * 2; // elevated resting HR vs. personal baseline lowers recovery
    reasons.push(`resting HR ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs baseline`);
  } else {
    reasons.push('no personal resting-HR baseline yet (needs more history)');
  }

  const sleepHours = sleepDurationSeconds / 3600;
  if (baselineSleepSeconds != null) {
    const deltaHours = sleepHours - baselineSleepSeconds / 3600;
    score += deltaHours * 5;
    reasons.push(`sleep ${deltaHours >= 0 ? '+' : ''}${deltaHours.toFixed(1)}h vs baseline`);
  } else if (sleepHours < 6) {
    score -= 10;
    reasons.push('short night (<6h), no baseline yet to compare against');
  }

  if (hrv != null) reasons.push('HRV available (informational only in this v1 -- not yet weighted)');
  if (Number.isFinite(trainingLoadYesterday) && trainingLoadYesterday > 0) {
    const penalty = Math.min(15, trainingLoadYesterday / 20);
    score -= penalty;
    reasons.push(`yesterday's training load (-${penalty.toFixed(0)})`);
  }

  return { recoveryScore: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

/**
 * @returns {{ readinessLabel: 'ready'|'moderate'|'recovery_recommended'|null, reasons: string[] }}
 *   null when recoveryScore itself is null -- readiness is never
 *   computed from a fabricated recovery number (spec §39: fitness/
 *   recovery guidance only, never a medical diagnosis).
 */
export function computeReadiness({ recoveryScore, sleepDebtHours = 0 }) {
  if (recoveryScore == null) return { readinessLabel: null, reasons: ['no recovery evidence yet'] };
  const reasons = [`recovery score ${recoveryScore}`];
  if (sleepDebtHours > 3) reasons.push(`sleep debt ${sleepDebtHours.toFixed(1)}h`);
  if (recoveryScore >= 67 && sleepDebtHours <= 3) return { readinessLabel: 'ready', reasons };
  if (recoveryScore >= 40) return { readinessLabel: 'moderate', reasons };
  return { readinessLabel: 'recovery_recommended', reasons };
}

export { MIN_BASELINE_SAMPLES };
