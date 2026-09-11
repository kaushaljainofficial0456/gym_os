/**
 * METRIC CHART — the one interactive time-series instrument the whole
 * Progress experience is built on.
 *
 * Deliberately ONE component rather than a chart per metric: every series
 * on Progress needs the same behaviours (scrub to a point, read the exact
 * value and date, see a trend line, see a goal marker, handle gaps), and
 * duplicating that per metric is how five charts end up behaving five
 * different ways.
 *
 * Drawn with an SVG path rather than a chart library: the series here are
 * small (tens to a few hundred points), the interaction is a single
 * scrub, and this keeps Progress off the 387 kB charts bundle.
 *
 * WHAT IT REFUSES TO DO:
 *  - it never interpolates across missing days into a confident straight
 *    line without saying so; gaps are visible as sparse points.
 *  - it never draws a trend line from too few points -- that decision is
 *    made upstream (trendEngine's `insufficient`) and passed in.
 *  - it never relies on colour alone: the scrubbed point is labelled with
 *    its real date and value, and the chart carries an accessible summary.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useId } from 'react';

// Tight side padding on purpose: the chart should fill its card like an
// instrument face. Generous insets made a 300px phone card render a
// ~230px plot floating in space.
const PAD = { top: 12, right: 6, bottom: 18, left: 6 };

function niceTicks(min, max, count = 3) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

function fmtDate(iso, style = 'short') {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return style === 'long'
    ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function MetricChart({
  points = [],            // [{ date, value }]
  smoothed = [],          // optional rolling-average overlay
  goal = null,            // optional horizontal target line
  markers = [],           // [{ date, label }] e.g. PR dates
  color = 'var(--accent)',
  unit = '',
  height = 190,
  decimals = 1,
  formatValue,
  ariaLabel,
}) {
  const [active, setActive] = useState(null);   // index of scrubbed point
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  // The viewBox is measured in REAL pixels rather than fixed 100 units.
  // With a fixed-unit viewBox the SVG has to stretch non-uniformly to fill
  // its container, which turns every circle (the scrub dot, the PR markers)
  // into an ellipse -- strokes can be rescued with vector-effect, radii
  // cannot. Measuring keeps the coordinate system 1:1 so round things stay
  // round at any width.
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
  const gradId = useId().replace(/:/g, '');

  const fmt = formatValue || ((v) => `${Number(v).toFixed(decimals)}${unit ? ` ${unit}` : ''}`);

  const geom = useMemo(() => {
    if (!points.length) return null;
    const xs = points.map((p) => Date.parse(`${p.date}T00:00:00Z`));
    const ys = points.map((p) => p.value);
    const allY = goal != null ? [...ys, goal] : ys;
    let minY = Math.min(...allY);
    let maxY = Math.max(...allY);
    if (minY === maxY) { minY -= 1; maxY += 1; }          // a flat series still needs a band
    const padY = (maxY - minY) * 0.12;
    minY -= padY; maxY += padY;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const spanX = maxX - minX || 1;

    const W = width || 320;                                // real px; see the measuring comment above
    const H = height;
    const px = (t) => PAD.left + ((t - minX) / spanX) * (W - PAD.left - PAD.right);
    const py = (v) => PAD.top + (1 - (v - minY) / (maxY - minY)) * (H - PAD.top - PAD.bottom);

    const coords = points.map((p, i) => ({ ...p, x: px(xs[i]), y: py(p.value) }));
    const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
    const area = coords.length
      ? `${line} L${coords[coords.length - 1].x.toFixed(2)},${H - PAD.bottom} L${coords[0].x.toFixed(2)},${H - PAD.bottom} Z`
      : '';
    const smoothCoords = smoothed
      .map((p) => ({ x: px(Date.parse(`${p.date}T00:00:00Z`)), y: py(p.value) }))
      .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y));
    const smoothLine = smoothCoords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');

    return {
      coords, line, area, smoothLine, W, H, minY, maxY,
      goalY: goal != null ? py(goal) : null,
      markerCoords: markers
        .map((m) => {
          const t = Date.parse(`${m.date}T00:00:00Z`);
          if (!Number.isFinite(t) || t < minX || t > maxX) return null;
          const nearest = coords.reduce((best, c) => (Math.abs(c.x - px(t)) < Math.abs(best.x - px(t)) ? c : best), coords[0]);
          return { ...m, x: px(t), y: nearest.y };
        })
        .filter(Boolean),
    };
  }, [points, smoothed, goal, markers, height, width]);

  if (!geom) return null;

  const onScrub = (clientX) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const xUnits = ratio * geom.W;
    let best = 0;
    let bestD = Infinity;
    geom.coords.forEach((c, i) => {
      const d = Math.abs(c.x - xUnits);
      if (d < bestD) { bestD = d; best = i; }
    });
    setActive(best);
  };

  const point = active != null ? geom.coords[active] : null;
  const prev = active != null && active > 0 ? geom.coords[active - 1] : null;
  const ticks = niceTicks(geom.minY, geom.maxY, 3);

  return (
    <div className="relative select-none" ref={wrapRef}>
      {/* Scrub readout. Placed ABOVE the chart in normal flow rather than
          as a floating tooltip: on a phone a floating tooltip sits under
          the user's own finger. */}
      <div className="mb-1.5 flex items-baseline justify-between" style={{ minHeight: 30 }}>
        {point ? (
          <>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>
                {fmtDate(point.date, 'long')}
              </div>
              <div className="text-[17px] font-bold tabular-nums leading-tight" style={{ color: 'var(--ink)' }}>
                {fmt(point.value)}
              </div>
            </div>
            {prev && (
              <div className="text-[11px] font-semibold tabular-nums" style={{ color: point.value === prev.value ? 'var(--faint)' : point.value > prev.value ? 'var(--warn)' : 'var(--good)' }}>
                {point.value > prev.value ? '+' : ''}{(point.value - prev.value).toFixed(decimals)}
              </div>
            )}
          </>
        ) : (
          <div className="text-[10.5px]" style={{ color: 'var(--faint)' }}>
            {points.length > 1 ? 'Touch the chart to read any day' : 'One reading so far'}
          </div>
        )}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${geom.W} ${geom.H}`}
        style={{ width: '100%', height, display: 'block', touchAction: 'pan-y' }}
        role="img"
        aria-label={ariaLabel || `Chart of ${points.length} readings from ${fmtDate(points[0].date)} to ${fmtDate(points[points.length - 1].date)}`}
        onMouseMove={(e) => onScrub(e.clientX)}
        onMouseLeave={() => setActive(null)}
        onTouchStart={(e) => onScrub(e.touches[0].clientX)}
        onTouchMove={(e) => onScrub(e.touches[0].clientX)}
        onTouchEnd={() => setActive(null)}
      >
        <defs>
          <linearGradient id={`g${gradId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal guides, deliberately faint -- they orient without competing. */}
        {ticks.map((t, i) => {
          const y = PAD.top + (1 - (t - geom.minY) / (geom.maxY - geom.minY)) * (geom.H - PAD.top - PAD.bottom);
          return <line key={i} x1={PAD.left} y1={y} x2={geom.W - PAD.right} y2={y} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />;
        })}

        {geom.goalY != null && (
          <line
            x1={PAD.left} y1={geom.goalY} x2={geom.W - PAD.right} y2={geom.goalY}
            stroke="var(--good)" strokeWidth="1" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" opacity="0.8"
          />
        )}

        {geom.area && <path d={geom.area} fill={`url(#g${gradId})`} />}

        {/* The smoothed trend sits UNDER the raw line and is visually
            quieter: it is an interpretation, the raw line is the record. */}
        {geom.smoothLine && (
          <path d={geom.smoothLine} fill="none" stroke={color} strokeWidth="1" opacity="0.35"
            strokeDasharray="4 3" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
        )}

        <path
          d={geom.line} fill="none" stroke={color} strokeWidth="2"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"
          // pathLength normalises every series to the same 1000 units so one
          // CSS draw rule works regardless of how long the real path is.
          pathLength="1000"
          className="metric-chart-line"
        />

        {geom.markerCoords.map((m, i) => (
          <circle key={`mk${i}`} cx={m.x} cy={m.y} r="4" fill="var(--bg)" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        ))}

        {/* A single reading gets a visible dot -- otherwise a one-point
            series renders as an invisible zero-length path. */}
        {geom.coords.length === 1 && (
          <circle cx={geom.coords[0].x} cy={geom.coords[0].y} r="4.5" fill={color} />
        )}

        {point && (
          <>
            <line x1={point.x} y1={PAD.top} x2={point.x} y2={geom.H - PAD.bottom}
              stroke={color} strokeWidth="1" opacity="0.45" vectorEffect="non-scaling-stroke" />
            <circle cx={point.x} cy={point.y} r="5" fill={color} stroke="var(--bg)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>

      <div className="mt-1 flex justify-between text-[9.5px] tabular-nums" style={{ color: 'var(--faint)' }}>
        <span>{fmtDate(points[0].date)}</span>
        <span>{fmtDate(points[points.length - 1].date)}</span>
      </div>
    </div>
  );
}
