import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the *built* server (dist/) serving the *built* web bundle
 * (web/dist), exactly like `npm start`. Individual specs spawn and restart the
 * server themselves (see tests/e2e/server.ts) so they can prove storage reopen
 * and real network ingest, not just same-process behaviour.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
