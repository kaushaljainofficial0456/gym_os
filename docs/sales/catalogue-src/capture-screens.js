// Captures the real application screenshots used in the catalogue.
//
// Run against a throwaway seeded database (never a real gym's data):
//   SQLITE_PATH=/tmp/x.db node backend/scripts/init-db.js && node backend/scripts/seed.js
//   SQLITE_PATH=/tmp/x.db PORT=4200 node backend/src/index.js
//   cd frontend && VITE_API_TARGET=http://127.0.0.1:4200 npx vite --port 5175
// then prepare demo activity through the API (community shares, a finished
// tournament, trainer check-ins, an access-control sandbox) and run:
//   node docs/sales/catalogue-src/capture-screens.js
//
// Every image is a straight screenshot of the running app at 2x. Nothing is
// composited or edited.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:5175';
const OUT = path.join(__dirname, 'assets', 'screens');
const RAHUL = process.env.RAHUL || 'cli_FfwV29XuEZ';
const FRIEND = process.env.FRIEND || 'com_KmZCIebmNZ';
const TOURN = process.env.TOURN || 'trn_2ejU7ksmEO';
const TCODE = process.env.TCODE || 'VGZ38P8';

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1200, height: 820 };

const PLAN = [
  { email: 'client1@ironforge.in', vp: PHONE, shots: [
    ['client-home', '/app/client'],
    ['client-workout', '/app/client/workout'],
    ['client-planner', '/app/client/workout', [{ text: 'My workouts' }]],
    ['client-cardio', '/app/client/workout', [{ text: 'Cardio' }]],
    ['client-nutrition', '/app/client/nutrition'],
    ['client-log-meal', '/app/client/nutrition', [{ fill: ['[aria-label="What did you eat?"]', '2 roti, dal and chai'] }, { press: 'Enter' }, { wait: 2500 }, { scrollTo: '[aria-label="Log food"]' }]],
    ['client-tracker', '/app/client/nutrition-tracker'],
    ['client-progress', '/app/client/progress'],
    ['client-strength', '/app/client/progress', [{ scrollTo: 'text=WHERE YOUR STRENGTH IS MOVING' }]],
    ['client-milestones', '/app/client/progress', [{ text: 'Browse all 120 milestones' }, { scrollTo: 'text=MILESTONES' }]],
    ['client-community', '/app/client/community/gym', [{ text: 'Leaderboard' }]],
    ['client-feed', '/app/client/community/gym', [{ text: 'Activity' }]],
    ['client-friend', `/app/client/community/c/${FRIEND}`],
    ['client-tournament', `/app/client/tournaments/${TOURN}/results`],
    ['client-devices', '/app/client/health'],
    ['client-settings', '/app/client/settings', [{ scrollTo: 'text=Privacy' }]],
    ['client-session', '/app/client/workout', [{ text: 'Start session' }, { wait: 1500 }]],
  ] },
  { email: 'owner@ironforge.in', vp: DESK, shots: [
    ['owner-dashboard', '/app/trainer'],
    ['owner-clients', '/app/trainer/clients'],
    ['owner-business', '/app/trainer/business'],
    ['owner-members', '/app/trainer/business', [{ scrollTo: 'text=MEMBERS' }]],
    ['owner-analytics', '/app/trainer/analytics'],
    ['owner-trainers', '/app/trainer/trainers'],
    ['owner-attendance', '/app/trainer/attendance'],
    ['owner-codes', '/app/trainer/attendance', [{ text: 'Show codes' }, { wait: 1200 }]],
    ['owner-crowd', '/app/trainer/crowd'],
    ['owner-access', '/app/trainer/access', [{ text: 'Members' }]],
    ['owner-access-connect', '/app/trainer/access', [{ text: 'Connections' }]],
    ['owner-enterprise', '/app/trainer/enterprise'],
    ['owner-qr', '/app/trainer/enterprise/qr'],
    ['owner-billing', '/app/trainer/enterprise/billing'],
  ] },
  { email: 'trainer1@ironforge.in', vp: DESK, shots: [
    ['trainer-dashboard', '/app/trainer'],
    ['trainer-clients', '/app/trainer/clients'],
    ['trainer-profile', `/app/trainer/clients/${RAHUL}`],
    ['trainer-training', `/app/trainer/clients/${RAHUL}`, [{ text: 'Training' }]],
    ['trainer-ai', `/app/trainer/clients/${RAHUL}`, [{ text: 'AI Coach' }, { text: 'Analyze client' }, { wait: 1800 }]],
    ['trainer-builder', '/app/trainer/workouts', [{ text: 'Legs A' }]],
    ['trainer-nutrition', '/app/trainer/nutrition', [{ text: 'Fat Loss · 2,550 kcal' }]],
    ['trainer-alerts', '/app/trainer/alerts'],
    ['trainer-report', '/app/trainer/reports', [{ select: 'Rahul Sharma · FAT_LOSS' }, { wait: 1800 }]],
    ['trainer-messages', '/app/trainer/messages', [{ select: 'Rahul Sharma' }, { wait: 1200 }]],
    ['trainer-attendance', '/app/trainer/attendance'],
  ] },
  { email: null, vp: DESK, shots: [
    ['public-bigscreen', `/t/${TCODE}/screen`],
  ] },
];

