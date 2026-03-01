import { test, expect } from '@playwright/test';

test.describe('Tab Navigation', () => {
  test('navigates to correlations page', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab-btn', { hasText: 'Correlations' }).click();
    await expect(page).toHaveURL('/correlations');
  });

  test('navigates to coverage page', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab-btn', { hasText: 'Coverage' }).click();
    await expect(page).toHaveURL('/coverage');
  });

  test('navigates to pipeline page', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab-btn', { hasText: 'Pipeline' }).click();
    await expect(page).toHaveURL('/pipeline');
  });

  test('navigates to agents page via keyboard', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tab-btn').first()).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('a');
    await expect(page).toHaveURL('/agents');
  });
});

test.describe('Keyboard Shortcuts', () => {
  test('opens shortcut overlay with ?', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tab-btn').first()).toBeVisible();
    // Use keyboard.type to send '?' character directly
    await page.keyboard.type('?');
    await expect(page.locator('.shortcut-overlay')).toBeVisible({ timeout: 3_000 });
  });

  test('navigates home with g then h', async ({ page }) => {
    await page.goto('/correlations');
    await expect(page.locator('.tab-btn').first()).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await expect(page).toHaveURL('/');
  });

  test('navigates to correlations with g then c', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tab-btn').first()).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('c');
    await expect(page).toHaveURL('/correlations');
  });

  test('switches period with number keys', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tab-btn').first()).toBeVisible();
    await page.keyboard.press('1');
    await expect(page.locator('.period-btn.active')).toHaveText('24h');
    await page.keyboard.press('2');
    await expect(page.locator('.period-btn.active')).toHaveText('7d');
    await page.keyboard.press('3');
    await expect(page.locator('.period-btn.active')).toHaveText('30d');
  });
});

test.describe('Metric Detail Page', () => {
  test.describe.configure({ mode: 'serial' });
  const metricName = 'relevance';

  test('renders metric detail with back link', async ({ page }) => {
    await page.goto(`/metrics/${metricName}`);
    await expect(page.getByText(/back to dashboard/i)).toBeVisible({ timeout: 15_000 });
  });

  test('shows metric heading after data loads', { timeout: 60_000 }, async ({ page }) => {
    await page.goto(`/metrics/${metricName}`);
    // h2 with metric display name appears once API responds and skeleton is replaced
    await expect(page.locator('.text-lg').first()).toBeVisible({ timeout: 45_000 });
  });

  test('shows evaluations section', { timeout: 60_000 }, async ({ page }) => {
    await page.goto(`/metrics/${metricName}`);
    // ViewSection with title "Evaluations" renders after data loads
    await expect(page.getByRole('heading', { name: 'Evaluations', exact: true })).toBeVisible({ timeout: 45_000 });
  });
});
