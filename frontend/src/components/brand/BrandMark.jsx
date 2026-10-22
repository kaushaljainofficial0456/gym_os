/**
 * The Barbell badge -- ring, bar and two plates a side -- as flat vector.
 *
 * Same geometry as the intro animation (barbell-intro/src/BarbellIntro.tsx,
 * a 240-unit badge with a 7.2-unit line), so the mark a member sees on the
 * sign-in screen is the one the app opened with. With `animate` it draws in
 * on the intro's own beats: the ring sweeps clockwise from 12 o'clock, the
 * bar draws out from the centre, then the plates rise onto it.
 *
 * With `glint`, once drawn, a single point of light travels the ring every
 * few seconds -- the only thing on the stage that moves after it settles.
 */
const STROKE = 7.2;
const BADGE = 240;
const RING_R = (BADGE - STROKE) / 2;
const BAR = 144;
const PLATES = [
  { id: 'big', x: 36, w: 10, h: 96 },
  { id: 'small', x: 51, w: 9, h: 64 },
];

export default function BrandMark({ animate = false, glint = false, className = '', title, ...rest }) {
  const c = BADGE / 2;
  return (
    <svg
      viewBox={`0 0 ${BADGE} ${BADGE}`}
      className={`brand-mark${animate ? ' brand-mark--draw' : ''}${className ? ` ${className}` : ''}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
      {...rest}
    >
      <circle
        className="bm-ring" cx={c} cy={c} r={RING_R}
        fill="none" stroke="currentColor" strokeWidth={STROKE}
        pathLength={1} transform={`rotate(-90 ${c} ${c})`}
      />
      {glint && (
        <circle
          className="bm-glint" cx={c} cy={c} r={RING_R}
          fill="none" strokeWidth={STROKE} pathLength={1}
        />
      )}
      <rect className="bm-bar" x={c - BAR / 2} y={c - STROKE / 2} width={BAR} height={STROKE} fill="currentColor" />
      {PLATES.flatMap((p) => [-1, 1].map((side) => (
        <rect
          key={`${p.id}${side}`}
          className={`bm-plate bm-plate--${p.id}`}
          x={c + side * p.x - p.w / 2} y={c - p.h / 2}
          width={p.w} height={p.h} rx={2}
          fill="currentColor"
        />
      )))}
    </svg>
  );
}
