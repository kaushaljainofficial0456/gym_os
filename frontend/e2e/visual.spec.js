import { test, expect } from '@playwright/test';
import { markFirstRunSeen, storageFor } from './fixtures.js';

/**
 * Visual regression: 26 key screens, compared pixel by pixel against
 * committed baselines.
 *
 *   npm run test:visual --prefix frontend
 *   npm run test:visual --prefix frontend -- --update-snapshots   (after an intended change)
 *
 * Split by form factor rather than doubled: the client app is built
 * phone-first, so its screens are checked on a Pixel 7; the owner and
 * trainer workspace is a desk tool, so its screens are checked at 1280px,
 * plus the phone views of it people actually use (dashboard, drawer).
 *
 * The data is seeded relative to "today", so values and charts repeat day
 * to day but date labels do not. Absolute dates and relative times are
 * masked, and the tolerance absorbs anti-aliasing, not layout: a moved
 * card, a broken theme or a clipped control still fails.
 *
 * Baselines are per platform (see snapshotPathTemplate): font rendering
 * differs between Windows and Linux, so a Linux CI run needs its own set
 * generated once with --update-snapshots.
 */
const MOBILE = 'visual-mobile';
const DESKTOP = 'visual-desktop';

const SHOTS = [
  // [name, who, path, project, open?]
  ['login', 'public', '/login', MOBILE],
  ['login', 'public', '/login', DESKTOP],
  ['signup', 'public', '/signup', MOBILE],
  ['privacy', 'public', '/privacy', DESKTOP],
  ['client-home', 'client', '/app/client', MOBILE],
  ['client-home', 'client', '/app/client', DESKTOP],
  ['client-workout', 'client', '/app/client/workout', MOBILE],
  ['client-nutrition', 'client', '/app/client/nutrition', MOBILE],
  ['client-nutrition', 'client', '/app/client/nutrition', DESKTOP],
  ['client-log-food-sheet', 'client', '/app/client/nutrition', MOBILE, (page) => page.getByRole('button', { name: /^Log food/ }).click()],
  ['client-progress', 'client', '/app/client/progress', MOBILE],
  ['client-profile', 'client', '/app/client/profile', MOBILE],
  ['client-settings', 'client', '/app/client/settings', MOBILE],
  ['client-history', 'client', '/app/client/history', MOBILE],
  ['client-help', 'client', '/app/client/help', MOBILE],
  ['client-community', 'client', '/app/client/community', MOBILE],
  ['client-membership', 'client', '/app/client/membership', MOBILE],
  ['owner-dashboard', 'owner', '/app/trainer', DESKTOP],
  ['owner-dashboard', 'owner', '/app/trainer', MOBILE],
  ['owner-drawer', 'owner', '/app/trainer', MOBILE, (page) => page.getByRole('button', { name: 'Open menu' }).click()],
  ['owner-clients', 'owner', '/app/trainer/clients', DESKTOP],
  ['owner-workouts', 'owner', '/app/trainer/workouts', DESKTOP],
  ['owner-attendance', 'owner', '/app/trainer/attendance', DESKTOP],
  ['owner-business', 'owner', '/app/trainer/business', DESKTOP],
  ['owner-analytics', 'owner', '/app/trainer/analytics', DESKTOP],
  ['owner-messages', 'owner', '/app/trainer/messages', DESKTOP],
];

const MONTH_OR_DAY = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b/;
// Not "today"/"yesterday": the seed is relative to today, so those words
// label the same data every day -- masking them hid whole dashboard rows.
const RELATIVE = /\b(\d+\s?(s|m|h|d|w|min|mins|hr|hrs|days?|weeks?)\s?ago|Good (morning|afternoon|evening))\b/i;

for (const [name, who, path, project, open] of SHOTS) {
  test.describe(`${name} (${project})`, () => {
    test.use({
      colorScheme: 'dark',
      contextOptions: { reducedMotion: 'reduce' },
      ...(who === 'public' ? {} : { storageState: storageFor(who) }),
    });

    test(`${name} matches its baseline`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== project, `captured on ${project} only`);
      await page.addInitScript(markFirstRunSeen);
      await page.addInitScript(() => { try { localStorage.setItem('sk-os-theme', 'dark'); } catch { /* */ } });

      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await page.waitForLoadState('networkidle');
      await expect(page.locator('[aria-busy="true"][role="status"]')).toHaveCount(0);
      if (open) {
        await open(page);
        await page.waitForLoadState('networkidle');
      }
      // Charts draw with JavaScript-driven animation, which reduced motion
      // does not stop; let them land before comparing.
      await page.waitForTimeout(1200);

      await expect(page).toHaveScreenshot(`${name}.png`, {
        mask: [page.getByText(MONTH_OR_DAY), page.getByText(RELATIVE), page.locator('time')],
        maskColor: '#FF00FF',
      });
    });
  });
}
