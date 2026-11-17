import { test, expect } from '@playwright/test';
import { storageFor, markFirstRunSeen } from './fixtures.js';

/* REGRESSION (2026-11-17): on iPhones the Workout page kept "shifting
   right" -- every card ~15pt wider than the screen and cut off on the
   right, after a reload or after saving the day's session. The page's
   grid had one `auto` column, which grows to its widest child's minimum
   width, and iPhone Safari measured the three tool tiles wider than the
   screen. Chrome measures them narrower, so the bug never showed here.

   These tests make a child too wide ON PURPOSE, the way Safari did, and
   require the page to hold its width anyway: cards stay the column's
   width, and the page never becomes wider than the screen. */
const PAGES = ['/app/client', '/app/client/workout', '/app/client/nutrition', '/app/client/progress', '/app/client/community'];

test.describe('member pages never grow wider than the screen', () => {
  test.use({ storageState: storageFor('client'), viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  test.beforeEach(async ({ page }) => { await page.addInitScript(markFirstRunSeen); });

  test('the Workout page holds its width when a row is too wide for it', async ({ page }) => {
    await page.goto('/app/client/workout');
    await expect(page.locator('.wk-tool').first()).toBeVisible();
    // What iPhone Safari effectively did: three tiles that will not fit.
    await page.addStyleTag({ content: '.wk-tool { min-width: 170px; white-space: nowrap; }' });
    const m = await page.evaluate(() => {
      const col = document.querySelector('.anim-route').getBoundingClientRect();
      const card = document.querySelector('.wk > :not(header)').getBoundingClientRect();
      return { col: Math.round(col.width), card: Math.round(card.width), page: document.documentElement.scrollWidth, screen: window.innerWidth };
    });
    expect(m.card).toBe(m.col);
    expect(m.page).toBe(m.screen);
    expect(m.screen).toBe(375);
  });

  for (const path of PAGES) {
    test(`${path} fits the screen`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const m = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: window.innerWidth }));
      expect(m.page).toBe(m.screen);
      expect(m.screen).toBe(375);
    });
  }
});
