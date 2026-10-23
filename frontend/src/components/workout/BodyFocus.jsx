/**
 * Today's muscles at a glance: a small front and back silhouette with the
 * regions this session works filled in. Decorative -- the session's
 * exercise list says the same thing in words -- so it is hidden from
 * assistive tech and takes no clicks, unlike the full interactive
 * MuscleMap it borrows its shapes from.
 */
import { MUSCLE_REGIONS, regionForMuscle } from '../MuscleMap.jsx';

const SILHOUETTE = [
  <circle key="h" cx="100" cy="26" r="15" />,
  <rect key="n" x="92" y="42" width="16" height="16" rx="4" />,
  <path key="t" d="M70 58 Q100 44 130 58 L126 214 Q100 226 74 214 Z" />,
  <path key="la" d="M60 84 Q54 122 60 150 L56 214 L68 216 L76 150 Z" />,
  <path key="ra" d="M140 84 Q146 122 140 150 L144 214 L132 216 L124 150 Z" />,
  <path key="lg" d="M82 216 Q100 222 118 216 L112 390 Q100 396 88 390 Z" />,
  <rect key="lf" x="74" y="386" width="20" height="9" rx="4" />,
  <rect key="rf" x="106" y="386" width="20" height="9" rx="4" />,
];

function Figure({ view, active }) {
  return (
    <svg viewBox="0 0 200 400" className="wk-body__fig">
      <g className="wk-body__base">{SILHOUETTE}</g>
      {MUSCLE_REGIONS[view].map((r) => (
        <path key={r.id} d={r.d} className={active.has(r.id) ? 'wk-body__on' : 'wk-body__off'} />
      ))}
    </svg>
  );
}

export default function BodyFocus({ muscles = [] }) {
  const active = new Set(muscles.map(regionForMuscle).filter(Boolean));
  return (
    <div className="wk-body" aria-hidden="true">
      <Figure view="front" active={active} />
      <Figure view="back" active={active} />
    </div>
  );
}
