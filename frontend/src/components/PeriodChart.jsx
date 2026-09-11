/**
 * PERIOD CHART — the "weekly trends" instrument: one labelled column per
 * day, values printed above, weekday + date beneath, today picked out.
 *
 * WHY THIS EXISTS ALONGSIDE MetricChart. They answer different questions
 * and so they are shaped differently:
 *
 *   MetricChart  a continuous quantity over a long window (90 days of
 *                body weight). Dense, scrubbable, one value per pixel-ish.
 *   PeriodChart  a handful of discrete days you want to READ, not scrub.
 *                Every value is printed, so nothing needs to be tapped to
 *                be known — which also means it works fine for someone who
 *                cannot hover or drag at all.
 *
 * Printing every value only works while the columns are few; past ~14 the
 * labels collide and MetricChart is the right tool. The caller chooses.
 *
 * Supports stacked series (macros, sleep stages, HR zones) with a legend.
 * Stacks are drawn bottom-up in the order given, so the legend order and
 * the visual order always match — a stacked chart whose legend is in a
 * different order to its segments is actively misleading.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react';

const PAD = { top: 26, bottom: 34, left: 4, right: 4 };

function fmtDayLabel(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { weekday: '', day: '' };
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    day: String(d.getDate()),
  };
}

export default function PeriodChart({
  /** [{ date, value }] for a single series, OR
   *  [{ date, parts: [{ key, value }] }] when `series` is supplied. */
  points = [],
  series = null,            // [{ key, label, color }] -> stacked
  color = 'var(--accent)',
  height = 190,
  unit = '',
  decimals = 0,
  formatValue,
  todayKey = null,          // highlight this date's column
  ariaLabel,
  /** Optional: called with the selected point's index, or null when the
   *  selection is cleared. Lets a caller render its own richer detail for
   *  the chosen day (Community shows workouts + PRs + members) without
   *  this component needing to know about those fields. Existing callers
   *  pass nothing and behave exactly as before. */
  onSelect = null,
}) {
  const gid = useId().replace(/:/g, '');
  const [active, setActive] = useState(null);
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!points.length) return null;

  const stacked = Array.isArray(series) && series.length > 0;
  const fmt = formatValue || ((v) => `${Number(v).toFixed(decimals)}${unit ? ` ${unit}` : ''}`);

  const totalOf = (p) => (stacked
    ? (p.parts || []).reduce((s, x) => s + (Number(x.value) || 0), 0)
    : (Number(p.value) || 0));

  const totals = points.map(totalOf);
  const maxV = Math.max(...totals, 0);
  // Bars are always read against zero. A floating baseline turns a 2%
  // difference into a visually dramatic one, which is a lie told with
  // geometry rather than numbers.
  const top = maxV > 0 ? maxV * 1.18 : 1;

  // Printed values are the whole point of this shape, but only while they
  // FIT. Below ~34px a column cannot hold a number like "1,240" without
  // colliding with its neighbour, so the labels step aside and the bars
  // carry the shape on their own -- measured rather than guessed from a
  // point count, because the same 12 columns fit on a tablet and not on a
  // 360px phone.
  const colW = width ? width / points.length : 0;
  const showValues = colW === 0 || colW >= 34;
  const showEveryDayLabel = colW === 0 || colW >= 26;

  const plotH = height - PAD.top - PAD.bottom;
  const yFor = (v) => PAD.top + (1 - v / top) * plotH;

  return (
    <div className="w-full">
      {stacked && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[.07em]"
              style={{ color: 'var(--faint)' }}>
              <span className="inline-block rounded-[2px]" style={{ width: 9, height: 9, background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}

      <div
        ref={wrapRef}
        className="flex w-full items-end gap-[3px] overflow-x-auto"
        style={{ height, scrollbarWidth: 'none' }}
        role="img"
        aria-label={ariaLabel || `${points.length} day chart`}
      >
        {points.map((p, i) => {
          const total = totals[i];
          const isToday = todayKey && p.date === todayKey;
          const { weekday, day } = fmtDayLabel(p.date);
          const barTop = yFor(total);
          const barH = Math.max(total > 0 ? 2 : 0, (height - PAD.bottom) - barTop);

          return (
            <button
              key={p.date}
              type="button"
              onClick={() => {
                const next = active === i ? null : i;
                setActive(next);
                onSelect?.(next);
              }}
              className="relative flex min-w-0 flex-1 shrink-0 flex-col items-center justify-end"
              style={{
                height,
                minWidth: 34,
                // Today gets a standing panel behind it rather than a
                // different bar colour: the column is marked without
                // implying its VALUE is a different kind of thing.
                background: isToday ? 'var(--bg2)' : 'transparent',
                borderRadius: 8,
              }}
              aria-label={`${weekday} ${day}: ${fmt(total)}`}
            >
              {/* Value printed above the bar — the whole point of this
                  chart shape is that nothing has to be tapped to be read. */}
              {showValues && (
                <span
                  className="absolute text-[10.5px] font-bold tabular-nums"
                  style={{ top: Math.max(2, barTop - 17), color: total > 0 ? color : 'var(--faint)' }}
                >
                  {total > 0 ? fmt(total) : '0'}
                </span>
              )}

              <span className="absolute" style={{ bottom: PAD.bottom, left: '50%', transform: 'translateX(-50%)', width: '58%', maxWidth: 18 }}>
                {stacked ? (
                  // Bottom-up, in the order the legend lists them.
                  (() => {
                    let acc = 0;
                    return (p.parts || []).map((part, pi) => {
                      const v = Number(part.value) || 0;
                      if (v <= 0) return null;
                      const segH = (v / top) * plotH;
                      const bottomOffset = (acc / top) * plotH;
                      acc += v;
                      const meta = series.find((sr) => sr.key === part.key);
                      const isTopSeg = acc >= total - 1e-6;
                      return (
                        <span
                          key={part.key}
                          className="absolute block w-full"
                          style={{
                            bottom: bottomOffset, height: Math.max(2, segH),
                            background: meta?.color || color,
                            borderTopLeftRadius: isTopSeg ? 4 : 0,
                            borderTopRightRadius: isTopSeg ? 4 : 0,
                            opacity: active != null && active !== i ? 0.5 : 1,
                          }}
                        />
                      );
                    });
                  })()
                ) : (
                  <span
                    className="block w-full"
                    style={{
                      height: barH, background: color, borderRadius: 4,
                      opacity: active != null && active !== i ? 0.45 : 1,
                      transition: 'opacity .2s ease',
                    }}
                  />
                )}
              </span>

              {/* Weekday over date, the way a calendar column reads. */}
              {/* When columns get tight the weekday drops first and only
                  every other date is printed -- an axis you cannot read is
                  worse than a sparser one you can. */}
              <span className="absolute bottom-1.5 flex flex-col items-center leading-none">
                {showValues && (
                  <span className="text-[9.5px]" style={{ color: isToday ? 'var(--ink)' : 'var(--faint)' }}>{weekday}</span>
                )}
                {(showEveryDayLabel || i % 2 === 0 || isToday) && (
                  <span className="mt-0.5 text-[10px] font-semibold tabular-nums" style={{ color: isToday ? 'var(--ink)' : 'var(--faint)' }}>{day}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tapping a stacked column breaks it down; a stacked bar you cannot
          decompose is decoration. */}
      {stacked && active != null && (
        <div className="mt-2 rounded-[var(--r-sm)] px-3 py-2" style={{ background: 'var(--bg2)' }}>
          <div className="text-[10px] font-semibold uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>
            {new Date(`${points[active].date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {(points[active].parts || []).map((part) => {
              const meta = series.find((sr) => sr.key === part.key);
              return (
                <span key={part.key} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--mute)' }}>
                  <span className="inline-block rounded-[2px]" style={{ width: 8, height: 8, background: meta?.color }} />
                  {meta?.label}
                  <strong className="tabular-nums" style={{ color: 'var(--ink)' }}>{fmt(part.value)}</strong>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
