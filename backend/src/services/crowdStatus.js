// ============================================================
// CROWD STATUS — one place that decides what a number of people MEANS.
//
// WHY THIS IS ON THE SERVER. The obvious home for "40% is moderate" is a
// frontend helper, and that is exactly how it drifts: the client card, the
// client detail view, the owner dashboard and the trainer view each grow
// their own copy of the thresholds, and a gym that raises its capacity
// finds three of the four still using the old numbers. Thresholds are also
// OWNER-CONFIGURABLE, which makes them data, not constants -- and data
// belongs with the data. Every surface renders the label this returns; no
// screen in this app computes a crowd status itself.
//
// WHAT "HONEST" MEANS HERE, because a crowd figure is easy to overstate:
//
//   * Without a configured capacity there is no percentage. A gym that has
//     not told us how many people it holds has not told us what 40 people
//     means, and inventing a denominator to get a nice ring is the single
//     most tempting lie in this feature. `occupancyPercentage` is null and
//     the label falls back to a count.
//   * Stale data is never called live. Freshness is computed from the last
//     event actually received, not from when the request happened.
//   * "Very busy" is capped at reality: an occupancy above capacity is
//     reported as over capacity rather than silently clamped to 100%.
//
// The returned shape is deliberately complete -- label, description,
// recommendation, severity and a colour TOKEN (not a hex) -- so that a
// screen can render the whole state without knowing the rules, and so the
// accessible description never has to be reconstructed from a colour.
// ============================================================

/* Percentage bands, upper bound inclusive. Owner-configurable; these are
   the defaults a gym gets before anyone touches the settings. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  quiet: 30,       // 0-30%
  moderate: 60,    // 31-60%
  busy: 80,        // 61-80%
  // above `busy` and up to 100 is "very busy"; over 100 is its own state.
});

/* Ordered worst-first so severity comparisons are just index comparisons. */
export const SEVERITY = Object.freeze(['none', 'info', 'low', 'medium', 'high', 'critical']);

const STATES = {
  unavailable: {
    label: 'Live crowd data unavailable',
    severity: 'none',
    color: 'var(--faint)',
    description: 'Live crowd data is not available for this gym right now.',
    recommendation: null,
  },
  closed: {
    label: 'Gym closed',
    severity: 'none',
    color: 'var(--faint)',
    description: 'The gym is currently closed.',
    recommendation: null,
  },
  quiet: {
    label: 'Quiet',
    severity: 'low',
    color: 'var(--good)',
    description: 'The gym is quiet right now.',
    recommendation: 'A good time to train — you should have space to work.',
  },
  moderate: {
    label: 'Moderately busy',
    severity: 'medium',
    color: 'var(--warn)',
    description: 'The gym is moderately busy right now.',
    recommendation: 'You can visit now, or choose a quieter time.',
  },
  busy: {
    label: 'Busy',
    severity: 'high',
    color: 'var(--gold)',
    description: 'The gym is busy right now.',
    recommendation: 'Expect to wait for popular equipment.',
  },
  very_busy: {
    label: 'Very busy',
    severity: 'critical',
    color: 'var(--bad)',
    description: 'The gym is very busy right now.',
    recommendation: 'Consider training later if you can.',
  },
  over_capacity: {
    label: 'At capacity',
    severity: 'critical',
    color: 'var(--bad)',
    description: 'The gym is at or over its stated capacity.',
    recommendation: 'Consider training later.',
  },
};

function normalizeThresholds(t) {
  const q = Number(t?.quiet);
  const m = Number(t?.moderate);
  const b = Number(t?.busy);
  const quiet = Number.isFinite(q) ? clampPct(q) : DEFAULT_THRESHOLDS.quiet;
  // Each band must sit above the one below it. A settings screen that let
  // someone save moderate=20 with quiet=30 would otherwise produce a band
  // that can never be entered, and a gym would simply never report
  // "moderately busy" again with no visible error anywhere.
  const moderate = Math.max(quiet + 1, Number.isFinite(m) ? clampPct(m) : DEFAULT_THRESHOLDS.moderate);
  const busy = Math.max(moderate + 1, Number.isFinite(b) ? clampPct(b) : DEFAULT_THRESHOLDS.busy);
  return { quiet, moderate, busy: Math.min(busy, 99) };
}

