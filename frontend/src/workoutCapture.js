// Measured capture during a live workout (docs/CALORIE_DATA_CAPTURE.md).
//
// Records WHEN things happen, on the phone's clock, so the backend can
// derive real rest between sets and check the session timer -- instead of
// the planned rest the app used to store as if it had been taken. Pure
// functions over the set rows and pause list the workout screen already
// keeps; the server validates everything (services/workoutTiming.js).
//
// Nothing here affects the calorie estimate or anything displayed.

/** Optional "start set" tap. A set already ticked keeps its times. */
export function startSet(row, now = Date.now()) {
  if (!row || row.done) return row;
  return { ...row, startedAt: now };
}

/** Tick / untick. Ticking stamps the completion time; unticking clears
 *  both stamps, because a set that is redone will be started again. */
export function toggleSetDone(row, now = Date.now()) {
  if (!row) return row;
  if (row.done) {
    const { completedAt: _c, startedAt: _s, reportedRir: _r, ...rest } = row;
    return { ...rest, done: false };
  }
  return { ...row, done: true, completedAt: now };
}

/** Optional reps-in-reserve after a ticked set; null clears it. */
export function setReportedRir(row, value) {
  if (!row?.done) return row;
  const v = value == null || value === '' ? null : Number(value);
  return { ...row, reportedRir: Number.isInteger(v) && v >= 0 && v <= 10 ? v : null };
}

const iso = (t) => (Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : undefined);

/** One ticked set as the completion payload expects it. Absent
 *  measurements are omitted, never sent as zero or guessed. */
export function setPayload(row, i) {
  const out = {
    set_number: i + 1,
    actual_reps: Number(row.reps) || 0,
    actual_weight: Number(row.weight) || 0,
  };
  const s = iso(row.startedAt);
  const c = iso(row.completedAt);
  if (c) out.completed_at = c;
  if (s && c && row.startedAt <= row.completedAt) out.started_at = s;
  if (Number.isInteger(row.reportedRir)) out.reported_rir = row.reportedRir;
  return out;
}

/** Pause intervals: [{ start, end|null }] in ms. */
export function beginPause(pauses = [], now = Date.now()) {
  const open = pauses.length && pauses[pauses.length - 1].end == null;
  return open ? pauses : [...pauses, { start: now, end: null }];
}

export function endPause(pauses = [], now = Date.now()) {
  if (!pauses.length || pauses[pauses.length - 1].end != null) return pauses;
  return [...pauses.slice(0, -1), { ...pauses[pauses.length - 1], end: now }];
}

/** For the payload: an open pause is closed at `now` (the session is ending). */
export function pausesPayload(pauses = [], now = Date.now()) {
  return pauses
    .filter((p) => Number.isFinite(p.start))
    .map((p) => ({ started_at: iso(p.start), ended_at: iso(p.end ?? now) }));
}
