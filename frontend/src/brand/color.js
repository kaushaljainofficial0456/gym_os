/**
 * Colour arithmetic for gym themes: parsing, HSL, WCAG contrast, and
 * "move this colour just far enough to be readable on that ground".
 * Plain functions on [r, g, b] arrays (0-255) -- no DOM, unit-tested.
 */

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

export function rgbToHsl([r, g, b]) {
  const R = r / 255; const G = g / 255; const B = b / 255;
  const max = Math.max(R, G, B); const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb([h, s, l]) {
  const S = clamp(s); const L = clamp(l);
  if (S === 0) return [L * 255, L * 255, L * 255];
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const p = 2 * L - q;
  const hk = (((h % 360) + 360) % 360) / 360;
  const ch = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [ch(hk + 1 / 3) * 255, ch(hk) * 255, ch(hk - 1 / 3) * 255];
}

const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
/** WCAG relative luminance. */
export const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** WCAG contrast ratio, 1..21. */
export function contrast(a, b) {
  const la = luminance(a); const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** a -> b by t (0..1). */
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
/** What `fg` at `alpha` looks like painted over `bg`. */
export const over = (fg, alpha, bg) => mix(bg, fg, alpha);

/**
 * The closest colour to `fg` -- same hue and saturation, only lightness
 * moved -- that reaches `target` contrast on `bg`. Lighter on a dark
 * ground, darker on a light one. Returns `fg` untouched when it already
 * passes, so a gym's colour is only ever changed as much as reading needs.
 */
export function ensureContrast(fg, bg, target) {
  if (contrast(fg, bg) >= target) return fg;
  const [h, s, l] = rgbToHsl(fg);
  const extreme = luminance(bg) < 0.2 ? 1 : 0;
  const far = hslToRgb([h, s, extreme]);
  if (contrast(far, bg) < target) return far;
  let fail = l; let pass = extreme; let best = far;
  for (let i = 0; i < 26; i += 1) {
    const mid = (fail + pass) / 2;
    const c = hslToRgb([h, s, mid]);
    if (contrast(c, bg) >= target) { best = c; pass = mid; } else fail = mid;
  }
  return best;
}

export const WHITE = [255, 255, 255];
/** Text that sits ON a fill of this colour: near-black or white, whichever
 *  reads better. The better of the two always clears 4.5:1. */
export function inkOn(fill, dark = [12, 12, 14]) {
  return contrast(fill, WHITE) >= contrast(fill, dark) ? WHITE : dark;
}
