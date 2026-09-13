import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { markFirstRunSeen, storageFor } from './fixtures.js';

/**
 * Responsive behaviour across the widths people actually use: small and
 * large phones, tablet portrait, laptop and desktop.
 *
 * 1. No screen scrolls sideways at any width. A page wider than the
 *    viewport hides content off the edge and makes every vertical swipe
 *    drift. On failure the elements that stick out are named.
 * 2. At phone width, tap targets meet WCAG 2.2's minimum size (24x24 CSS px,
 *    or enough spacing), checked by axe's target-size rule.
 */
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440];

const SCREENS = {
  public: ['/login', '/signup'],
  client: [
    '/app/client', '/app/client/workout', '/app/client/nutrition', '/app/client/progress',
    '/app/client/profile', '/app/client/settings', '/app/client/community',
  ],
  owner: [
    '/app/trainer', '/app/trainer/clients', '/app/trainer/workouts', '/app/trainer/nutrition',
    '/app/trainer/attendance', '/app/trainer/business', '/app/trainer/messages', '/app/trainer/analytics',
    '/app/trainer/reports',
  ],
};

/**
 * The energy-balance bars are narrower than 24px by design (one per day,
 * up to 90 across a phone). WCAG 2.5.8 allows that when an equivalent
 * control meets the size -- the chart's Previous/Next day stepper does, and
 * progress.spec.js checks it works. axe cannot see equivalents, so the bars
 * are excluded here and ONLY here.
 */
const TARGET_SIZE_EXEMPT = '[aria-label^="Net energy balance"] > button';

/** Elements whose right edge passes the viewport and are not inside something that clips or scrolls them. */
const findOverflow = () => {
  const vw = document.documentElement.clientWidth;
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o !== 'visible') return true;
    }
    return false;
  };
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= vw + 1) continue;
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || clipped(el)) continue;
    offenders.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''} (right ${Math.round(r.right)} > ${vw})`);
  }
  return { scrollWidth: document.documentElement.scrollWidth, viewport: vw, offenders: offenders.slice(0, 5) };
};

for (const [who, paths] of Object.entries(SCREENS)) {
  test.describe(`${who} screens`, () => {
    test.use({
      contextOptions: { reducedMotion: 'reduce' },
      ...(who === 'public' ? {} : { storageState: storageFor(who) }),
    });

    for (const path of paths) {
      test(`${path} never scrolls sideways, 320-1440px`, async ({ page }) => {
        await page.addInitScript(markFirstRunSeen);
        await page.setViewportSize({ width: WIDTHS[0], height: 800 });
        await page.goto(path);
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        await page.waitForLoadState('networkidle');

        const problems = [];
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 800 });
          await page.waitForTimeout(250);
          const m = await page.evaluate(findOverflow);
          if (m.scrollWidth > m.viewport + 1) {
            problems.push(`${width}px: page is ${m.scrollWidth}px wide; ${m.offenders.join(', ') || 'no single offender found'}`);
          }
        }
        expect(problems.join('\n')).toBe('');
      });
    }

    if (who !== 'owner') {
      for (const path of paths) {
        test(`${path} tap targets meet WCAG 2.2 minimum size on a phone`, async ({ page }) => {
          await page.addInitScript(markFirstRunSeen);
          await page.setViewportSize({ width: 375, height: 812 });
          await page.goto(path);
          await page.waitForLoadState('networkidle');
          const { violations } = await new AxeBuilder({ page }).withRules(['target-size']).exclude(TARGET_SIZE_EXEMPT).analyze();
          const summary = violations.flatMap((v) => v.nodes.slice(0, 6).map((n) => `${n.target.join(' ')} -- ${n.html.slice(0, 90)}`));
          expect(summary.join('\n')).toBe('');
        });
      }
    }
  });
}
