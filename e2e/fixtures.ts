import { test as base, expect } from '@playwright/test';

const TEST_SESSION = {
  access_token: 'test-token',
  refresh_token: 'test-refresh',
  expires_at: 9_999_999_999, // year 2286 — never expires in tests
  user: { id: 'test-user-id', email: 'test@example.com' },
};

const MOCK_ME_RESPONSE = {
  email: 'test@example.com',
  roles: ['test'],
  permissions: ['dashboard.admin'],
  allowedViews: ['executive', 'operator', 'auditor'],
};

export const test = base.extend<object>({
  page: async ({ page }, use) => {
    // Seed session into localStorage before page JS runs
    await page.addInitScript((session: unknown) => {
      localStorage.setItem('supabase.session', JSON.stringify(session));
    }, TEST_SESSION);

    // Mock /api/me so AuthContext.fetchAppSession() resolves successfully
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
