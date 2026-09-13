import { test, expect } from '@playwright/test';
import { markFirstRunSeen, storageFor } from './fixtures.js';

/**
 * Loading behaviour that the bundle budget (scripts/check-bundle.mjs) cannot
 * see from file sizes alone: WHAT a screen downloads, in WHICH order, and
 * whether its layout holds still while data arrives.
 *
 * Timings on a local production build say nothing about a phone on a slow
 * network, so nothing here asserts milliseconds. Request order and layout
 * shift are properties of the code and hold on any network.
 */
const SHELL_CHUNK = /\/assets\/(ClientLayout|TrainerLayout)-[\w-]+\.js$/;

test.describe('signed out', () => {
  test('the login screen downloads none of the signed-in app shell', async ({ page }) => {
    await page.addInitScript(markFirstRunSeen);
    const shellRequests = [];
    page.on('request', (r) => { if (SHELL_CHUNK.test(r.url())) shellRequests.push(r.url()); });
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    expect(shellRequests).toEqual([]);
  });
});

test.describe('returning signed-in client', () => {
  test.use({ storageState: storageFor('client') });

  test('the app shell starts downloading before the session check finishes', async ({ page }) => {
    let shellRequestedAt = null;
    let sessionAnsweredAt = null;
    page.on('request', (r) => {
      if (shellRequestedAt === null && /ClientLayout-[\w-]+\.js$/.test(r.url())) shellRequestedAt = Date.now();
    });
    page.on('response', (r) => {
      if (sessionAnsweredAt === null && r.url().endsWith('/api/auth/me')) sessionAnsweredAt = Date.now();
    });
    await page.goto('/app/client');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    expect(shellRequestedAt, 'the client shell chunk was never requested').not.toBeNull();
    expect(sessionAnsweredAt).not.toBeNull();
    expect(shellRequestedAt).toBeLessThanOrEqual(sessionAnsweredAt);
  });
});

/**
 * Cumulative Layout Shift while a screen loads its data. Skeletons are
 * shaped like the content they stand in for (PageSkeleton in UI.jsx) so
 * that data landing does not push the page around; this holds them to it.
 * 0.1 is Google's "good" threshold.
 */
const CLS_SCREENS = {
  public: ['/login'],
  client: ['/app/client', '/app/client/nutrition', '/app/client/progress', '/app/client/workout'],
  owner: ['/app/trainer', '/app/trainer/clients'],
};

for (const [who, paths] of Object.entries(CLS_SCREENS)) {
  test.describe(`layout stability, ${who}`, () => {
    if (who !== 'public') test.use({ storageState: storageFor(who) });

    for (const path of paths) {
      test(`${path} keeps layout shift under 0.1 while loading`, async ({ page }) => {
        await page.addInitScript(markFirstRunSeen);
        await page.addInitScript(() => {
          window.__cls = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput) window.__cls += entry.value;
            }
          }).observe({ type: 'layout-shift', buffered: true });
        });
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1500);
        const cls = await page.evaluate(() => window.__cls);
        expect(cls, `CLS on ${path}`).toBeLessThan(0.1);
      });
    }
  });
}
