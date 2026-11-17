import { test, expect } from '@playwright/test';
import { storageFor, markFirstRunSeen } from './fixtures.js';

/* REGRESSION (2026-11-17): with a few exercises added, "Build a workout"
   widened sideways -- the "4 · Ab Wheel Rollout · Bicycle Crunch · …"
   summary sat in a grid column that grew to fit the whole line, and the
   tabs, the 3D body and the list were cut off at the right. Adding
   exercises and switching to By muscle must leave the sheet exactly as
   wide as itself, on a phone and on a computer. */
async function buildWithFour(page) {
  await page.goto('/app/client/workout');
  await page.getByRole('button', { name: 'Build workout' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Build a workout' });
  await expect(sheet).toBeVisible();
  const add = sheet.locator('button[aria-label^="Add "]:not([disabled])');
  await expect(add.first()).toBeVisible();
  for (let i = 0; i < 4; i += 1) await add.first().click();
  await expect(sheet.locator('.wk-added')).toContainText('4');
  await sheet.getByRole('tab', { name: 'By muscle' }).click();
  await sheet.getByRole('button', { name: /^Abs$/ }).first().click();
  return sheet;
}

const overflowX = (sheet) => sheet.evaluate((panel) => {
  const scroller = [...panel.querySelectorAll('*')].find((e) => {
    const o = getComputedStyle(e).overflowY;
    return (o === 'auto' || o === 'scroll') && e.clientHeight > 200;
  }) || panel;
  const summary = panel.querySelector('.wk-added').getBoundingClientRect();
  return {
    scroll: scroller.scrollWidth - scroller.clientWidth,
    summaryInside: summary.right <= panel.getBoundingClientRect().right + 1,
  };
});

test.describe('build a workout: many exercises', () => {
  test.use({ storageState: storageFor('client') });
  test.beforeEach(async ({ page }) => { await page.addInitScript(markFirstRunSeen); });

  test('the sheet never widens on a computer', async ({ page }) => {
    const sheet = await buildWithFour(page);
    expect(await overflowX(sheet)).toEqual({ scroll: 0, summaryInside: true });
  });

  test.describe('on a small phone', () => {
    test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    test('the sheet never widens', async ({ page }) => {
      const sheet = await buildWithFour(page);
      expect(await overflowX(sheet)).toEqual({ scroll: 0, summaryInside: true });
    });
  });
});
