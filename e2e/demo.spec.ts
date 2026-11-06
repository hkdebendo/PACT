// The demo scenario, end to end through the browser: compose a deal (recorded Contract Parser
// answer), accept as the seller, fund (SIMULATED approval), submit the wrong photo (rejected), the
// right photo (approved → partial capture), tracking (approved → final capture), then check the
// Control Tower and the audit chain.
import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const fixture = (f: string) => resolve(import.meta.dirname, '..', 'fixtures', 'evidence', f);

async function upload(page: Page, milestone: string, file: string, type: string) {
  const li = page.locator(`#milestone-${milestone}`);
  await li.getByLabel('Evidence file').setInputFiles(fixture(file));
  await li.getByLabel('Evidence type').selectOption(type);
  await li.getByRole('button', { name: 'Submit evidence' }).click();
  await li.getByRole('button', { name: 'Verify with Muse' }).click();
}

test('PACT demo scenario', async ({ page }) => {
  await page.goto('/pacts/new');
  await page.getByRole('button', { name: 'Read it with Muse' }).click();
  await expect(page.getByText('Parsed')).toBeVisible();
  await expect(page.getByText('Milestones sum to 100%')).toBeVisible();
  await page.getByRole('button', { name: /Create & propose/ }).click();
  await page.waitForURL(/\/pacts\/pact_/);

  // Seller accepts.
  await page.getByRole('radio', { name: /seller/i }).click();
  await page.getByRole('button', { name: 'Accept this pact' }).click();

  // Buyer funds (SIMULATED approval in e2e).
  await page.getByRole('radio', { name: /buyer/i }).click();
  await page.getByRole('button', { name: /Approve \(SIMULATED PayPal\)|I approved/ }).first().click();
  await expect(page.getByText(/Held by PayPal/).first()).toBeVisible();
  await expect(page.getByText('funded', { exact: true }).or(page.getByText('in progress', { exact: true })).first()).toBeVisible();

  // Seller: wrong photo, then the right one, then tracking.
  await page.getByRole('radio', { name: /seller/i }).click();
  await upload(page, 'm1', 'order_wrong_item.jpg', 'photo');
  await expect(page.locator('#milestone-m1').getByText('rejected').first()).toBeVisible();
  await upload(page, 'm1', 'order_conforming.jpg', 'photo');
  await expect(page.locator('#milestone-m1').getByText('released').first()).toBeVisible();
  await upload(page, 'm2', 'tracking_valid.png', 'tracking');
  await expect(page.locator('#milestone-m2').getByText('released').first()).toBeVisible();
  await expect(page.getByText('completed').first()).toBeVisible();
  await expect(page.getByText('Chain verified').first()).toBeVisible();

  // Control Tower renders the live ledger.
  await page.goto('/control-tower');
  await expect(page.getByText('In escrow now')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Pact ledger')).toBeVisible();
});
