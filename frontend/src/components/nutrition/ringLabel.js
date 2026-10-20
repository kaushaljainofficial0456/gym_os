/**
 * How big the number in the middle of a ring can be.
 *
 * The centre of a ring is a CIRCLE, and a label is a box: what has to fit
 * is the box's corners, not just its width. Sizing the number from the
 * ring's outer size (size * 0.15) put "2,550" across the innermost ring --
 * a four-digit "kcal left" ran into the fat ring on the Nutrition dial and
 * filled the Home ring edge to edge. So the size comes from the hole and
 * from how wide THIS number is: "340" can be large, "12,480" cannot.
 *
 * Widths are in em for a tabular grotesk: a digit is ~0.6em, the
 * thousands comma ~0.3em. Deliberately a little generous, so the result
 * errs towards breathing room.
 */
const EM = { digit: 0.6, comma: 0.3, other: 0.62 };

export function textEm(text) {
  let em = 0;
  for (const ch of String(text)) {
    if (/\d/.test(ch)) em += EM.digit;
    else if (ch === ',' || ch === '.') em += EM.comma;
    else em += EM.other;
  }
  return em;
}

/**
 * Font size (px) for `text` inside a hole of `holeRadius` px, alongside
 * `belowPx` of smaller lines underneath it. Never above `max`, never below
 * `min`; the corners of the whole label block stay inside the circle.
 */
export function fitRingNumber(text, { holeRadius, belowPx = 0, max, min = 12 }) {
  const em = Math.max(textEm(text), EM.digit);
  const hi = Math.min(max, (holeRadius * 1.7) / em);
  // Shrink until the label block's corner is inside the hole.
  for (let f = Math.floor(hi); f > min; f -= 1) {
    const halfW = (em * f) / 2;
    const halfH = (f + belowPx) / 2;
    if (halfW * halfW + halfH * halfH <= holeRadius * holeRadius * 0.92) return f;
  }
  return min;
}
