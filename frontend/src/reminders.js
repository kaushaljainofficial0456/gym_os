/**
 * REMINDERS, DELIVERED.
 *
 * The server has always known how to write reminders (workout today,
 * tomorrow's session, meals, water, an unfinished session, the daily
 * recap -- backend/src/services/notificationGenerator.js), but nothing in
 * the app ever asked it to, so the switches in Settings produced silence.
 * The notification bell now asks: when the app opens, when it comes back to
 * the foreground, and every few minutes while it is open.
 *
 * A reminder that arrives while Barbell is in a background tab -- or the
 * phone is showing something else with Barbell still open -- also shows as
 * a system notification, if the member allowed them (the permission prompt
 * already exists). While the app is on screen the bell's badge is enough.
 * Delivery with the app fully closed would need a push provider; that is a
 * deployment decision, not something this file can do.
 */
import { api } from './api.js';

export const GENERATE_EVERY_MS = 10 * 60_000;
export const UNREAD_POLL_MS = 60_000;

const REMINDER_TYPES = new Set(['workout_reminder', 'tomorrow_workout', 'incomplete_workout', 'rest_day',
  'nutrition_reminder', 'water_reminder', 'daily_summary']);

/** Where a notification should take you, or null if it is only to be read:
 *  its own link if it carries one, the obvious screen if it is a reminder
 *  (the generator writes none, so tapping one used to do nothing). */
export function reminderLink(n) {
  const data = n?.data || {};
  if (data.link) return data.link;
  if (!REMINDER_TYPES.has(n?.type)) return null;
  switch (n.type) {
    case 'workout_reminder':
    case 'tomorrow_workout':
    case 'incomplete_workout':
    case 'rest_day':
      return '/app/client/workout';
    case 'nutrition_reminder':
    case 'water_reminder':
      return '/app/client/nutrition';
    case 'daily_summary':
      return data.date ? `/app/client/day/${data.date}` : '/app/client';
    default:
      return '/app/client';
  }
}

let swRegistration = null;
/** A worker that only shows notifications (see public/sw.js). Android
 *  Chrome refuses `new Notification()` from a page, so this is the route
 *  that works everywhere. Failure is silent: the bell still works. */
export function registerNotificationWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then((r) => { swRegistration = r; }).catch(() => {});
}

export async function showSystemNotification(n) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const options = {
    body: n.body || '',
    tag: n.id,               // the same reminder never stacks twice
    icon: '/favicon.png',
    badge: '/favicon.png',
    data: { url: reminderLink(n) || '/app' },
  };
  try {
    const reg = swRegistration || (await navigator.serviceWorker?.getRegistration?.());
    if (reg) { await reg.showNotification(n.title, options); return; }
  } catch { /* fall through to the page API */ }
  try { new Notification(n.title, options); } catch { /* not allowed here */ }
}

/** Ask the server for anything now due. Resolves to the new reminders. */
export async function generateReminders() {
  try {
    const r = await api('/notifications/generate', { method: 'POST' });
    const made = r?.notifications || [];
    const away = typeof document !== 'undefined' && (document.visibilityState === 'hidden' || !document.hasFocus());
    // `silent` is the daily recap made inside quiet hours: in the bell,
    // never on the lock screen.
    if (away) for (const n of made) if (!n.silent) showSystemNotification(n);
    return made;
  } catch {
    return [];
  }
}
