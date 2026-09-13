import { test, expect } from '@playwright/test';
import { storageFor } from './fixtures.js';

/**
 * Dialog keyboard behaviour in the real app (see useDialog in UI.jsx).
 * jsdom proves the hook; these prove the screens actually wire it up,
 * in a real browser with real layout, animation and portals.
 */
const focusInside = (locator) => locator.evaluate((el) => el.contains(document.activeElement));

test.describe('food log sheet', () => {
  test.use({ storageState: storageFor('client') });

  // The one dialog that owns a layered Escape (it steps back through its
  // own screens), so it takes useDialog's focus handling without its Escape.
  test('holds focus, closes on Escape, and hands focus back to Log food', async ({ page }) => {
    await page.goto('/app/client/nutrition');
    const trigger = page.getByRole('button', { name: /^Log food/ });
    await trigger.click();

    const sheet = page.getByRole('dialog', { name: 'Log Food' });
    await expect(sheet).toBeVisible();
    await expect.poll(() => focusInside(sheet)).toBe(true);
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      expect(await focusInside(sheet)).toBe(true);
    }

    // Focus may sit in the search field; Escape must still reach the sheet.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe('trainer navigation drawer', () => {
  test.use({ storageState: storageFor('owner') });

  test('holds keyboard focus while open and hands it back to the menu button', async ({ page }) => {
    await page.goto('/app/trainer');
    const menu = page.getByRole('button', { name: 'Open menu' });
    await menu.click();

    const drawer = page.getByRole('dialog', { name: 'Trainer navigation' });
    await expect(drawer).toBeVisible();
    await expect.poll(() => focusInside(drawer)).toBe(true);

    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      expect(await focusInside(drawer)).toBe(true);
    }
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusInside(drawer)).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();
  });
});