const clampPct = (n) => Math.min(100, Math.max(0, Math.round(n)));

/**
 * What does this many people mean?
 *
 * @param {object}  args
 * @param {number}  args.occupancyCount   people currently inside
 * @param {number?} args.capacity         configured capacity, or null/0 if unset
 * @param {object?} args.thresholds       owner overrides for the percentage bands
 * @param {boolean} args.open             whether the gym is open (default true)
 * @param {boolean} args.available        whether we have usable live data at all
 * @param {boolean} args.showExactCount   owner privacy setting -- see below
 */
export function getCrowdStatus({
  occupancyCount,
  capacity,
  thresholds,
  open = true,
  available = true,
  showExactCount = true,
} = {}) {
  const count = Number(occupancyCount);
  const cap = Number(capacity);
  const hasCount = Number.isFinite(count) && count >= 0;
  const hasCapacity = Number.isFinite(cap) && cap > 0;

  if (!available || !hasCount) return render('unavailable', { count: null, pct: null, capacity: hasCapacity ? cap : null, showExactCount });
  if (!open) return render('closed', { count, pct: null, capacity: hasCapacity ? cap : null, showExactCount });

  /* No capacity, no percentage. The count alone is still genuinely useful
     -- "42 people inside" answers the question for anyone who knows their
     own gym -- so this is a real state, not a degraded one. What it must
     never do is guess a denominator. */
  if (!hasCapacity) {
    return {
      status: 'no_capacity',
      label: showExactCount ? `${count} people inside` : 'Open',
      occupancyCount: showExactCount ? count : null,
      occupancyPercentage: null,
      capacity: null,
      severity: 'info',
      color: 'var(--accent)',
      description: showExactCount
        ? `${count} ${count === 1 ? 'person is' : 'people are'} inside. Capacity has not been configured for this gym.`
        : 'The gym is open. Crowd level is not being reported.',
      recommendation: null,
      thresholds: null,
    };
  }

  const pct = Math.round((count / cap) * 100);
  const t = normalizeThresholds(thresholds);
  const key = pct > 100 ? 'over_capacity'
    : pct <= t.quiet ? 'quiet'
      : pct <= t.moderate ? 'moderate'
        : pct <= t.busy ? 'busy'
          : 'very_busy';

  return render(key, { count, pct, capacity: cap, showExactCount, thresholds: t });
}

function render(key, { count, pct, capacity, showExactCount, thresholds = null }) {
  const s = STATES[key];
  /* The owner can hide the exact head-count from clients while still
     showing how busy it is. That has to be enforced where the number is
     produced, not by a component choosing not to render it -- a value the
     API sends is a value a client can read out of the network tab. */
  const exposedCount = showExactCount ? count : null;
  /* "1 of 150 people", not "1 of 150 person": in this phrasing the noun
     agrees with the CAPACITY, which is the thing being counted out of.
     Only a bare count takes the singular. */
  /* Not on a closed gym. "The gym is currently closed. 1 of 150 people."
     reads as a contradiction, and the one number a member wants when the
     doors are shut is the opening time, not a head-count that is really a
     staff member or a session nobody scanned out of. */
  const detail = key !== 'closed' && showExactCount && count != null && capacity
    ? ` ${count} of ${capacity} ${capacity === 1 ? 'person' : 'people'}.`
    : '';
  return {
    status: key,
    label: s.label,
    occupancyCount: exposedCount,
    occupancyPercentage: pct,
    capacity: capacity ?? null,
    severity: s.severity,
    color: s.color,
    description: s.description + detail,
    recommendation: s.recommendation,
    thresholds,
  };
}

/* ── freshness ─────────────────────────────────────────────────────────
   A number with no age is the thing that turns this feature into a lie.
   "Live" is a claim about WHEN, and it is only true for a little while.

   The windows are generous on purpose: a gym with one door can legitimately
   go several minutes between events at 11am without anything being broken,
   so "no events recently" is not the same as "stale". What makes data stale
   is the CALCULATION being old, or the device that feeds it having gone
   quiet for longer than a gym plausibly goes without a single movement. */
