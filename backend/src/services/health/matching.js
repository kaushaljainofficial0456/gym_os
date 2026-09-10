// ============================================================
// WORKOUT MATCHING ENGINE — deterministic, explainable, no ML (spec
// §16/§102: "use rules for... time matching, source selection" — this
// module never touches an ML model).
//
// Pure functions only: no DB access, no fetch. Given two workout-shaped
// intervals ({ start_time, end_time, activity_type, heart_rate_avg? }),
// scores how likely they represent the SAME real-world workout. Used
// both for SK OS-workout <-> wearable-workout matching AND
// wearable <-> wearable matching (the same function covers the "WHOOP +
// Apple Health reported the same workout" case, spec §9/§31 -- there is
// no separate "cross-provider dedup" algorithm, it's the same overlap
// question either way).
// ============================================================

// Configurable weights (spec §16: "not scattered magic numbers"). Must
// sum to 1 -- checked by a test, not enforced at runtime (a runtime
// assert here would be one more way production could crash on a typo).
export const MATCH_WEIGHTS = Object.freeze({
  timeOverlap: 0.45,
  activitySimilarity: 0.30,
  physiologicalSimilarity: 0.15,
  durationSimilarity: 0.10,
});

// A candidate below this score is not associated at all -- shown to the
// user as a separate, unmatched event rather than silently forced onto
// the wrong workout.
export const MATCH_THRESHOLD = 0.55;

// Coverage at/above this ratio is treated as "the wearable covered the
// whole session" (spec §17) -- below it, the engine computes a genuine
// covered/uncovered split rather than rounding up.
export const FULL_COVERAGE_THRESHOLD = 0.90;

const toMs = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** Activity-type compatibility, 0..1. Exact match = 1. Either side
 *  unknown ('other'/null) = 0.5 (genuinely uninformative, not a
 *  mismatch). Otherwise 0 -- a logged "Strength Training" against a
 *  wearable "Running" should not match on time overlap alone. */
export function activitySimilarity(a, b) {
  if (!a || !b || a === 'other' || b === 'other') return 0.5;
  return a === b ? 1 : 0;
}

/** Duration similarity, 0..1 -- 1 minus the relative difference between
 *  the two interval lengths. Two 60-min sessions score 1; a 60-min vs
 *  30-min pair scores 0.5. */
export function durationSimilarity(startA, endA, startB, endB) {
  const durA = toMs(endA) - toMs(startA);
  const durB = toMs(endB) - toMs(startB);
  if (!(durA > 0) || !(durB > 0)) return 0;
  return 1 - Math.abs(durA - durB) / Math.max(durA, durB);
}

/** Time-overlap primitives (spec §15/§17): covered interval, union,
 *  intersection, and overlap ratio relative to interval A (typically the
 *  SK OS-logged workout -- "how much of MY session does the candidate
 *  cover", not a symmetric union-based ratio, since spec §17's whole
 *  point is "do not pretend the wearable covered 18:00-19:00 if it only
 *  covered 18:08-18:52"). */
export function timeOverlap(startA, endA, startB, endB) {
  const aStart = toMs(startA), aEnd = toMs(endA), bStart = toMs(startB), bEnd = toMs(endB);
  if (![aStart, aEnd, bStart, bEnd].every((v) => Number.isFinite(v)) || aEnd <= aStart || bEnd <= bStart) {
    return { intersectionMs: 0, unionMs: 0, overlapRatio: 0, coveredStart: null, coveredEnd: null };
  }
  const iStart = Math.max(aStart, bStart);
  const iEnd = Math.min(aEnd, bEnd);
  const intersectionMs = Math.max(0, iEnd - iStart);
  const unionMs = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  const durationA = aEnd - aStart;
  return {
    intersectionMs,
    unionMs,
    overlapRatio: durationA > 0 ? intersectionMs / durationA : 0, // relative to A, per the note above
    coveredStart: intersectionMs > 0 ? new Date(iStart).toISOString() : null,
    coveredEnd: intersectionMs > 0 ? new Date(iEnd).toISOString() : null,
  };
}

/** Physiological similarity, 0..1 -- a WEAK supporting signal (spec
 *  weight: 0.15), not a primary one. Today this only checks "does the
 *  candidate carry a heart-rate reading at all, and is it in a
 *  physiologically plausible range for exercise" -- a real HR-CURVE
 *  comparison against SK OS's own logged RPE/intensity is future work
 *  (spec §102: rules now, richer ML-assisted comparison later). Absent
 *  HR data scores 0.5 (uninformative), never 0 (which would read as
 *  "definitely not a match" for something the engine simply doesn't know). */
