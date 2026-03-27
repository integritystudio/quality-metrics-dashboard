import { test as base, expect } from '@playwright/test';

// Must match TEST_TOKEN in src/stubs/auth0-e2e.ts
const MOCK_ME_RESPONSE = {
  email: 'test@example.com',
  roles: ['test'],
  permissions: ['dashboard.admin'],
  allowedViews: ['executive', 'operator', 'auditor'],
};

export const test = base.extend<object>({
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
