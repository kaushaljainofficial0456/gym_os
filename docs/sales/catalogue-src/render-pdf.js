// Renders BARBELL_Feature_Catalogue_Source.html to BARBELL_Complete_Feature_Catalogue.pdf
// with Chromium (Playwright). Usage: node docs/sales/catalogue-src/render-pdf.js
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'BARBELL_Feature_Catalogue_Source.html');
const OUT = path.resolve(__dirname, '..', 'BARBELL_Complete_Feature_Catalogue.pdf');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + SRC, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight));
  console.log('fonts loaded:', [...new Set(fonts)].join(', '));
  await page.pdf({ path: OUT, preferCSSPageSize: true, printBackground: true, tagged: true, outline: true });
  await browser.close();
  console.log('wrote', OUT);
})();
