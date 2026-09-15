import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { markFirstRunSeen, storageFor } from './fixtures.js';

/**
 * Automated WCAG 2.2 AA scan (axe-core) of the screens people actually
 * use, in BOTH themes -- a contrast pair that passes on dark can fail on
 * light, and the app ships both.
 *
 * Automated checks find roughly a third of accessibility problems: missing
 * names and labels, contrast, invalid ARIA, landmark structure. Keyboard
 * behaviour is covered separately (dialogs.spec.js), and nothing here
 * replaces testing with a screen reader.
 */
const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const SCREENS = {
  public: ['/login', '/signup', '/forgot-password', '/privacy', '/terms', '/contact'],
  client: [
    '/app/client', '/app/client/workout', '/app/client/nutrition', '/app/client/progress',
    '/app/client/profile', '/app/client/settings', '/app/client/history', '/app/client/help',
    '/app/client/community', '/app/client/membership',
  ],
  owner: [
    '/app/trainer', '/app/trainer/clients', '/app/trainer/workouts', '/app/trainer/nutrition',
    '/app/trainer/attendance', '/app/trainer/business', '/app/trainer/analytics', '/app/trainer/messages',
  ],
};

const describe = (violations) => violations.map((v) =>
  `${v.id} [${v.impact}] ${v.help} -- ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`,
).join('\n');

async function settle(page, path) {
  // Scan the screen that was asked for. A redirect used to pass silently
  // here: three "public" screens were really scans of the login page.
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await page.waitForLoadState('networkidle');
  // Skeletons announce aria-busy; scan the loaded screen, not its placeholder.
  await expect(page.locator('[aria-busy="true"][role="status"]')).toHaveCount(0);
  // Let finite entrance animations and colour transitions finish: text
  // sampled mid-fade or mid-transition is measured at the wrong contrast,
  // which made the scan intermittently fail on screens that pass.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {}))));
}

for (const theme of ['dark', 'light']) {
  for (const [who, paths] of Object.entries(SCREENS)) {
    test.describe(`${who} screens, ${theme} theme`, () => {
      test.use({
        colorScheme: theme,
        contextOptions: { reducedMotion: 'reduce' },
        ...(who === 'public' ? {} : { storageState: storageFor(who) }),
      });

      test.beforeEach(async ({ page }) => {
        await page.addInitScript(([t]) => { try { localStorage.setItem('sk-os-theme', t); } catch { /* */ } }, [theme]);
        await page.addInitScript(markFirstRunSeen);
      });

      for (const path of paths) {
        test(`${path} meets WCAG 2.2 AA`, async ({ page }, testInfo) => {
          await page.goto(path);
          await settle(page, path);
          const { violations } = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
          if (violations.length) {
            // Written to the test's output folder (and attached for the HTML
            // report) so the full node list survives any reporter.
            const file = testInfo.outputPath('axe-violations.json');
            fs.writeFileSync(file, JSON.stringify(violations, null, 2));
            await testInfo.attach('axe-violations.json', { path: file, contentType: 'application/json' });
          }
          // One line per rule, so a failure reads as a to-do list rather than
          // a deep-equality diff of axe's full result objects.
          expect(describe(violations)).toBe('');
        });
      }
    });
  }
}
