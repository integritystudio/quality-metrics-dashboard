import { test, expect } from '@playwright/test';

test.describe('Error & Empty States', () => {
  test('shows loading skeleton on initial load', async ({ page }) => {
    await page.route('**/api/dashboard*', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await route.continue();
    });
    await page.goto('/');
    const skeleton = page.locator('[class*="skeleton"], [class*="loading"], [aria-busy="true"]');
    await expect(skeleton.first()).toBeVisible();
  });

  test('shows error state when API fails', async ({ page }) => {
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({ status: 500, body: JSON.stringify({ error: 'Internal error' }) })
    );
    await page.goto('/');
    const error = page.locator('text=/error|failed|unavailable|went wrong/i');
    await expect(error.first()).toBeVisible({ timeout: 10_000 });
  });

  test('handles 404 metric gracefully', async ({ page }) => {
    await page.goto('/metrics/nonexistent-metric-xyz');
    // Should show error, empty state, or loading that resolves — not a crash
    await page.waitForTimeout(3000);
    // Page should still be interactive (no white screen)
    await expect(page.locator('body')).not.toBeEmpty();
  });
});

test.describe('Responsive Layout', () => {
  test('renders on mobile viewport without crash', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    // Dashboard should still show content
    await expect(page.locator('h1')).toContainText('Quality Metrics');
  });

  test('renders on tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    await expect(page.locator('.metric-grid, .card-link').first()).toBeVisible();
  });
});
