/**
 * A gym's two colours -> a complete dark and light theme.
 *
 * The app is styled entirely through CSS custom properties (theme.css:
 * `:root` is dark, `.light` is light). A gym theme is the same property
 * names with new values, so every page, button, ring and chip follows
 * without a single component knowing a gym exists.
 *
 * THE TWO COLOURS HAVE ROLES, which is what makes any pair an owner picks
 * come out readable:
 *   MAIN (primary)    the brand colour itself: filled buttons, the active
 *                     tab, rings, links, focus. "Yellow" in yellow-and-black.
 *   SECOND (secondary) the ground it sits on: it tints the page and card
 *                     surfaces and the text. "Black" in yellow-and-black --
 *                     a navy second colour gives a navy-black app.
 *
 * What is never left to chance: every colour used AS TEXT is moved (in
 * lightness only, keeping its hue) until it clears WCAG AA on the surface
 * it sits on, in each theme. So a yellow gym gets yellow buttons with
 * black labels in both themes, yellow highlights in dark mode, and a deep
 * gold in light mode where yellow text on white would be unreadable. The
 * owner sees that in the live preview and is told when it happens.
 *
 * What is deliberately NOT branded: the metric hues (body, training,
 * food, sleep...), the good/warn/bad status colours and medals. They carry
 * meaning, and a gym's red must never make "over target" look like "on
 * brand".
 */
import {
  clamp, hexToRgb, rgbToHex, rgbToHsl, hslToRgb, contrast, luminance, mix, over, ensureContrast, inkOn, WHITE,
} from './color.js';

export const DEFAULT_SECONDARY = '#0B0B0C';

const hsl = (h, s, l) => hslToRgb([h, clamp(s), clamp(l)]);
const ch = (rgb) => rgb.map((v) => Math.round(v)).join(' ');
const rgba = (rgb, a) => `rgba(${rgb.map((v) => Math.round(v)).join(',')},${a})`;
const hex = rgbToHex;
const shade = (rgb, dl) => { const [h, s, l] = rgbToHsl(rgb); return hsl(h, s, l + dl); };

/** The page and card surfaces, tinted by the second colour. */
function grounds(S, mode) {
  const [h, s, l] = rgbToHsl(S);
  if (mode === 'dark') {
    // A dark second colour (black, navy, forest, maroon) IS a ground: the
    // app takes it on, held to a dark-theme range. A light one only tints.
    const deep = l < 0.3;
    const sat = Math.min(s, 0.5) * (deep ? 0.62 : 0.2);
    const base = deep ? clamp(l * 0.6, 0.04, 0.085) : 0.045;
    return {
      bg: hsl(h, sat, base), bg2: hsl(h, sat, base + 0.024),
      panel: hsl(h, sat * 0.92, base + 0.05), panel2: hsl(h, sat * 0.9, base + 0.085), h, s,
    };
  }
  const pale = l > 0.7;
  const sat = Math.min(s, 0.55) * (pale ? 0.6 : 0.2);
  const base = pale ? clamp(l, 0.94, 0.975) : 0.968;
  return {
    bg: hsl(h, sat, base), bg2: hsl(h, sat * 1.1, base - 0.038),
    panel: hsl(h, sat * 0.6, Math.min(0.997, base + 0.03)), panel2: hsl(h, sat * 0.8, Math.min(0.99, base + 0.014)), h, s,
  };
}

