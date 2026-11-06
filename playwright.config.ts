import { defineConfig } from '@playwright/test';

// Uses the locally installed Chrome (channel "chrome"), so no browser download is required.
// The servers run in SIMULATED PayPal + replay mode on a separate database, so e2e never touches
// the sandbox or the developer's data. Set E2E_SANDBOX=1 to run against the real sandbox instead.
const sandbox = process.env.E2E_SANDBOX === '1';
const env = {
  ...(process.env as Record<string, string>),
  DATABASE_URL: 'file:./data/e2e.db',
  ...(sandbox ? {} : { PAYPAL_ENV: 'simulated' }),
  LLM_MODE: 'replay',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    { command: 'npm run start -w @pact/api', url: 'http://localhost:4000/health', reuseExistingServer: !process.env.CI, env, timeout: 120_000 },
    { command: 'npm run dev -w @pact/web', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI, env, timeout: 300_000 },
  ],
});
