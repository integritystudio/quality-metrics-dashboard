import { test, expect } from '@playwright/test';

test.describe('Dashboard Home', () => {
  test('loads and displays metric grid', async ({ page }) => {
    await page.goto('/');
    // Wait for data to load (card-link appears when API responds)
    await expect(page.locator('.card-link').first()).toBeVisible({ timeout: 15_000 });
  });

  test('displays period selector with 3 options', async ({ page }) => {
    await page.goto('/');
    const buttons = page.locator('.period-btn');
    await expect(buttons).toHaveCount(3);
  });

  test('switches period via period-btn', async ({ page }) => {
    await page.goto('/');
    await page.locator('.period-btn', { hasText: '24h' }).click();
    await expect(page.locator('.period-btn.active')).toHaveText('24h');
  });

  test('shows sparklines in metric cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.card-link').first()).toBeVisible({ timeout: 15_000 });
    const sparklines = page.locator('.card-link svg');
    await expect(sparklines.first()).toBeVisible();
  });
});

test.describe('Role Navigation', () => {
  test('navigates to executive role view via tab', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab-btn', { hasText: 'Executive' }).click();
    await expect(page).toHaveURL(/\/role\/executive/);
  });

  test('navigates to operator role view via tab', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab-btn', { hasText: 'Operator' }).click();
    await expect(page).toHaveURL(/\/role\/operator/);
  });

  test('navigates to auditor role view via tab', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab-btn', { hasText: 'Auditor' }).click();
    await expect(page).toHaveURL(/\/role\/auditor/);
  });
});
