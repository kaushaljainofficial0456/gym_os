// A gym can pick ANY two colours. Whatever it picks, every piece of text
// in the app must still be readable in both themes -- that is the promise
// brandTheme.js makes, and these measure it, not eyeball it.
import { describe, it, expect } from 'vitest';
import { deriveBrand, brandCss, monogram, PRESETS } from '../src/brand/brandTheme.js';
import { hexToRgb, contrast, over, ensureContrast, rgbToHex, rgbToHsl, hslToRgb } from '../src/brand/color.js';

const rgbOf = (v) => {
  if (v.startsWith('#')) return hexToRgb(v);
  const m = /rgba\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)/.exec(v);
  return m ? { rgb: [+m[1], +m[2], +m[3]], a: +m[4] } : null;
};
const composite = (v, bg) => {
  const p = rgbOf(v);
  return Array.isArray(p) ? p : over(p.rgb, p.a, bg);
};

// Presets, the extremes, and the colours owners actually pick that are
// hardest to read: yellow on white, navy on black, mid-greys, pastel.
const PAIRS = [
  ...PRESETS.map((p) => [p.primary, p.secondary]),
  ['#FFFF00', '#FFFFFF'], ['#0B1F3A', '#000000'], ['#000000', '#000000'], ['#FFFFFF', '#FFFFFF'],
  ['#808080', '#808080'], ['#FFC0CB', '#F5F5DC'], ['#00FF00', '#FF00FF'], ['#7F1D1D', '#FDE68A'],
  ['#1E3A8A', '#F59E0B'], ['#06B6D4', '#0E7490'], ['#F97316', '#7C2D12'], ['#111827', '#F9FAFB'],
];

describe('deriveBrand keeps every text readable, whatever the gym picks', () => {
  for (const [primary, secondary] of PAIRS) {
    for (const mode of ['dark', 'light']) {
      it(`${primary} on ${secondary}, ${mode}`, () => {
        const t = deriveBrand({ primary, secondary })[mode].vars;
        const surfaces = ['--bg', '--bg2', '--panel', '--panel2'].map((k) => hexToRgb(t[k]));
        for (const s of surfaces) {
          expect(contrast(hexToRgb(t['--ink']), s)).toBeGreaterThanOrEqual(12);
          expect(contrast(composite(t['--mute'], s), s)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(composite(t['--faint'], s), s)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(hexToRgb(t['--accent']), s)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(composite(t['--field-edge'], hexToRgb(t['--panel'])), hexToRgb(t['--panel']))).toBeGreaterThanOrEqual(3);
        // Labels on the main colour's fills.
        expect(contrast(hexToRgb(t['--cta-ink']), hexToRgb(t['--cta-solid']))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(hexToRgb(t['--accent-contrast']), hexToRgb(t['--accent']))).toBeGreaterThanOrEqual(4.5);
        // Nothing malformed ever reaches the stylesheet.
        for (const [k, v] of Object.entries(t)) expect(String(v), k).not.toMatch(/NaN|undefined/);
      });
    }
  }
});

describe('the gym keeps its own colour wherever it can', () => {
  it('a yellow-and-black gym gets yellow buttons with black labels in both themes', () => {
    const b = deriveBrand({ primary: '#F5C518', secondary: '#0B0B0C' });
    for (const mode of ['dark', 'light']) {
      expect(b[mode].vars['--cta-solid']).toBe('#F5C518');
      expect(b[mode].vars['--cta-ink']).toBe('#0C0C0E');
    }
    // Yellow is readable as text at night, so it is used as is...
    expect(b.dark.vars['--accent']).toBe('#F5C518');
    expect(b.dark.textAdjusted).toBe(false);
    // ...and deepened (same hue) for text on a light ground.
    expect(b.light.textAdjusted).toBe(true);
    const [hp] = rgbToHsl(hexToRgb('#F5C518'));
    const [ha] = rgbToHsl(hexToRgb(b.light.vars['--accent']));
    expect(Math.abs(ha - hp)).toBeLessThan(2);
  });

  it('a black-and-white gym swaps by theme instead of vanishing', () => {
    const b = deriveBrand({ primary: '#FFFFFF', secondary: '#0B0B0C' });
    expect(b.dark.vars['--cta-solid']).toBe('#FFFFFF');
    expect(b.light.swapped).toBe(true);
    expect(b.light.vars['--cta-solid']).toBe('#0B0B0C');
  });

  it('a navy second colour gives a navy-tinted night theme, black stays neutral', () => {
    const navy = rgbToHsl(hexToRgb(deriveBrand({ primary: '#E8B23A', secondary: '#0B1F3A' }).dark.vars['--bg']));
    expect(navy[0]).toBeGreaterThan(200);
    expect(navy[0]).toBeLessThan(230);
    expect(navy[1]).toBeGreaterThan(0.2);
    const black = rgbToHsl(hexToRgb(deriveBrand({ primary: '#E8B23A', secondary: '#000000' }).dark.vars['--bg']));
    expect(black[1]).toBe(0);
  });

  it('no colours means no theme -- the Barbell look', () => {
    expect(deriveBrand({ primary: null, secondary: null })).toBeNull();
    expect(brandCss(null)).toBe('');
  });

  it('the stylesheet is scoped to html.gym-brand and covers the vivid pages', () => {
    const css = brandCss(deriveBrand({ primary: '#E5222F', secondary: '#0B0B0C' }));
    expect(css).toContain('html.gym-brand:not(.light),');
    expect(css).toContain('html.gym-brand.light .page-vivid{');
    expect(css).not.toMatch(/[<>]/);
  });
});

describe('colour helpers', () => {
  it('round-trips hex and HSL', () => {
    for (const h of ['#F5C518', '#0B1F3A', '#FFFFFF', '#000000', '#14B8A6']) {
      expect(rgbToHex(hslToRgb(rgbToHsl(hexToRgb(h))))).toBe(h);
    }
  });
  it('ensureContrast leaves a passing colour alone and moves a failing one only as far as needed', () => {
    const white = [255, 255, 255];
    expect(ensureContrast([20, 20, 20], white, 4.5)).toEqual([20, 20, 20]);
    const moved = ensureContrast(hexToRgb('#F5C518'), white, 4.5);
    const c = contrast(moved, white);
    expect(c).toBeGreaterThanOrEqual(4.5);
    expect(c).toBeLessThan(4.7);
  });
  it('monogram', () => {
    expect(monogram('Iron Forge')).toBe('IF');
    expect(monogram('Muscle')).toBe('MU');
    expect(monogram("Gold's Gym Andheri")).toBe('GS');
    expect(monogram('')).toBe('B');
  });
});
