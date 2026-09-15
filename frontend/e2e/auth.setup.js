import { test as setup } from '@playwright/test';
import { SAVED_SESSIONS, completeOnboarding, markFirstRunSeen, signInAndLand, storageFor } from './fixtures.js';

/**
 * Signs each seeded role in ONCE through the real login screen and saves
 * the session -- the httpOnly cookie plus localStorage -- for the specs that
 * depend on this project. Signing in per test would be slow and would
 * exercise the login form hundreds of times while proving nothing new;
 * auth.spec.js covers the form itself, including its failure paths.
 *
 * Every seeded client starts un-onboarded, so the client session finishes
 * the profile wizard here; its detailed journey is onboarding.spec.js.
 */
for (const who of SAVED_SESSIONS) {
  setup(`sign in as ${who}`, async ({ page }) => {
    await page.addInitScript(markFirstRunSeen);
    await signInAndLand(page, who);
    if (who === 'client') await completeOnboarding(page);
    await page.context().storageState({ path: storageFor(who) });
  });
}
