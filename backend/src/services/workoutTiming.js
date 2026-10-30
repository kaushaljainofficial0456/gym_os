// ============================================================
// SET TIMING — validates the per-set timestamps the workout screen sends
// and derives rest and tick intervals from them (docs/CALORIE_DATA_CAPTURE.md).
//
// Pure: no DB. Runs inside workout completion, after the sets are known.
// Nothing here changes a session's duration or its calorie estimate. It
// records what was measured, what was not, and why a timestamp was not
// trusted. A timestamp that fails a check is dropped (stored as NULL with
// a flag), never repaired or guessed.
//
// Clock: every set timestamp is the PHONE's clock. They are checked against
// the phone's own session window (client_started_at .. client_finished_at)
// so a phone whose clock is off from the server's is still self-consistent.
// Without that window they are checked against the server's window, with a
// wider tolerance, and flagged when they fall outside it.
//
// The thresholds below are data-quality limits -- when a timestamp is
// believable -- not physiology, and never enter a calorie calculation.
// ============================================================

export const TIMING_VERSION = 1;
const WINDOW_TOLERANCE_MS = 60 * 1000;          // phone window slack
const SERVER_WINDOW_TOLERANCE_MS = 5 * 60 * 1000; // no phone window: wider slack
export const MAX_SET_SECONDS = 600;              // a single set longer than 10 min is not a set
export const MAX_REST_SECONDS = 30 * 60;         // a gap beyond 30 min is an interruption, not rest
export const IDLE_TAIL_SECONDS = 15 * 60;        // timer still running after the last set
export const IDLE_HEAD_SECONDS = 20 * 60;        // timer started long before the first set
export const LONG_PAUSE_SECONDS = 30 * 60;
const MAX_ACTIVE_SECONDS = 4 * 3600;

