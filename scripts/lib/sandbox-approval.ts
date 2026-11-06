// Completes the PayPal SANDBOX buyer approval with the sandbox test buyer from .env.local
// (DEMO_BUYER_EMAIL / DEMO_BUYER_PASSWORD). Sandbox test accounts only; never a real account.
// Uses the locally installed Chrome (or Edge), so no Playwright browser download is needed.
import { chromium, type Page } from '@playwright/test';
import { loadEnv } from '@pact/db';

async function clickFirst(page: Page, selectors: string[], timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const s of selectors) {
      const el = page.locator(s).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        return s;
      }
    }
    await page.waitForTimeout(400);
  }
  // Leave evidence for debugging: a screenshot (git-ignored data/) and the visible button labels.
  await page.screenshot({ path: 'data/paypal-approval-failure.png', timeout: 30_000, animations: 'disabled' }).catch((e) => console.error('screenshot failed:', String((e as Error).message).slice(0, 200)));
  const buttons = await page.locator('button:visible').allInnerTexts().catch(() => [] as string[]);
  throw new Error(`None of these appeared on the PayPal page: ${selectors.join(', ')}. Visible buttons: ${buttons.map((b) => b.trim()).filter(Boolean).join(' | ')}. URL: ${page.url().split('?')[0]}`);
}

export async function approveSandboxOrder(approvalUrl: string, opts: { headless?: boolean } = {}) {
  loadEnv();
  const email = process.env.DEMO_BUYER_EMAIL;
  const password = process.env.DEMO_BUYER_PASSWORD;
  if (!email || !password) throw new Error('DEMO_BUYER_EMAIL / DEMO_BUYER_PASSWORD are not set in .env.local (sandbox buyer test account).');
  if (!/sandbox\.paypal\.com/.test(approvalUrl)) throw new Error('Refusing to automate a non-sandbox PayPal URL.');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: opts.headless ?? true });
  try {
    const page = await browser.newPage();
    // Slow connections: the sandbox checkout can take minutes to load.
    page.setDefaultTimeout(180_000);
    await page.goto(approvalUrl, { waitUntil: 'commit', timeout: 180_000 });
    await page.locator('#email').fill(email, { timeout: 180_000 });
    // Newer checkout shows the password on a second step.
    if (await page.locator('#btnNext').isVisible().catch(() => false)) await page.locator('#btnNext').click();
    await page.locator('#password').fill(password, { timeout: 180_000 });
    await clickFirst(page, ['#btnLogin', 'button[type=submit]']);
    await clickFirst(page, ['#payment-submit-btn', 'button[data-testid="submit-button-initial"]', 'button:has-text("Continue")', 'button:has-text("Agree")', 'button:has-text("Pay")'], 180_000);
    await page.waitForURL(/paypal=approved/, { timeout: 180_000 }).catch(() => undefined);
  } finally {
    await browser.close();
  }
}