async function step(page, a) {
  if (a.text) return page.getByText(a.text, { exact: true }).first().click({ timeout: 6000 });
  if (a.fill) return page.locator(a.fill[0]).first().fill(a.fill[1]);
  if (a.press) return page.keyboard.press(a.press);
  if (a.wait) return page.waitForTimeout(a.wait);
  if (a.select) return page.locator('select').first().selectOption({ label: a.select });
  if (a.scrollTo) {
    const el = page.locator(a.scrollTo).first();
    await el.scrollIntoViewIfNeeded({ timeout: 6000 });
    return el.evaluate((n) => { const y = n.getBoundingClientRect().top + window.scrollY - 90; window.scrollTo(0, Math.max(0, y)); });
  }
}

(async () => {
  const only = process.argv[2];
  const browser = await chromium.launch();
  for (const role of PLAN) {
    const ctx = await browser.newContext({ viewport: role.vp, deviceScaleFactor: 2, colorScheme: 'dark' });
    let user = null;
    if (role.email) {
      const r = await ctx.request.post(BASE + '/api/auth/login', { data: { email: role.email, password: 'demo1234' } });
      user = (await r.json()).user;
    }
    await ctx.addInitScript((uid) => {
      sessionStorage.setItem('barbell-intro-seen', '1');
      localStorage.setItem('sk_cookie_consent', JSON.stringify({ version: '1.0', categories: { necessary: true }, acceptedAt: new Date().toISOString() }));
      localStorage.setItem('sk-os-app-tour-done', JSON.stringify({ [uid]: true, anon: true }));
      localStorage.setItem('sk-os-seen-features', JSON.stringify({ home: true, workout: true, nutrition: true, progress: true, community: true }));
      localStorage.setItem('notif_prompt_seen', String(Date.now()));
      localStorage.setItem('sk-os-theme', 'dark');
    }, user ? user.id : 'anon');
    const page = await ctx.newPage();
    if (user) { await page.goto(BASE + '/login'); await page.evaluate((u) => localStorage.setItem('pos_user', JSON.stringify(u)), user); }
    for (const [name, url, actions = []] of role.shots) {
      if (only && !name.startsWith(only)) continue;
      try {
        await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 25000 });
        await page.waitForTimeout(1600);
        for (const a of actions) { await step(page, a); await page.waitForTimeout(700); }
        await page.waitForTimeout(1400);
        await page.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 88 });
        console.log('ok', name);
      } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); }
    }
    await ctx.close();
  }
  await browser.close();
})();