export function physiologicalSimilarity(candidate) {
  const hr = Number(candidate?.heart_rate_avg);
  if (!Number.isFinite(hr)) return 0.5;
  return hr >= 90 && hr <= 200 ? 1 : 0.3; // plausible-for-exercise band; outside it is suspicious, not "match"
}

/** The one scoring function (spec §16's exact weighted formula). Returns
 *  { score, matchReason, overlap } -- matchReason is a short, human-
 *  readable audit string (spec §72/§76), never hidden reasoning. */
export function scoreMatch(a, b) {
  const overlap = timeOverlap(a.start_time, a.end_time, b.start_time, b.end_time);
  const actSim = activitySimilarity(a.activity_type, b.activity_type);
  const durSim = durationSimilarity(a.start_time, a.end_time, b.start_time, b.end_time);
  const physSim = physiologicalSimilarity(b);
  const score =
    overlap.overlapRatio * MATCH_WEIGHTS.timeOverlap +
    actSim * MATCH_WEIGHTS.activitySimilarity +
    physSim * MATCH_WEIGHTS.physiologicalSimilarity +
    durSim * MATCH_WEIGHTS.durationSimilarity;
  const matchReason =
    `time overlap ${(overlap.overlapRatio * 100).toFixed(0)}%, ` +
    `activity ${actSim === 1 ? 'match' : actSim === 0.5 ? 'unknown' : 'mismatch'}, ` +
    `duration similarity ${(durSim * 100).toFixed(0)}%`;
  return { score: Math.max(0, Math.min(1, score)), matchReason, overlap };
}

/** Picks the single best candidate for `target` from `candidates`
 *  (spec §16: deterministic, no randomness/ties-by-insertion-order).
 *  Returns null if nothing clears MATCH_THRESHOLD -- callers must then
 *  treat `target` as unmatched (spec §17/§20), never force a weak match. */
export function findBestMatch(target, candidates) {
  let best = null;
  for (const c of candidates) {
    const result = scoreMatch(target, c);
    if (result.score >= MATCH_THRESHOLD && (!best || result.score > best.score)) {
      best = { candidate: c, ...result };
    }
  }
  return best;
}

/** Coverage of `target`'s own duration by ALL matched candidates
 *  combined (spec §17: partial coverage may come from more than one
 *  wearable record). Returns covered/uncovered seconds and the
 *  uncovered sub-intervals (gaps), so a caller can estimate ONLY the
 *  genuinely missing portion (spec §17's core rule) rather than the
 *  whole session. */
export function computeCoverage(target, matchedCandidates) {
  const targetStart = toMs(target.start_time), targetEnd = toMs(target.end_time);
  const targetDurationMs = targetEnd - targetStart;
  if (!(targetDurationMs > 0)) return { coveredSeconds: 0, uncoveredSeconds: 0, coverageRatio: 0, uncoveredIntervals: [] };

  // Merge each candidate's overlap with `target` into a sorted, non-
  // overlapping interval list (a candidate's own overlap can double-
  // count against another candidate's if not merged -- e.g. two
  // wearables both covering 18:10-18:20).
  const covered = matchedCandidates
    .map((c) => timeOverlap(target.start_time, target.end_time, c.start_time, c.end_time))
    .filter((o) => o.intersectionMs > 0)
    .map((o) => [Date.parse(o.coveredStart), Date.parse(o.coveredEnd)])
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [s, e] of covered) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const coveredMs = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
  const uncoveredIntervals = [];
  let cursor = targetStart;
  for (const [s, e] of merged) {
    if (s > cursor) uncoveredIntervals.push({ start: new Date(cursor).toISOString(), end: new Date(s).toISOString() });
    cursor = Math.max(cursor, e);
  }
  if (cursor < targetEnd) uncoveredIntervals.push({ start: new Date(cursor).toISOString(), end: new Date(targetEnd).toISOString() });

  return {
    coveredSeconds: coveredMs / 1000,
    uncoveredSeconds: (targetDurationMs - coveredMs) / 1000,
    coverageRatio: coveredMs / targetDurationMs,
    uncoveredIntervals,
  };
}