export const FRESHNESS = Object.freeze({
  LIVE_SEC: 60,        // the CALCULATION was made within the last minute
  RECENT_SEC: 300,     // within five minutes
  DELAYED_SEC: 900,    // within fifteen
  /* How long a door feed may stay silent before we stop vouching for it.
     Matched to the device-online cutoff used on the owner dashboard, and
     generous on purpose: a gym with one door legitimately goes minutes
     between scans at 11am without anything being wrong. Half an hour of
     total silence from a building that is supposed to be open is a
     different thing, and at that point the count is a memory, not an
     observation. */
  FEED_SILENT_SEC: 1800,
});

/**
 * How old is this number, and may we call it live?
 *
 * TWO AGES, NOT ONE, and getting this wrong was the whole point of the
 * bug it fixes. The first version measured only `calculatedAt` -- which is
 * set to now() by the very function building the response -- so it
 * reported "Live" unconditionally, including for a gym whose door panel
 * had been silent for six hours. A freshness indicator that is always
 * green is worse than none: it actively vouches for a number nobody has
 * checked.
 *
 * So `isLive` now requires both:
 *   - the calculation is recent (it always is, but a cached snapshot
 *     served later would not be), AND
 *   - when a door feed is the source, that feed has spoken recently
 *     enough that the count is still an observation.
 *
 * `lastEventAt` is optional. Omitting it means "there is no feed to
 * vouch for" -- the manual check-in path -- and only the calculation age
 * applies.
 */
export function getFreshness({ calculatedAt, lastEventAt, now = new Date(), feedSilentSec = FRESHNESS.FEED_SILENT_SEC } = {}) {
  /* typeof check FIRST. Date.parse coerces its argument to a string, so
     Date.parse(0) parses "0" as the year 2000 and returns a perfectly
     finite number -- a junk timestamp that reported itself as merely
     "stale" instead of unavailable. Anything that is not a string is not
     a timestamp. */
  const t = typeof calculatedAt === 'string' ? Date.parse(calculatedAt) : NaN;
  if (!Number.isFinite(t)) {
    return { state: 'unavailable', label: 'Unavailable', ageSec: null, isLive: false, lastEventAt: lastEventAt || null };
  }
  const ageSec = Math.max(0, Math.round((now.getTime() - t) / 1000));
  const byCalc = ageSec <= FRESHNESS.LIVE_SEC ? 'live'
    : ageSec <= FRESHNESS.RECENT_SEC ? 'recent'
      : ageSec <= FRESHNESS.DELAYED_SEC ? 'delayed'
        : 'stale';

  // The feed's own age, when there is a feed.
  const et = typeof lastEventAt === 'string' ? Date.parse(lastEventAt) : NaN;
  const feedAgeSec = Number.isFinite(et) ? Math.max(0, Math.round((now.getTime() - et) / 1000)) : null;
  const byFeed = feedAgeSec == null ? null
    : feedAgeSec <= feedSilentSec ? 'live'
      : feedAgeSec <= feedSilentSec * 4 ? 'delayed'
        : 'stale';

  // Whichever is worse wins. A recent calculation over an old feed is an
  // old number, promptly served.
  const RANK = { live: 0, recent: 1, delayed: 2, stale: 3 };
  const state = byFeed && RANK[byFeed] > RANK[byCalc] ? byFeed : byCalc;

  return {
    state,
    label: {
      live: 'Live',
      recent: 'Updated recently',
      delayed: 'Data delayed',
      stale: 'Data may be out of date',
    }[state],
    ageSec,
    feedAgeSec,
    // The one flag every "LIVE" badge in the UI must gate on. Nothing else
    // in this codebase decides that word.
    isLive: state === 'live',
    calculatedAt,
    lastEventAt: lastEventAt || null,
  };
}

export default { getCrowdStatus, getFreshness, DEFAULT_THRESHOLDS, FRESHNESS };
