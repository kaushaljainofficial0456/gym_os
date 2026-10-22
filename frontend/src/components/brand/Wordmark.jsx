/**
 * BARBELL, set in the intro's Cinzel ExtraBold outlines. With `animate`,
 * each letter opens vertically out of an invisible baseline, centre letter
 * first -- the intro's last beat, so the two read as one brand.
 */
import { CAP_HEIGHT, INK_LEFT, INK_WIDTH, LETTERS } from './wordmarkPaths.js';

const PAD = 40;          // font units above and below the caps, so serifs never clip
const CENTRE = 3;        // the R, middle of B-A-R-B-E-L-L

export default function Wordmark({ animate = false, delay = 0, className = '', title = 'Barbell' }) {
  return (
    <svg
      viewBox={`${INK_LEFT - 10} ${-PAD} ${INK_WIDTH + 20} ${CAP_HEIGHT + 2 * PAD}`}
      className={`wordmark${animate ? ' wordmark--open' : ''}${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={title}
    >
      {LETTERS.map((l, i) => (
        <g key={i} transform={`translate(${l.x} 0)`}>
          <path
            className="wm-letter"
            d={l.d}
            fill="currentColor"
            style={animate ? { animationDelay: `${delay + Math.abs(i - CENTRE) * 70}ms` } : undefined}
          />
        </g>
      ))}
    </svg>
  );
}
