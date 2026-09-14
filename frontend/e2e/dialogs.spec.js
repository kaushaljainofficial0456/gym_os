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

/*
 * CONFIRMATIONS (useConfirm in UI.jsx replaced window.confirm, e8d71a8).
 * A browser confirm could not be styled or tested, but it could not be
 * wired up wrong either. These check the replacement asks the real
 * question, that saying no changes nothing, and that yes does the thing.
 */
test.describe('confirmation: deleting a logged session', () => {
  test.use({ storageState: storageFor('client') });

  test('asks first; Cancel keeps the session and "Delete workout" removes it', async ({ page }) => {
    // Seeded sessions are the trainer's and offer no delete, so the client
    // logs one of their own -- a past session, through the real API.
    const { exercises } = await (await page.request.get('/api/workouts/exercises')).json();
    const name = `Confirm check ${Date.now()}`;
    const date = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const created = await page.request.post('/api/me/workouts', {
      data: { name, date, exercises: [{ exercise_id: exercises[0].id, sets: 3, reps: 8 }] },
    });
    expect(created.ok()).toBe(true);

    await page.goto('/app/client/history');
    const remove = page.getByRole('button', { name: new RegExp(`^Delete ${name} from`) });
    const dialog = page.getByRole('dialog', { name: 'Delete this workout?' });

    await remove.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(name);
    await expect.poll(() => focusInside(dialog)).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(remove).toBeVisible();

    await remove.click();
    await dialog.getByRole('button', { name: 'Delete workout', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(name)).toHaveCount(0);

    // Gone on the server too, not just from this screen's state.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Training history' })).toBeVisible();
    await expect(page.getByText(name)).toHaveCount(0);
  });
});

test.describe('confirmation: allowing self check-in', () => {
  test.use({ storageState: storageFor('owner') });

  test('asks first; Cancel and Escape leave the policy unchanged', async ({ page }) => {
    const policyWrites = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && new URL(r.url()).pathname === '/api/attendance/policy') policyWrites.push(r.url());
    });
    await page.goto('/app/trainer/attendance');
    // Exact, and only used while no dialog is open: the confirmation's own
    // action button carries the same words.
    const toggle = page.getByRole('button', { name: 'Allow self check-in', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Allow self check-in?' });

    await toggle.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('self-reported');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(toggle).toBeVisible();

    // Escape closes the confirmation and nothing else: the page stays,
    // focus returns to the control that asked, and still no write.
    await toggle.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/app\/trainer\/attendance$/);
    await expect(toggle).toBeFocused();

    expect(policyWrites).toEqual([]);
    await expect(page.getByRole('button', { name: 'Require scanning', exact: true })).toHaveCount(0);
  });
});

test.describe('confirmation: removing a logged food', () => {
  test.use({ storageState: storageFor('client') });

  // This one was a hand-rolled overlay with no dialog semantics, so it was
  // invisible to getByRole('dialog') -- this test could not have passed.
  test('asks in a real dialog; Escape keeps the entry and Remove deletes it', async ({ page }) => {
    const { client } = await (await page.request.get('/api/tracking/me/home')).json();
    const name = `Confirm food ${Date.now()}`;
    const logged = await page.request.post(`/api/nutrition/clients/${client.id}/meals/log`, {
      data: { name, slot: 'Snack', calories: 120, protein: 5, carbs: 10, fat: 4, source: 'manual', eaten: true, quantity: 1, unit: 'serving' },
    });
    expect(logged.ok()).toBe(true);

    await page.goto('/app/client/nutrition');
    const meals = page.locator('[data-tour="nutrition-meals"]');
    // Edit waits for the list to render; only then is "See more" (the list
    // shows two rows until expanded, and a new entry is last) decidable.
    await meals.getByRole('button', { name: 'Edit', exact: true }).click();
    const more = meals.getByRole('button', { name: /^See more/ });
    if (await more.count()) await more.click();

    const remove = meals.getByRole('button', { name: `Remove ${name}`, exact: true });
    const dialog = page.getByRole('dialog', { name: "Remove from today's intake?" });

    await remove.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`${name} · 1serving · 120 kcal`);
    await expect.poll(() => focusInside(dialog)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();

    await remove.click();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(meals.getByText(name)).toHaveCount(0);

    await page.reload();
    await expect(page.locator('[data-tour="nutrition-meals"]')).toBeVisible();
    await expect(page.getByText(name)).toHaveCount(0);
  });
});

test.describe('dialog layering: the barcode scanner inside the food log sheet', () => {
  test.use({ storageState: storageFor('client') });

  // Both listen for Escape. Only the top layer may act: the scanner closes,
  // the sheet stays open, and focus returns to the button that opened it.
  test('Escape closes the scanner and nothing under it', async ({ page }) => {
    await page.goto('/app/client/nutrition');
    await page.getByRole('button', { name: /^Log food/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Log Food' });
    await expect(sheet).toBeVisible();

    const scanButton = sheet.getByRole('button', { name: 'Scan barcode' });
    await scanButton.click();
    const scanner = page.getByRole('dialog', { name: 'Scan barcode' });
    await expect(scanner).toBeVisible();
    await expect.poll(() => focusInside(scanner)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(scanner).toBeHidden();
    await expect(sheet).toBeVisible();
    await expect(scanButton).toBeFocused();
  });
});

test.describe('nutrition targets', () => {
  test.use({ storageState: storageFor('client') });

  // Completed by saving or resetting, so it holds focus but Escape is not a way out.
  test('holds focus, and Escape does not dismiss it', async ({ page }) => {
    await page.goto('/app/client/nutrition');
    await page.getByRole('button', { name: 'Edit calorie target' }).click();
    const dialog = page.getByRole('dialog', { name: /daily targets$/ });
    await expect(dialog).toBeVisible();
    await expect.poll(() => focusInside(dialog)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
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
