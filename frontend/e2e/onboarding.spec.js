import { test, expect } from '@playwright/test';
import { markFirstRunSeen, signInAndLand } from './fixtures.js';

/**
 * Activation: a client's first sign-in through to a set-up profile.
 *
 * This is the step between "has an account" and "has targets built around
 * them", so it is the one most worth protecting. Uses a seeded client no
 * other spec signs in as, so the wizard is genuinely first-run here.
 *
 * Time to value, as built: eight questions on nine screens, of which only
 * two (sex, goal) need an answer -- the rest carry defaults -- so a person
 * who accepts the defaults finishes in eleven taps.
 */
test('a new client sets up their profile once, and lands in the guided tour', async ({ page }) => {
  await page.addInitScript(markFirstRunSeen);
  await signInAndLand(page, 'newClient');

  const wizard = page.getByRole('dialog', { name: 'Set up your profile' });
  await expect(wizard).toBeVisible();
  await expect(wizard.getByRole('heading', { level: 2 })).toContainText('Welcome, Priya');
  // A real modal: focus is inside it, and Escape cannot skip setting up.
  await expect.poll(() => wizard.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(wizard).toBeVisible();

  await wizard.getByRole('button', { name: 'Get started' }).click();
  const next = wizard.getByRole('button', { name: 'Continue' });

  // Name comes prefilled from the account, so it does not block.
  await expect(wizard.getByRole('textbox', { name: 'Your full name' })).toHaveValue(/Priya/);
  await next.click();

  // A question without a default cannot be skipped...
  await expect(next).toBeDisabled();
  await wizard.getByRole('button', { name: 'Female', exact: true }).click();
  await expect(next).toBeEnabled();

  // ...and going Back does not lose the answer.
  await wizard.getByRole('button', { name: 'Back' }).click();
  await next.click();
  await expect(wizard.getByRole('button', { name: 'Female', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await next.click();

  await next.click(); // height
  await next.click(); // weight
  await next.click(); // age

  await expect(next).toBeDisabled();
  await wizard.getByRole('button', { name: /^Muscle Gain/ }).click();
  await next.click();
  await next.click(); // experience, defaulted

  await expect(wizard).toContainText('Muscle Gain');
  await wizard.getByRole('button', { name: 'Looks right — finish' }).click();
  await expect(wizard).toBeHidden();

  // A brand-new user is walked through the app next.
  await expect(page.getByRole('dialog', { name: /^Tour step 1 of \d+/ })).toBeVisible();

  // Saved server-side: a fresh load does not ask again.
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(wizard).toHaveCount(0);
});
