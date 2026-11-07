// Captures README screenshots from the running app (npm run dev) into docs/screenshots/.
// Usage: node scripts/dev/screenshots.cjs [pactId]
const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

(async () => {
  const out = path.resolve(__dirname, '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(out, { recursive: true });
  const base = 'http://localhost:3000';
  const pactId = process.argv[2];
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
  const shot = async (name, url, opts = {}) => {
    const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: opts.scale ?? 1, colorScheme: opts.dark ? 'dark' : 'light' });
    const page = await ctx.newPage();
    if (opts.dark) await page.addInitScript(() => localStorage.setItem('pact-theme', 'dark'));
    await page.goto(base + url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(opts.wait ?? 7000);
    if (opts.before) await opts.before(page);
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: !!opts.full });
    console.log('wrote', name);
    await ctx.close();
  };
  await shot('landing', '/');
  await shot('control-tower', '/control-tower', { wait: 10000 });
  await shot('control-tower-dark', '/control-tower', { wait: 10000, dark: true });
  await shot('reputation', '/control-tower', {
    wait: 9000,
    before: async (p) => {
      await p.getByRole('button', { name: 'Reputation' }).click();
      await p.waitForTimeout(3000);
    },
  });
  await shot('composer', '/pacts/new');
  if (pactId) await shot('pact-room', `/pacts/${pactId}`, { full: true });
  await shot('mobile-pacts', '/pacts', { viewport: { width: 390, height: 844 }, scale: 2 });
  await shot('admin', '/admin');
  await browser.close();
})();
