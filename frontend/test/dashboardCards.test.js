/**
 * The customiser and the home screen have to agree, or the customiser is
 * a form attached to nothing -- which is exactly what it was. Profile
 * offered eight cards and saved an order and a hidden set; Home never
 * read the row, and four of the eight did not exist on Home in any form.
 *
 * These pin the contract that now joins them: whatever is stored,
 * resolveDashboard() produces one complete, correctly ordered list of
 * cards that actually exist.
 */
import { describe, it, expect } from 'vitest';
import { resolveDashboard, parseDashboardPrefs, DASH_KEYS, DEFAULT_ORDER, dashLabel } from '../src/dashboardCards.js';

describe('resolving a stored layout', () => {
  it('returns the full catalogue when nothing is stored', () => {
    // A client who has never opened the customiser must still get the
    // standard dashboard, not an empty one.
    const d = resolveDashboard([], []);
    expect(d.order).toEqual(DEFAULT_ORDER);
    expect(d.visible).toEqual(DEFAULT_ORDER);
    expect(d.hidden.size).toBe(0);
  });

  it('honours a saved order', () => {
    const d = resolveDashboard(['community', 'fuel', 'workout', 'burn', 'goal', 'crowd'], []);
    expect(d.visible[0]).toBe('community');
    expect(d.visible[1]).toBe('fuel');
  });

  it('drops cards that no longer exist', () => {
    // Real rows in the database still name 'water', 'sleep', 'coach' and
    // 'adherence' -- offered by the old customiser for months, rendered
    // by Home never. A stale key must not become a blank slot.
    const d = resolveDashboard(['water', 'fuel', 'sleep', 'workout', 'adherence'], ['coach']);
    expect(d.order).not.toContain('water');
    expect(d.order).not.toContain('sleep');
    expect(d.visible).not.toContain('adherence');
    expect(d.hidden.has('coach')).toBe(false);
    expect(d.order).toEqual(expect.arrayContaining(DASH_KEYS));
  });

  it('appends cards added since the layout was saved', () => {
    // Someone who arranged their dashboard a year ago should still see a
    // card shipped last week, in its catalogue position -- not lose it.
    const d = resolveDashboard(['fuel', 'workout'], []);
    expect(d.order.slice(0, 2)).toEqual(['fuel', 'workout']);
    expect(d.order).toEqual(expect.arrayContaining(DASH_KEYS));
    expect(d.order.length).toBe(DASH_KEYS.length);
  });

  it('never repeats a card', () => {
    const d = resolveDashboard(['fuel', 'fuel', 'workout'], []);
    expect(new Set(d.order).size).toBe(d.order.length);
  });

  it('separates hidden from visible', () => {
    const d = resolveDashboard(DEFAULT_ORDER, ['burn', 'crowd']);
    expect(d.visible).not.toContain('burn');
    expect(d.visible).not.toContain('crowd');
    expect(d.order).toContain('burn');        // still ordered, just not shown
    expect(d.isVisible('burn')).toBe(false);
    expect(d.isVisible('fuel')).toBe(true);
  });

  it('allows every card to be hidden', () => {
    // Home has to render an explicit empty state for this rather than a
    // blank page, so the resolver must report it honestly.
    const d = resolveDashboard(DEFAULT_ORDER, [...DASH_KEYS]);
    expect(d.visible).toEqual([]);
  });
});

describe('reading the stored columns', () => {
  it('parses the two JSON arrays', () => {
    const p = parseDashboardPrefs({ order_list: '["fuel","workout"]', hidden: '["burn"]' });
    expect(p.order).toEqual(['fuel', 'workout']);
    expect(p.hidden).toEqual(['burn']);
  });

  it('survives absent, malformed or wrongly-typed storage', () => {
    // A parse error here would blank the home screen, so every bad shape
    // has to fall back to "no preference" rather than throw.
    expect(parseDashboardPrefs(undefined)).toEqual({ order: [], hidden: [] });
    expect(parseDashboardPrefs({ order_list: 'not json', hidden: null })).toEqual({ order: [], hidden: [] });
    expect(parseDashboardPrefs({ order_list: '{"a":1}', hidden: '"x"' })).toEqual({ order: [], hidden: [] });
  });

  it('round-trips through the resolver', () => {
    const stored = { order_list: JSON.stringify(['community', 'fuel']), hidden: JSON.stringify(['burn']) };
    const p = parseDashboardPrefs(stored);
    const d = resolveDashboard(p.order, p.hidden);
    expect(d.visible[0]).toBe('community');
    expect(d.visible).not.toContain('burn');
  });
});

describe('labels', () => {
  it('names every card', () => {
    for (const k of DASH_KEYS) expect(dashLabel(k)).not.toBe(k);
  });

  it('falls back to the key rather than rendering undefined', () => {
    expect(dashLabel('water')).toBe('water');
  });
});
