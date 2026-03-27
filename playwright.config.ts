import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const isIntegration = process.env.INTEGRATION === '1';

export default defineConfig({
  testDir: './e2e',
  // API-backed tests contend on local telemetry reads; serial execution is more stable.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // Integration tests manage their own setup/teardown via globalSetup.
  // Only register when running the integration project.
  ...(isIntegration ? {
    globalSetup: './e2e/integration/setup.ts',
    globalTeardown: './e2e/integration/teardown.ts',
  } : {}),

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /integration\//,
    },
    {
      name: 'integration',
      testDir: './e2e/integration',
      use: {
        // Integration tests hit deployed worker directly — no browser needed
        baseURL: process.env.DEV_WORKER_URL ?? 'https://quality-metrics-api.alyshia-b38.workers.dev',
      },
    },
  ],

  webServer: isIntegration ? undefined : {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      ...process.env,
      VITE_E2E: '1',
    },
  },
});
