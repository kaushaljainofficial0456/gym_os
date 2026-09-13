// ============================================================
// SKELETON — reusable loading placeholder component.
//
// Variants:
//   <Skeleton />           — basic rectangular block
//   <Skeleton.Text lines={3} />  — text-line placeholder
//   <Skeleton.Card rows={2} />   — card-shaped placeholder
//   <Skeleton.ExerciseCard />    — workout exercise card skeleton
//   <Skeleton.NutritionCard />   — nutrition meal card skeleton
//   <Skeleton.ProgressCard />    — progress stats/chart skeleton
//   <Skeleton.WeekStrip />       — workout week preview skeleton
//
// Uses the existing .skeleton CSS class from theme.css
// (shimmer animation, respects prefers-reduced-motion).
// ============================================================

/** Basic rectangular skeleton block. */
export function Skeleton({ width = '100%', height = 16, radius, className = '', style }) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{
        width,
        height,
        borderRadius: radius ?? 10,
        flexShrink: 0,
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

/** Multi-line text placeholder. Lines taper at the end. */
Skeleton.Text = function SkeletonText({ lines = 3, gap = 8, lastWidth = '60%', className = '' }) {
  return (
    <div className={`space-y-[${gap}px] ${className}`} style={{ gap }} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton"
          style={{
            height: i === 0 ? 14 : 12,
            width: i === lines - 1 ? lastWidth : '100%',
            borderRadius: 6,
          }}
        />
      ))}
    </div>
  );
};

/** Card-shaped skeleton with optional header + rows. */
Skeleton.Card = function SkeletonCard({ rows = 2, hasImage = false, className = '' }) {
  return (
    <div
      className={`card p-4 space-y-3 ${className}`}
      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
      aria-hidden="true"
    >
      {hasImage && (
        <div className="skeleton w-full aspect-[16/10] rounded-xl" />
      )}
      <div className="space-y-2">
        <div className="skeleton h-4 rounded-md" style={{ width: '70%' }} />
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="skeleton h-3 rounded-md"
            style={{ width: i === rows - 1 ? '55%' : '100%' }}
          />
        ))}
      </div>
    </div>
  );
};

/** Workout exercise card skeleton — matches the real exercise row shape. */
Skeleton.ExerciseCard = function SkeletonExerciseCard() {
  return (
    <div
      className="rounded-2xl border p-4 space-y-3"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
      aria-hidden="true"
    >
      <div className="flex items-center justify-between">
        <div className="space-y-1.5 flex-1">
          <div className="skeleton h-4 rounded-md" style={{ width: '65%' }} />
          <div className="skeleton h-3 rounded-md" style={{ width: '40%' }} />
        </div>
        <div className="skeleton w-8 h-8 rounded-full shrink-0" />
      </div>
      <div className="flex gap-2">
        <div className="skeleton h-6 rounded-lg flex-1" />
        <div className="skeleton h-6 rounded-lg flex-1" />
        <div className="skeleton h-6 rounded-lg flex-1" />
      </div>
    </div>
  );
};

/** Nutrition meal card skeleton — matches the real meal row shape. */
Skeleton.NutritionCard = function SkeletonNutritionCard() {
  return (
    <div
      className="rounded-2xl border p-4 space-y-2"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
      aria-hidden="true"
    >
      <div className="flex items-center justify-between">
        <div className="space-y-1.5 flex-1">
          <div className="skeleton h-4 rounded-md" style={{ width: '55%' }} />
          <div className="skeleton h-3 rounded-md" style={{ width: '35%' }} />
        </div>
        <div className="skeleton h-5 w-16 rounded-full shrink-0" />
      </div>
      <div className="flex gap-3">
        <div className="skeleton h-3 rounded-md w-12" />
        <div className="skeleton h-3 rounded-md w-12" />
        <div className="skeleton h-3 rounded-md w-12" />
      </div>
    </div>
  );
};

/** Progress stats/chart skeleton — matches stats cards + chart area. */
Skeleton.ProgressCard = function SkeletonProgressCard({ hasChart = true }) {
  return (
    <div
      className="card p-4 space-y-3"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
      aria-hidden="true"
    >
      <div className="skeleton h-3 rounded-md" style={{ width: '45%' }} />
      {hasChart ? (
        <div className="skeleton w-full h-32 rounded-xl" />
      ) : (
        <div className="space-y-2">
          <div className="skeleton h-3 rounded-md w-full" />
          <div className="skeleton h-3 rounded-md" style={{ width: '70%' }} />
        </div>
      )}
    </div>
  );
};

/** Week strip skeleton — matches the 7-day week preview grid. */
Skeleton.WeekStrip = function SkeletonWeekStrip() {
  return (
    <div
      className="card p-4 space-y-3"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
      aria-hidden="true"
    >
      <div className="flex items-center justify-between">
        <div className="skeleton h-3 rounded-md" style={{ width: '50%' }} />
        <div className="skeleton h-4 w-16 rounded-full" />
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="skeleton h-14 rounded-xl" />
        ))}
      </div>
    </div>
  );
};

/** Action button skeleton — matches the 3-button action grid. */
Skeleton.ActionGrid = function SkeletonActionGrid() {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      <div className="skeleton h-3 rounded-md" style={{ width: '35%' }} />
      <div className="grid grid-cols-3 gap-2.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="card p-4 flex flex-col items-center gap-2.5"
            style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
          >
            <div className="skeleton w-11 h-11 rounded-2xl" />
            <div className="skeleton h-3 rounded-md w-14" />
          </div>
        ))}
      </div>
    </div>
  );
};

export default Skeleton;
