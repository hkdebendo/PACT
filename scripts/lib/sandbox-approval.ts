// Completes the PayPal SANDBOX buyer approval with the sandbox test buyer from .env.local
// (DEMO_BUYER_EMAIL / DEMO_BUYER_PASSWORD). Sandbox test accounts only; never a real account.
// Uses the locally installed Chrome (or Edge), so no Playwright browser download is needed.
import { chromium, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { loadEnv, repoRoot } from '@pact/db';

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

/** Approves with up to `attempts` fresh browsers: the sandbox wallet page sometimes never finishes loading. */
export async function approveSandboxOrder(approvalUrl: string, opts: { headless?: boolean; attempts?: number } = {}) {
  const attempts = opts.attempts ?? 2;
  for (let i = 1; ; i++) {
    try {
      return await approveOnce(approvalUrl, opts);
    } catch (e) {
      if (i >= attempts) throw e;
      console.warn(`PayPal sandbox approval attempt ${i} failed (${(e as Error).message.slice(0, 80)}…); retrying in a fresh browser.`);
    }
  }
}

async function approveOnce(approvalUrl: string, opts: { headless?: boolean } = {}) {
  loadEnv();
  const email = process.env.DEMO_BUYER_EMAIL;
  const password = process.env.DEMO_BUYER_PASSWORD;
  if (!email || !password) throw new Error('DEMO_BUYER_EMAIL / DEMO_BUYER_PASSWORD are not set in .env.local (sandbox buyer test account).');
  if (!/sandbox\.paypal\.com/.test(approvalUrl)) throw new Error('Refusing to automate a non-sandbox PayPal URL.');
  // A persistent profile (git-ignored data/) keeps the sandbox session between runs, which makes the
  // checkout's wallet step load faster and more reliably than a fresh browser every time.
  const browser = await chromium.launchPersistentContext(resolve(repoRoot, 'data', 'paypal-sandbox-profile'), {
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: opts.headless ?? true,
    viewport: { width: 1280, height: 860 },
  });
  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    // Slow connections: the sandbox checkout can take minutes to load.
    page.setDefaultTimeout(180_000);
    await page.goto(approvalUrl, { waitUntil: 'commit', timeout: 180_000 });
    // With a remembered session PayPal may skip the login form and go straight to the review page.
    // PayPal serves several checkout variants: a login form, a landing page with a "Log In" button,
    // or (remembered session) the review page directly.
    const loginButton = page.getByText(/^\s*log in\s*$/i).first();
    const first = await Promise.race([
      page.locator('#email').waitFor({ timeout: 180_000 }).then(() => 'login' as const),
      loginButton.waitFor({ timeout: 180_000 }).then(() => 'landing' as const),
      page.locator('#payment-submit-btn').waitFor({ timeout: 180_000 }).then(() => 'review' as const),
    ]).catch(() => 'login' as const);
    if (first === 'landing') await loginButton.click();
    if (first !== 'review') {
      await page.locator('#email').fill(email, { timeout: 180_000 });
      // Newer checkout shows the password on a second step.
      if (await page.locator('#btnNext').isVisible().catch(() => false)) await page.locator('#btnNext').click();
      await page.locator('#password').fill(password, { timeout: 180_000 });
      await clickFirst(page, ['#btnLogin', 'button[type=submit]']);
    }
    await clickFirst(page, ['#payment-submit-btn', 'button[data-testid="submit-button-initial"]', 'button:has-text("Review Order")', 'button:has-text("Continue")', 'button:has-text("Agree")', 'button:has-text("Pay")'], 180_000);
    // Some accounts get an extra confirmation screen: keep confirming until PayPal redirects back to
    // PACT's return URL, and fail loudly if it never does (the caller must not assume approval).
    for (let step = 0; step < 3; step++) {
      const back = await page.waitForURL(/paypal=approved/, { timeout: 60_000 }).then(() => true).catch(() => false);
      if (back) return;
      if (/paypal=cancelled/.test(page.url())) throw new Error('The PayPal checkout was cancelled.');
      await clickFirst(page, ['#payment-submit-btn', 'button[data-testid="submit-button-initial"]', 'button:has-text("Review Order")', 'button:has-text("Continue")', 'button:has-text("Agree")', 'button:has-text("Pay")', 'button:has-text("Complete")'], 30_000).catch(() => undefined);
    }
    await page.screenshot({ path: 'data/paypal-approval-failure.png', timeout: 30_000 }).catch(() => undefined);
    throw new Error(`PayPal did not redirect back to PACT after approval (still on ${page.url().split('?')[0]}). See data/paypal-approval-failure.png.`);
  } finally {
    await browser.close();
  }
}
