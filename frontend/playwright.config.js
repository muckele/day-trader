const { defineConfig, devices } = require('@playwright/test');

const defaultPort = process.env.PORT || '3100';
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${defaultPort}`;

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL,
    trace: 'on-first-retry'
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `PORT=${defaultPort} BROWSER=none npm start`,
        url: baseURL,
        timeout: 120_000,
        reuseExistingServer: true
      },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
