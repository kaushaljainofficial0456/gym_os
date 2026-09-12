/**
 * Unit conversion is the kind of code that is either exactly right or
 * quietly wrong for months, so the properties that matter are pinned
 * here rather than eyeballed on one screen.
 *
 * The two failures this guards against are the ones the spec calls out:
 * double conversion, and drift from round-tripping a stored value
 * through a display unit.
 */
import { describe, it, expect } from 'vitest';
import {
  formatWeight, formatWeightDelta, weightValue, parseWeightToKg,
  formatLength, parseLengthToCm, formatHeight,
  weightUnit, lengthUnit, normalizeSystem, kgToLb, lbToKg,
} from '../src/units.js';

describe('weight display', () => {
  it('leaves metric alone', () => {
    expect(formatWeight(75, 'metric')).toBe('75 kg');
    expect(formatWeight(74.6, 'metric')).toBe('74.6 kg');
  });

  it('converts to pounds', () => {
    expect(formatWeight(75, 'imperial')).toBe('165.3 lb');
    expect(formatWeight(100, 'imperial')).toBe('220.5 lb');
  });

  it('states absence as absence rather than a bare unit', () => {
    // "— " beats "NaN lb", and beats "0 kg", which is a claim.
    expect(formatWeight(null, 'metric')).toBe('—');
    expect(formatWeight(undefined, 'imperial')).toBe('—');
    expect(formatWeight('', 'metric')).toBe('—');
    expect(weightValue(null, 'metric')).toBeNull();
  });

  it('treats an unknown system as metric rather than throwing', () => {
    expect(formatWeight(75, undefined)).toBe('75 kg');
    expect(formatWeight(75, 'klingon')).toBe('75 kg');
    expect(normalizeSystem('imperial')).toBe('imperial');
  });
});

describe('weight deltas keep their sign', () => {
  it('never turns a loss into a gain', () => {
    // The whole product shows progress deltas; dropping the minus would
    // read as the opposite of what happened.
    expect(formatWeightDelta(-6.6, 'metric')).toBe('-6.6 kg');
    expect(formatWeightDelta(2.1, 'metric')).toBe('+2.1 kg');
    expect(formatWeightDelta(-6.6, 'imperial')).toBe('-14.6 lb');
  });

  it('shows no sign for no change', () => {
    expect(formatWeightDelta(0, 'metric')).toBe('0 kg');
  });
});

describe('input parsing returns canonical kg', () => {
  it('passes metric straight through', () => {
    expect(parseWeightToKg('75', 'metric')).toBe(75);
  });

  it('converts typed pounds back to kg', () => {
    expect(parseWeightToKg('165.3', 'imperial')).toBeCloseTo(74.98, 1);
  });

  it('rejects nonsense instead of storing NaN', () => {
    expect(parseWeightToKg('abc', 'metric')).toBeNull();
    expect(parseWeightToKg('', 'imperial')).toBeNull();
    expect(parseWeightToKg(null, 'metric')).toBeNull();
  });
});

describe('no drift and no double conversion', () => {
  it('survives a display -> input round trip', () => {
    // Someone sees their weight in lb, retypes what they see, and saves.
    // The stored kg must come back essentially unchanged.
    const stored = 75;
    const shown = weightValue(stored, 'imperial');       // 165.3
    const backToKg = parseWeightToKg(String(shown), 'imperial');
    expect(backToKg).toBeCloseTo(stored, 1);
  });

  it('converts exactly, not approximately', () => {
    // Both factors are exact by definition; a sloppy constant (2.2, 0.45)
    // would fail this.
    expect(kgToLb(1)).toBeCloseTo(2.2046226, 6);
    expect(lbToKg(1)).toBeCloseTo(0.45359237, 8);
    expect(lbToKg(kgToLb(123.456))).toBeCloseTo(123.456, 10);
  });

  it('formatting twice does not convert twice', () => {
    // Guards the actual double-conversion bug: formatting is a pure read
    // of a canonical value, so repeating it changes nothing.
    const once = formatWeight(80, 'imperial');
    const twice = formatWeight(80, 'imperial');
    expect(once).toBe(twice);
    expect(once).toBe('176.4 lb');
  });
});

describe('length and height', () => {
  it('converts lengths', () => {
    expect(formatLength(90, 'metric')).toBe('90 cm');
    expect(formatLength(90, 'imperial')).toBe('35.4 in');
    expect(parseLengthToCm('35.4', 'imperial')).toBeCloseTo(89.9, 1);
  });

  it('writes height the way people say it', () => {
    // 175 cm is "5′9″", not "68.9 in" -- nobody states their height in
    // total inches.
    expect(formatHeight(175, 'imperial')).toBe('5′9″');
    expect(formatHeight(175, 'metric')).toBe('175 cm');
    expect(formatHeight(183, 'imperial')).toBe('6′0″');
    expect(formatHeight(null, 'imperial')).toBe('—');
  });

  it('labels units correctly', () => {
    expect(weightUnit('imperial')).toBe('lb');
    expect(weightUnit('metric')).toBe('kg');
    expect(lengthUnit('imperial')).toBe('in');
    expect(lengthUnit('metric')).toBe('cm');
  });
});
