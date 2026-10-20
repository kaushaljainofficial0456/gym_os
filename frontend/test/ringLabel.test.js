import { describe, it, expect } from 'vitest';
import { fitRingNumber, textEm } from '../src/components/nutrition/ringLabel.js';

// The label block's corners must sit inside the ring's hole.
const fits = (text, f, holeRadius, belowPx) => {
  const halfW = (textEm(text) * f) / 2;
  const halfH = (f + belowPx) / 2;
  return Math.hypot(halfW, halfH) <= holeRadius;
};

describe('fitRingNumber', () => {
  it('keeps a four-digit kcal figure inside the Nutrition dial', () => {
    const f = fitRingNumber('2,550', { holeRadius: 216 * 0.235, belowPx: 30, max: 27 });
    expect(fits('2,550', f, 216 * 0.235, 30)).toBe(true);
    expect(f).toBeGreaterThanOrEqual(20);
  });

  it('shrinks as the number gets wider, never grows past max', () => {
    const opts = { holeRadius: 32, belowPx: 15, max: 20 };
    const short = fitRingNumber('340', opts);
    const long = fitRingNumber('12,480', opts);
    expect(short).toBe(20);
    expect(long).toBeLessThan(short);
    expect(fits('12,480', long, 32, 15)).toBe(true);
  });

  it('has a floor so a huge number is still readable', () => {
    expect(fitRingNumber('123,456,789', { holeRadius: 20, belowPx: 15, max: 20, min: 12 })).toBe(12);
  });
});
