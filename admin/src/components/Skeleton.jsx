// Shimmer loading placeholders -- replaces plain "Loading…" text so a
// page never shows a blank flash while its first fetch resolves.
export function SkeletonRows({ rows = 5, cols = 4 }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel-row" key={i} style={{ borderBottom: i < rows - 1 ? '1px solid var(--line)' : 'none' }}>
          {Array.from({ length: cols }).map((__, j) => (
            <div key={j} className="skel skel-text" style={{ width: j === 0 ? '28%' : `${14 + (j * 6) % 20}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }) {
  return (
    <div className="kpi-grid">
      {Array.from({ length: count }).map((_, i) => <div key={i} className="skel skel-card" />)}
    </div>
  );
}

export function SkeletonBlock({ height = 120 }) {
  return <div className="skel" style={{ height, borderRadius: 'var(--radius-lg)' }} />;
}
