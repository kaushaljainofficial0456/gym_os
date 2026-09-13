// ============================================================
// "THE +500 ML BUTTON STOPS WORKING" — once you hit your target.
//
// The running total was clamped with Math.min(target, ...). Reach your
// goal and every further tap computed the number you already had: the
// glass didn't move, the figure didn't change, no message explained it.
// Four litres on a hot day recorded three, and the button read as broken
// because tapping it genuinely did nothing.
//
// A target is a line to cross, not a ceiling on what happened. These
// tests hold that, and hold the floor too — Undo is offered whenever
// anything is logged, so below one step it used to send a negative figure
// the API refuses, turning "fix my mis-tap" into an error toast.
// ============================================================
import { describe, it, expect } from 'vitest';
import { nextWaterLitres } from '../src/pages/client/Nutrition.jsx';

describe('nextWaterLitres', () => {
  it('goes past the target, because people drink past their target', () => {
    // The whole bug: at a 3 L goal this used to return 3, forever.
    expect(nextWaterLitres(3, 0.5)).toBe(3.5);
    expect(nextWaterLitres(3.5, 0.5)).toBe(4);
  });

  it('adds a normal amount', () => {
    expect(nextWaterLitres(1, 0.25)).toBe(1.25);
    expect(nextWaterLitres(0, 0.5)).toBe(0.5);
  });

  it('undo below one step lands on zero, not a negative the API refuses', () => {
    expect(nextWaterLitres(0.1, -0.25)).toBe(0);
    expect(nextWaterLitres(0, -0.25)).toBe(0);
  });

  it('undo takes a step back', () => {
    expect(nextWaterLitres(1.5, -0.25)).toBe(1.25);
  });

  it('still respects the bound the API actually enforces', () => {
    // schemas.waterLog is z.number().min(0).max(20). Exceed it and the
    // write 422s, so a tap-storm must saturate rather than fail.
    expect(nextWaterLitres(19.9, 0.5)).toBe(20);
    expect(nextWaterLitres(20, 0.5)).toBe(20);
  });

  it('rounds to the centilitre instead of trailing float noise', () => {
    // 0.1 + 0.2 is 0.30000000000000004; that would be sent, stored and
    // rendered.
    expect(nextWaterLitres(0.1, 0.2)).toBe(0.3);
  });

  it('survives a missing reading', () => {
    // waterState is `water ?? (data ? data.water.litres : 0)` — null is
    // reachable before the first load resolves.
    expect(nextWaterLitres(null, 0.25)).toBe(0.25);
    expect(nextWaterLitres(undefined, 0.5)).toBe(0.5);
  });
});