const ms = (v) => {
  if (v == null || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (t) => (t == null ? null : new Date(t).toISOString());
const round1 = (v) => Math.round(v * 10) / 10;

/** Milliseconds of [a, b] covered by the pause intervals. */
export function pausedOverlapMs(a, b, pauses) {
  let total = 0;
  for (const p of pauses) {
    const s = Math.max(a, p.start);
    const e = Math.min(b, p.end);
    if (e > s) total += e - s;
  }
  return total;
}

/** Pause intervals from the client, validated: ordered, non-negative,
 *  inside the window. An unfinished pause is closed at the window end. */
function cleanPauses(raw, windowStart, windowEnd, flags) {
  const out = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    const s = ms(p?.started_at);
    let e = ms(p?.ended_at);
    if (s == null) { flags.add('pause_invalid'); continue; }
    if (e == null) e = windowEnd ?? s;
    if (e < s || (windowStart != null && s < windowStart - WINDOW_TOLERANCE_MS) || (windowEnd != null && e > windowEnd + WINDOW_TOLERANCE_MS)) {
      flags.add('pause_invalid');
      continue;
    }
    out.push({ start: s, end: e });
  }
  out.sort((x, y) => x.start - y.start);
  return out;
}

/**
 * @param {object} p
 *   sets: [{ key, started_at?, completed_at? }] -- one per COMPLETED set, any order
 *   pauses: [{ started_at, ended_at? }]
 *   clientWindow: { started_at, finished_at } -- the phone's own session clock, optional
 *   serverWindow: { started_at, completed_at } -- the server's view, optional
 *   activeSeconds: the active duration the phone reported (wall clock minus pauses)
 * @returns { perSet: Map<key, {...}>, session: {...} }
 */
export function analyzeSessionTiming({ sets = [], pauses = [], clientWindow = null, serverWindow = null, activeSeconds = null } = {}) {
  const sessionFlags = new Set();
  let wStart = ms(clientWindow?.started_at);
  let wEnd = ms(clientWindow?.finished_at);
  let tolerance = WINDOW_TOLERANCE_MS;
  if (wStart == null || wEnd == null || wEnd < wStart) {
    sessionFlags.add('client_window_missing');
    wStart = ms(serverWindow?.started_at);
    wEnd = ms(serverWindow?.completed_at);
    tolerance = SERVER_WINDOW_TOLERANCE_MS;
  }
  const cleanP = cleanPauses(pauses, wStart, wEnd, sessionFlags);
  const pausedTotalMs = cleanP.reduce((t, p) => t + (p.end - p.start), 0);

  const inWindow = (t) => t != null && (wStart == null || t >= wStart - tolerance) && (wEnd == null || t <= wEnd + tolerance);

  // 1. validate each set on its own
  const rows = sets.map((s) => {
    const flags = new Set();
    let start = ms(s.started_at);
    let done = ms(s.completed_at);
    if (s.completed_at != null && done == null) flags.add('completed_at_invalid');
    if (s.started_at != null && start == null) flags.add('started_at_invalid');
    if (done != null && !inWindow(done)) { flags.add('completed_outside_session'); done = null; }
    if (start != null && !inWindow(start)) { flags.add('started_outside_session'); start = null; }
    if (start != null && done == null) { flags.add('start_without_completion'); start = null; }
    if (start != null && done != null) {
      const secs = (done - start) / 1000;
      if (secs < 0) { flags.add('started_after_completed'); start = null; }
      else if (secs > MAX_SET_SECONDS) { flags.add('set_too_long'); start = null; }
    }
    if (done == null && !flags.size) flags.add('no_completion_time');
    return { key: s.key, start, done, flags };
  });

  // 2. order by completion time (supersets interleave exercises) and
  //    derive the intervals between consecutive completed sets
  const timed = rows.filter((r) => r.done != null).sort((a, b) => a.done - b.done);
  for (let i = 0; i < timed.length; i++) {
    const r = timed[i];
    const prev = timed[i - 1];
    r.actualRest = null;
    r.tickInterval = null;
    if (!prev) continue;
    if (r.start != null && r.start < prev.done) {
      r.flags.add('overlaps_previous_set');
      r.start = null;
    }
    const tickPaused = pausedOverlapMs(prev.done, r.done, cleanP);
    r.tickInterval = round1((r.done - prev.done - tickPaused) / 1000);
    if (tickPaused > 0) r.flags.add('interval_excludes_pause');
    if (r.start != null) {
      const restPaused = pausedOverlapMs(prev.done, r.start, cleanP);
      const rest = (r.start - prev.done - restPaused) / 1000;
      if (rest > MAX_REST_SECONDS) r.flags.add('rest_exceeds_limit');
      else r.actualRest = round1(rest);
    }
    if (r.tickInterval > MAX_REST_SECONDS + MAX_SET_SECONDS) {
      r.flags.add('interval_exceeds_limit');
      r.tickInterval = null;
    }
  }

  // 3. session-level checks -- recorded, never acted on
  const withDone = rows.filter((r) => r.done != null).length;
  const withStart = rows.filter((r) => r.start != null).length;
  if (rows.length && withDone === 0) sessionFlags.add('no_set_timestamps');
  else if (withDone < rows.length) sessionFlags.add('partial_set_timestamps');
  if (cleanP.length) sessionFlags.add('interrupted');
  if (cleanP.some((p) => (p.end - p.start) / 1000 > LONG_PAUSE_SECONDS)) sessionFlags.add('long_pause');
  if (activeSeconds == null || !(activeSeconds > 0)) sessionFlags.add('duration_missing_or_zero');
  else if (activeSeconds > MAX_ACTIVE_SECONDS) sessionFlags.add('duration_exceeds_limit');
  if (timed.length && wEnd != null) {
    const last = timed[timed.length - 1].done;
    const tail = (wEnd - last - pausedOverlapMs(last, wEnd, cleanP)) / 1000;
    if (tail > IDLE_TAIL_SECONDS) sessionFlags.add('idle_tail');
  }
  if (timed.length && wStart != null) {
    const first = Math.min(...timed.map((r) => r.start ?? r.done));
    const head = (first - wStart - pausedOverlapMs(wStart, first, cleanP)) / 1000;
    if (head > IDLE_HEAD_SECONDS) sessionFlags.add('idle_head');
  }
  if (timed.length >= 2 && activeSeconds > 0) {
    const first = Math.min(...timed.map((r) => r.start ?? r.done));
    const last = timed[timed.length - 1].done;
    const span = (last - first - pausedOverlapMs(first, last, cleanP)) / 1000;
    if (activeSeconds + WINDOW_TOLERANCE_MS / 1000 < span) sessionFlags.add('duration_shorter_than_sets');
  }

  const perSet = new Map(rows.map((r) => [r.key, {
    set_started_at: iso(r.start),
    set_completed_at: iso(r.done),
    actual_rest_seconds: r.actualRest ?? null,
    tick_interval_seconds: r.tickInterval ?? null,
    timing_flags: r.flags.size ? [...r.flags].sort().join('|') : null,
  }]));
  return {
    perSet,
    session: {
      version: TIMING_VERSION,
      flags: [...sessionFlags].sort(),
      sets: rows.length,
      sets_with_completion_time: withDone,
      sets_with_start_time: withStart,
      sets_with_actual_rest: timed.filter((r) => r.actualRest != null).length,
      pauses: cleanP.map((p) => ({ started_at: iso(p.start), ended_at: iso(p.end) })),
      paused_seconds: round1(pausedTotalMs / 1000),
      active_seconds_reported: activeSeconds ?? null,
      clock: tolerance === WINDOW_TOLERANCE_MS ? 'client_window' : 'server_window',
    },
  };
}
