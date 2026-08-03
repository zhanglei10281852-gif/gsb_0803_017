import { defineConfig } from '@playwright/test';

const PORT = 5181;
const DB_PATH = `./data/e2e-${process.pid}.db`;

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 1280, height: 800 }
  },
  webServer: {
    command: `node dist/server/main.js --port ${PORT} --no-seed --db ${DB_PATH}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 30000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
