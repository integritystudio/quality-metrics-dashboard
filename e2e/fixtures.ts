import { test as base, expect } from '@playwright/test';

import { API_HOST, API_PORT } from '../src/api/config.js';

// Must match TEST_TOKEN in src/stubs/auth0-e2e.ts
const MOCK_ME_RESPONSE = {
  email: 'test@example.com',
  roles: ['test'],
  permissions: ['dashboard.admin'],
  allowedViews: ['executive', 'operator', 'auditor'],
};

const HEALTH_URL = `http://${API_HOST}:${API_PORT}/api/health`;

/**
 * Reason shown when a data-dependent spec is skipped.
 *
 * The API reads a live cloud window, so whether it has rows is a property of
 * the environment, not of the code under test. Specs that assert on *rendered
 * metric content* (cards, sparklines, percentages, table rows) can only pass
 * when that window is non-empty — against an empty one the app correctly
 * renders empty states, and failing there would report an environment fact as
 * a regression. Specs that assert on navigation, layout and controls stay
 * unconditional: those must pass with or without data.
 */
export const NO_DATA_SKIP_REASON =
  'API reports hasData: false — seed with `npm run populate -- --seed` to run data-dependent specs';

type WorkerFixtures = {
  /** Whether /api/health reports a non-empty data window. Fetched once per worker. */
  hasData: boolean;
};

export const test = base.extend<object, WorkerFixtures>({
  hasData: [
    async ({}, use) => {
      let hasData = false;
      try {
        const res = await fetch(HEALTH_URL);
        if (res.ok) {
          const body = (await res.json()) as { hasData?: boolean };
          hasData = body.hasData === true;
        }
      } catch {
        // Unreachable API is a real failure — let the specs surface it rather
        // than masking it as "no data", which would skip them silently.
        hasData = true;
      }
      await use(hasData);
    },
    { scope: 'worker' },
  ],

  page: async ({ page }, use) => {
    // Mock /api/me so AuthContext.fetchAppSession() resolves with a valid session.
    // The Auth0 stub (active when VITE_E2E=1) calls getAccessTokenSilently() → 'test-token',
    // which AuthContext passes as Bearer to /api/me.
    await page.route('**/api/me', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_ME_RESPONSE),
      })
    );

    await use(page);
  },
});

export { expect };
