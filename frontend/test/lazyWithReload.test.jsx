import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isStaleCodeError, reloadForNewVersion } from '../src/lazyWithReload.js';

describe('a screen whose code vanished in a deploy', () => {
  beforeEach(() => { window.sessionStorage.clear(); vi.useRealTimers(); });

  it('recognises the browsers\' ways of saying the file is gone', () => {
    for (const msg of [
      'Failed to fetch dynamically imported module: https://x/assets/Workout-abc.js',
      'Importing a module script failed.',
      'error loading dynamically imported module',
      "Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of 'text/html'",
      'Unable to preload CSS for /assets/Nutrition-abc.css',
    ]) expect(isStaleCodeError(new Error(msg))).toBe(true);
    expect(isStaleCodeError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('reloads once, and shows the error if it happens again straight away', () => {
    const reload = vi.fn();
    expect(reloadForNewVersion(reload)).toBe(true);
    expect(reloadForNewVersion(reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a later deploy gets its own reload', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    reloadForNewVersion(reload);
    vi.advanceTimersByTime(31_000);
    expect(reloadForNewVersion(reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
