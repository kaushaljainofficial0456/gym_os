// ============================================================
// TREND ENGINE — pure, reusable time-series maths for Progress.
//
// Every function here is deliberately DB-free and side-effect-free so the
// insight engine, the API layer and the tests can all share one
// implementation rather than each re-deriving "what changed".
//
// THE RULE THAT SHAPES EVERY FUNCTION: never return a trend that the data
// does not support. A slope from two points on consecutive days is noise
// wearing a trend's clothes, so functions return null (with a reason)
// rather than a confident-looking number. Callers render "not enough data
// yet", never a fabricated line.
// ============================================================

/** Minimum distinct points before a slope is meaningful at all. */
export const MIN_POINTS_FOR_TREND = 4;
/** Minimum days a series must span before a per-week rate is honest. */
export const MIN_DAYS_FOR_RATE = 7;

// Number(null) is 0 and Number('') is 0 -- coercing either into a real
// reading would put a phantom 0 kg into a weight series and drag the
// whole trend through the floor. Only actual numeric input counts.
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Normalizes [{date, value}] -- drops unusable rows, sorts by date, and
 *  collapses same-day duplicates to their mean (two weigh-ins on one day
 *  are one day's data point, not two points of "trend"). */
export function normalizeSeries(rows, { dateKey = 'date', valueKey = 'value' } = {}) {
  const byDate = new Map();
  for (const r of rows || []) {
    const d = r?.[dateKey];
    const v = num(r?.[valueKey]);
    if (!d || v == null) continue;
    const day = String(d).slice(0, 10);
    const bucket = byDate.get(day) || { sum: 0, n: 0 };
    bucket.sum += v; bucket.n += 1;
    byDate.set(day, bucket);
  }
  return [...byDate.entries()]
    .map(([date, b]) => ({ date, value: b.sum / b.n }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function sliceByDays(series, days) {
  if (!days || !series.length) return series;
  const last = Date.parse(`${series[series.length - 1].date}T00:00:00Z`);
  const cutoff = last - (days - 1) * 86400000;
  return series.filter((p) => Date.parse(`${p.date}T00:00:00Z`) >= cutoff);
}

/** Centred rolling average -- the "smoothed trend" line drawn UNDER the
 *  raw points. Kept visually distinct from the raw series by the UI: one
 *  is a measurement, the other is an interpretation. */
export function rollingAverage(series, window = 7) {
  if (!series.length) return [];
  const half = Math.floor(window / 2);
  return series.map((p, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(series.length - 1, i + half);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += series[j].value;
    return { date: p.date, value: sum / (to - from + 1) };
  });
}

/** Least-squares slope in units PER DAY, using real calendar gaps so a
 *  series with missing days is not silently treated as evenly spaced. */
export function linearSlopePerDay(series) {
  if (series.length < 2) return null;
  const t0 = Date.parse(`${series[0].date}T00:00:00Z`);
  const xs = series.map((p) => (Date.parse(`${p.date}T00:00:00Z`) - t0) / 86400000);
  const ys = series.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let numr = 0; let den = 0;
  for (let i = 0; i < n; i++) { numr += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;   // every point on the same day
  return numr / den;
}

export function stdDev(values) {
  if (values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

/**
 * The full picture of one metric over one window.
 * `insufficient` is a first-class outcome, not an error: it tells the UI
 * exactly what to say instead of drawing a meaningless line.
 */
export function analyzeSeries(rows, { days = null, dateKey = 'date', valueKey = 'value', smoothing = 7 } = {}) {
  const all = normalizeSeries(rows, { dateKey, valueKey });
  const series = days ? sliceByDays(all, days) : all;
  if (!series.length) {
    return { points: [], count: 0, insufficient: true, reason: 'no_data' };
  }

  const values = series.map((p) => p.value);
  const first = series[0];
  const last = series[series.length - 1];
  const spanDays = (Date.parse(`${last.date}T00:00:00Z`) - Date.parse(`${first.date}T00:00:00Z`)) / 86400000;

  const enoughPoints = series.length >= MIN_POINTS_FOR_TREND;
  const enoughSpan = spanDays >= MIN_DAYS_FOR_RATE;
  const slopePerDay = enoughPoints ? linearSlopePerDay(series) : null;

  return {
    points: series,
    smoothed: series.length >= 3 ? rollingAverage(series, smoothing) : [],
    count: series.length,
    spanDays,
    current: last.value,
    currentDate: last.date,
    first: first.value,
    firstDate: first.date,
    change: last.value - first.value,
    changePercent: first.value !== 0 ? ((last.value - first.value) / Math.abs(first.value)) * 100 : null,
    min: Math.min(...values),
    max: Math.max(...values),
    average: values.reduce((a, b) => a + b, 0) / values.length,
    volatility: stdDev(values),
    // Per-week rate is the number people actually reason with ("0.4 kg a
    // week"), but it is only honest once the series spans a real week.
    ratePerWeek: slopePerDay != null && enoughSpan ? slopePerDay * 7 : null,
    slopePerDay,
    direction: slopePerDay == null ? null : slopePerDay > 0 ? 'up' : slopePerDay < 0 ? 'down' : 'flat',
    // One point is a reading, not a trend. Say so.
    insufficient: !enoughPoints,
    reason: !enoughPoints ? (series.length === 1 ? 'single_point' : 'too_few_points') : null,
    pointsNeeded: enoughPoints ? 0 : MIN_POINTS_FOR_TREND - series.length,
  };
}

/** Two windows of the same metric, for Compare mode. `previous` is the
 *  window immediately BEFORE `current`, never an overlapping one. */
export function comparePeriods(rows, { days, dateKey = 'date', valueKey = 'value' } = {}) {
  const all = normalizeSeries(rows, { dateKey, valueKey });
  if (!all.length || !days) return null;
  const lastMs = Date.parse(`${all[all.length - 1].date}T00:00:00Z`);
  const curFrom = lastMs - (days - 1) * 86400000;
  const prevFrom = curFrom - days * 86400000;
  const inRange = (p, from, to) => {
    const t = Date.parse(`${p.date}T00:00:00Z`);
    return t >= from && t <= to;
  };
  const cur = all.filter((p) => inRange(p, curFrom, lastMs));
  const prev = all.filter((p) => inRange(p, prevFrom, curFrom - 86400000));
  if (!cur.length || !prev.length) return null;   // nothing to compare against yet
  const mean = (arr) => arr.reduce((a, b) => a + b.value, 0) / arr.length;
  const c = mean(cur); const p = mean(prev);
  return {
    current: c, previous: p,
    change: c - p,
    changePercent: p !== 0 ? ((c - p) / Math.abs(p)) * 100 : null,
    currentDays: cur.length, previousDays: prev.length,
  };
}

/** Longest run of consecutive qualifying days ending at/near today, plus
 *  the best run ever seen. `dates` is a set/array of YYYY-MM-DD strings. */
export function streak(dates, { today = null } = {}) {
  const set = new Set((dates || []).map((d) => String(d).slice(0, 10)));
  if (!set.size) return { current: 0, best: 0 };
  const sorted = [...set].sort();
  let best = 1; let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (Date.parse(`${sorted[i]}T00:00:00Z`) - Date.parse(`${sorted[i - 1]}T00:00:00Z`)) / 86400000;
    run = gap === 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  // The CURRENT streak only counts if it reaches today or yesterday --
  // otherwise it is a past streak the user already broke.
  const ref = today || new Date().toISOString().slice(0, 10);
  const refMs = Date.parse(`${ref}T00:00:00Z`);
  let current = 0;
  for (let i = 0; ; i++) {
    const day = new Date(refMs - i * 86400000).toISOString().slice(0, 10);
    if (set.has(day)) current++;
    else if (i === 0) continue;         // nothing logged yet today is fine
    else break;
  }
  return { current, best };
}

/** Progress toward a target, and an ETA that only appears when the trend
 *  is real AND actually heading the right way. */
export function goalProgress({ start, current, target, ratePerWeek }) {
  const s = num(start); const c = num(current); const t = num(target);
  if (c == null || t == null) return null;
  const remaining = t - c;
  const totalDistance = s != null ? t - s : null;
  const percent = totalDistance && totalDistance !== 0
    ? Math.max(0, Math.min(100, ((s - c) / (s - t)) * 100))
    : null;
  let weeksToTarget = null;
  if (ratePerWeek != null && Math.abs(ratePerWeek) > 1e-6) {
    const w = remaining / ratePerWeek;
    // Negative => the current trend moves AWAY from the target; an ETA
    // would be nonsense, so there isn't one.
    if (w > 0 && w < 260) weeksToTarget = w;
  }
  return { current: c, target: t, start: s, remaining, percent, weeksToTarget };
}