/** One theme's custom properties. */
function themeFor(P, S, mode) {
  const dark = mode === 'dark';
  const g = grounds(S, mode);
  const ink = dark ? hsl(g.h, Math.min(g.s, 0.3) * 0.35, 0.93) : hsl(g.h, Math.min(g.s, 0.4) * 0.45, 0.1);
  // The surface each kind of colour is worst on: light text loses most on
  // the lightest dark surface, dark text on the darkest light one.
  const worst = dark ? g.panel2 : g.bg2;

  // A main colour that vanishes into this theme's ground (white in light
  // mode, black in dark) hands over to the second colour if THAT shows --
  // a black-and-white gym gets white buttons at night and black by day.
  const shows = (c) => contrast(c, g.bg) >= 1.35;
  const base = shows(P) ? P : (shows(S) ? S : P);

  const accent = ensureContrast(base, worst, 4.6);
  const accentDeep = dark ? ensureContrast(shade(accent, -0.12), g.bg, 3) : shade(accent, -0.08);
  const fill = shows(base) ? base : accent;
  const fillInk = inkOn(fill);
  const fillLight = luminance(fill) > 0.5;
  const fillShade = luminance(fill) < 0.02 ? shade(fill, 0.06) : shade(fill, -0.07);

  // The second colour as a colour of its own, where the app uses one (the
  // page's background glow, a handful of highlights) -- only when it is a
  // real colour; black, white and greys hand that role to the accent.
  const [, sS, lS] = rgbToHsl(S);
  const secondary = sS > 0.25 && lS > 0.15 && lS < 0.85 ? ensureContrast(S, g.bg, 3) : accent;
  const tint = dark ? ink : hsl(g.h, Math.min(g.s, 0.3) * 0.5, 0.34);
  const shadowRgb = hsl(g.h, Math.min(g.s, 0.4) * 0.5, 0.18);

  const vars = {
    '--bg': hex(g.bg), '--bg2': hex(g.bg2), '--panel': hex(g.panel), '--panel2': hex(g.panel2),
    '--bg-rgb': ch(g.bg), '--bg2-rgb': ch(g.bg2), '--panel-rgb': ch(g.panel), '--panel2-rgb': ch(g.panel2),
    '--ink': hex(ink), '--ink-rgb': ch(ink),
    '--mute': rgba(ink, dark ? 0.68 : 0.72),
    '--faint': rgba(ink, dark ? 0.6 : 0.64),
    '--line': dark ? rgba(ink, 0.08) : hex(mix(g.bg, ink, 0.1)),
    '--field-edge': dark ? rgba(ink, 0.4) : hex(ensureContrast(mix(g.panel, ink, 0.42), g.panel, 3.1)),
    '--tint-rgb': ch(tint),

    '--accent': hex(accent), '--accent-rgb': ch(accent),
    '--accent-deep': hex(accentDeep), '--accent-deep-rgb': ch(accentDeep),
    '--accent-soft': rgba(accent, dark ? 0.14 : 0.1),
    '--accent-contrast': hex(inkOn(accent)),

    '--cta-solid': hex(fill),
    '--cta-ink': hex(fillInk),
    '--cta-edge': fillInk === WHITE ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.16)',
    '--accent-grad': `linear-gradient(135deg, ${hex(fillShade)}, ${hex(fill)})`,
    '--accent-grad-shadow': dark
      ? `0 1px 0 rgba(255,255,255,${fillLight ? 0.28 : 0.12}) inset, 0 8px 22px -12px ${rgba(fill, 0.6)}`
      : `0 4px 14px -4px ${rgba(fill, 0.34)}`,
    '--accent-grad-shadow-hover': dark
      ? `0 1px 0 rgba(255,255,255,${fillLight ? 0.34 : 0.16}) inset, 0 10px 26px -12px ${rgba(fill, 0.7)}`
      : `0 6px 20px -4px ${rgba(fill, 0.44)}`,

    '--secondary': hex(secondary), '--secondary-rgb': ch(secondary),
    '--secondary-deep': hex(shade(secondary, -0.08)), '--secondary-deep-rgb': ch(shade(secondary, -0.08)),
    '--secondary-soft': rgba(secondary, 0.1),

    '--card-shadow': dark
      ? `0 24px 48px -24px rgba(0,0,0,.6), inset 0 1px 0 ${rgba(ink, 0.04)}`
      : `0 1px 2px ${rgba(shadowRgb, 0.07)}, 0 8px 24px -12px ${rgba(shadowRgb, 0.14)}`,
    '--card-gradient': dark ? `linear-gradient(168deg, ${rgba(ink, 0.03)}, ${rgba(ink, 0.008)} 62%)` : 'none',
  };

  return {
    vars,
    themeColor: hex(g.bg),
    // Told to the owner in the studio: their main colour was deepened or
    // lifted for text in this theme (buttons still use it as picked).
    textAdjusted: contrast(base, worst) < 4.6,
    swapped: base !== P,
    sample: { bg: g.bg, panel: g.panel, panel2: g.panel2, ink, accent, fill, fillInk },
  };
}

/** { primary, secondary } (#RRGGBB) -> { dark, light } or null when the
 *  gym has no colours (the Barbell look). */
export function deriveBrand({ primary, secondary } = {}) {
  const P = hexToRgb(primary);
  if (!P) return null;
  const S = hexToRgb(secondary) || hexToRgb(DEFAULT_SECONDARY);
  return { dark: themeFor(P, S, 'dark'), light: themeFor(P, S, 'light') };
}

const block = (vars) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');

/**
 * The stylesheet that puts a derived brand on the whole app. Scoped to
 * html.gym-brand so removing one class is the whole of "back to Barbell".
 * `:not(.light)` rather than `.dark`, because before React has set either
 * class the page is dark. `.page-vivid` (Progress, Community) carries its
 * own teal accent at a higher specificity; a gym's colours win there too,
 * or those pages would be the only ones not in the gym's colours.
 */
export function brandCss(brand) {
  if (!brand) return '';
  return `html.gym-brand:not(.light),html.gym-brand:not(.light) .page-vivid{${block(brand.dark.vars)}}`
    + `html.gym-brand.light,html.gym-brand.light .page-vivid{${block(brand.light.vars)}}`;
}

/** The same theme as an inline style object, for a preview inside a page
 *  that is itself in another theme. */
export function previewStyle(brand, mode) {
  if (!brand) return undefined;
  return { ...brand[mode].vars, colorScheme: mode };
}

export { monogram } from './monogram.js';

// Starting points an owner can tap, chosen to cover how gyms actually
// dress: most are a bright colour on black, a few on white or navy.
export const PRESETS = [
  { id: 'gold-black', name: 'Gold & Black', primary: '#F5C518', secondary: '#0B0B0C' },
  { id: 'red-black', name: 'Red & Black', primary: '#E5222F', secondary: '#0B0B0C' },
  { id: 'orange-charcoal', name: 'Orange & Charcoal', primary: '#FF6A13', secondary: '#1C1D21' },
  { id: 'lime-black', name: 'Lime & Black', primary: '#A3E635', secondary: '#0B0B0C' },
  { id: 'royal-white', name: 'Royal & White', primary: '#2563EB', secondary: '#FFFFFF' },
  { id: 'gold-navy', name: 'Gold & Navy', primary: '#E8B23A', secondary: '#0B1F3A' },
  { id: 'crimson-white', name: 'Crimson & White', primary: '#C8102E', secondary: '#FFFFFF' },
  { id: 'teal-graphite', name: 'Teal & Graphite', primary: '#14B8A6', secondary: '#1F2328' },
  { id: 'purple-black', name: 'Purple & Black', primary: '#8B5CF6', secondary: '#0B0B0C' },
  { id: 'white-black', name: 'White & Black', primary: '#FFFFFF', secondary: '#0B0B0C' },
];

export { over };
