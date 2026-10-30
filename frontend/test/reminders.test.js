import { describe, expect, it } from 'vitest';
import { reminderLink } from '../src/reminders.js';

describe('reminderLink', () => {
  it('takes a reminder to the screen that answers it', () => {
    expect(reminderLink({ type: 'workout_reminder' })).toBe('/app/client/workout');
    expect(reminderLink({ type: 'water_reminder' })).toBe('/app/client/nutrition');
    expect(reminderLink({ type: 'daily_summary', data: { date: '2026-10-30' } })).toBe('/app/client/day/2026-10-30');
  });
  it('prefers a link the notification carries', () => {
    expect(reminderLink({ type: 'workout_reminder', data: { link: '/app/client/history' } })).toBe('/app/client/history');
  });
  it('leaves anything else as something to read', () => {
    expect(reminderLink({ type: 'gym_package_activated' })).toBeNull();
    expect(reminderLink(null)).toBeNull();
  });
});
