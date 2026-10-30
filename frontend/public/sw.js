// Barbell's service worker: shows reminders as system notifications and
// opens the right screen when one is tapped (see src/reminders.js).
// Deliberately nothing else -- no fetch handler and no cache, so this
// worker can never serve a stale page or get between the app and the API.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/app', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      await w.focus();
      if ('navigate' in w) await w.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
