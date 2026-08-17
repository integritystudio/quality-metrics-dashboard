import { defineConfig, devices } from '@playwright/test';

import { API_HOST, API_PORT } from './src/api/config.js';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const API_HEALTH_URL = `http://${API_HOST}:${API_PORT}/api/health`;
const isIntegration = process.env.INTEGRATION === '1';
const SERVER_TIMEOUT_MS = 30_000;

/**
 * The deployed dashboard Worker the integration project runs against.
 *
 * Fail-fast, never defaulted: this used to fall back to the PRODUCTION Worker,
 * and `e2e/integration/setup.ts` upserts a test user into `public.users` and
 * assigns it a role — so one unset variable turned a dev test run into a
 * production write. `setup.ts` already `requireEnv`s the same name; this
 * matches it so the config cannot resolve to a target the setup would reject.
 *
 * Resolved only for the integration project — the chromium project runs against
 * a local server and must keep working without any Doppler context.
 */
function requireMetricsApiUrl(): string {
  const url = process.env.METRICS_API_URL;
  if (!url) {
    throw new Error(
      'Missing env var: METRICS_API_URL. Run with: doppler run --project integrity-studio --config dev -- npm run test:e2e:integration',
    );
  }
  return url;
}

export default defineConfig({
  testDir: './e2e',
  // API-backed tests contend on local telemetry reads; serial execution is more stable.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { open: 'never' }],
    // `list` is explicit because sentry-reporter.ts is a side channel that
    // prints nothing: registering ANY custom reporter stops Playwright from
    // supplying a console one, so integration runs reported pass/fail only to
    // Sentry and the HTML file — CI logs and `--list` were silent. Verified:
    // `--reporter=html,<sentry>` lists 0 tests, `--reporter=list,<sentry>` lists 39.
    ...(isIntegration
      ? [['list'] as const, ['./e2e/integration/sentry-reporter.ts'] as const]
      : []),
  ],
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
        // Integration tests hit the deployed Worker directly — no browser needed.
        // Resolved lazily so only an actual integration run requires the var.
        ...(isIntegration ? { baseURL: requireMetricsApiUrl() } : {}),
      },
    },
  ],

  // Two entries, not one `npm run dev`: Playwright gates readiness per entry, so
  // the API gets its own health check. Under a single concurrently-run command it
  // waited on Vite alone and tests started against a dead /api proxy (502s).
  webServer: isIntegration ? undefined : [
    {
      command: 'tsx src/api/server.ts',
      url: API_HEALTH_URL,
      reuseExistingServer: !process.env.CI,
      timeout: SERVER_TIMEOUT_MS,
      env: {
        ...process.env,
        VITE_E2E: '1',
      },
    },
    {
      command: 'vite',
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: SERVER_TIMEOUT_MS,
      env: {
        ...process.env,
        VITE_E2E: '1',
      },
    },
  ],
});
