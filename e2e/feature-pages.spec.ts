import { test, expect } from '@playwright/test';

test.describe('Correlations Page', () => {
  test('renders correlation content', async ({ page }) => {
    await page.goto('/correlations');
    await expect(page.locator('table, svg, .card').first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Coverage Page', () => {
  test('renders coverage content', async ({ page }) => {
    await page.goto('/coverage');
    await expect(page.locator('table, .card').first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Pipeline Page', () => {
  test('renders pipeline content', async ({ page }) => {
    await page.goto('/pipeline');
    await expect(page.locator('.card, table, [class*="stage"]').first()).toBeVisible({ timeout: 15_000 });
  });

  test('shows percentage values after data loads', async ({ page }) => {
    const responsePromise = page.waitForResponse('**/api/pipeline*');
    await page.goto('/pipeline');
    await responsePromise;
    // Pipeline funnel should show percentage dropoff values
    const percentages = page.getByText(/%/);
    await expect(percentages.first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Compliance Page', () => {
  test('renders SLA compliance table', async ({ page }) => {
    await page.goto('/compliance');
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });
  });

  test('renders compliance framework map', async ({ page }) => {
    await page.goto('/compliance');
    await expect(page.getByText('EU AI Act')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('NIST')).toBeVisible();
  });
});

test.describe('Agents Page', () => {
  test('renders agent activity content', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.locator('table, .card').first()).toBeVisible({ timeout: 15_000 });
  });
});
