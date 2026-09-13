import { test, expect } from '@playwright/test';
import { storageFor } from './fixtures.js';

test.use({ storageState: storageFor('client') });

/**
 * The energy-balance day stepper: the full-size, one-tab-stop way to read
 * a single day, standing in for bars too narrow to tap reliably (WCAG 2.5.8
 * equivalent control -- see responsive.spec.js).
 */
test('the energy balance chart can be read one day at a time without tapping a bar', async ({ page }) => {
  await page.goto('/app/client/progress');
  const chart = page.getByRole('group', { name: /^Net energy balance/ }).locator('xpath=ancestor::div[contains(@class,"card")][1]');
  const previous = chart.getByRole('button', { name: 'Previous day' });
  const next = chart.getByRole('button', { name: 'Next day' });

  await expect(previous).toBeVisible();
  await expect(next).toBeDisabled(); // nothing after the period summary

  // From the summary, Previous opens the most recent day...
  await previous.click();
  const backToSummary = chart.getByRole('button', { name: /^Back to \d+-day summary$/ });
  await expect(backToSummary).toBeVisible();
  await expect(next).toBeDisabled(); // ...which is the last one

  // ...and steps back through earlier days, and forward again.
  await previous.click();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(next).toBeDisabled();

  await backToSummary.click();
  await expect(chart.getByText('Avg / day')).toBeVisible();
});
