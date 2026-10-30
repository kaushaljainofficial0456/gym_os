import { describe, expect, it } from 'vitest';
import { localDateKey, weightJump } from '../src/utils.js';

describe('localDateKey', () => {
  it('is the calendar day on this device, not the UTC day', () => {
    // A local date built from parts: 00:30 on the 5th must stay the 5th
    // whatever the machine's timezone, where toISOString() can say the 4th.
    expect(localDateKey(new Date(2026, 9, 5, 0, 30))).toBe('2026-10-05');
    expect(localDateKey(new Date(2026, 0, 1, 23, 59))).toBe('2026-01-01');
  });
});

describe('weightJump', () => {
  it('flags the classic typo', () => {
    expect(weightJump(22.7, 82.7)).toBeCloseTo(-60);
    expect(weightJump(182, 82)).toBeCloseTo(100);
  });
  it('lets ordinary weigh-ins through', () => {
    expect(weightJump(81.5, 82)).toBeNull();
    expect(weightJump(72, 82)).toBeNull(); // 12%: a big change, but real
  });
  it('has nothing to compare with on a first weigh-in', () => {
    expect(weightJump(82, null)).toBeNull();
    expect(weightJump(82, 0)).toBeNull();
  });
});
