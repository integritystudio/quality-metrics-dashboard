/**
 * The admin customer view end to end (ADMIN-CV-PARITY-TESTS, "Access"): a staff session
 * walks hub → each screen → back with the org kept, a reload on a screen renders it, and
 * a non-staff `dashboard.admin` session gets Access Denied. The gateway is answered with
 * `page.route` (its URL is `.env.test`'s unroutable host), so nothing here depends on live
 * data or on api-gateway being deployed.
 */
import { test, expect, MOCK_STAFF_ME_RESPONSE, mockMe } from './fixtures.js';

const GATEWAY_ROUTE = '**/v1/admin/**';
const ORG_A = { id: 'a0000000-0000-4000-8000-00000000000a', name: 'Acme', slug: 'acme', billing_status: 'active', current_plan: 'growth' };
const ORG_B = { id: 'b0000000-0000-4000-8000-00000000000b', name: 'Beta Labs', slug: 'beta-labs', billing_status: 'inactive', current_plan: 'starter' };

const PAYLOADS: Array<[suffix: string, body: (orgId: string) => unknown]> = [
  ['/billing-status', (orgId) => ({ org_id: orgId, billing_status: 'active', current_plan: 'growth', quota_version: 1, role: null, has_billing_account: true })],
  ['/usage/summary', (orgId) => ({
    org_id: orgId,
    period_start: '2026-10-01',
    buckets: [{ organization_id: orgId, bucket_date: '2026-10-01', metric_key: 'requests', total_quantity: 100, request_count: 10, avg_latency_ms: 5 }],
  })],
  ['/quota/status', (orgId) => ({ org_id: orgId, orgId, planKey: 'growth', quotaVersion: 1, minuteLimit: 60, monthlyLimit: 500000, minuteUsed: 5, monthlyUsed: 12345, minuteWindowExpiresIn: 45000 })],
  ['/entitlements', (orgId) => ({ org_id: orgId, entitlements: { usage_dashboard: true, monthly_units: 500000 } })],
];

/** The gateway is cross-origin, so the preflight is answered and every reply carries CORS. */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function stubGateway(page: Parameters<typeof mockMe>[0]): Promise<string[]> {
  const requested: string[] = [];
  await page.route(GATEWAY_ROUTE, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
    const { pathname } = new URL(request.url());
    requested.push(pathname);
    const orgMatch = /^\/v1\/admin\/orgs\/([^/]+)(\/.*)$/.exec(pathname);
    const body = orgMatch
      ? PAYLOADS.find(([suffix]) => suffix === orgMatch[2])?.[1](orgMatch[1]!)
      : { organizations: [ORG_A, ORG_B] };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_HEADERS, body: JSON.stringify(body) });
  });
  return requested;
}

const SCREENS = [
  ['Billing', 'billing', 'Billing Status'],
  ['Usage', 'usage', 'Usage Summary'],
  ['Quota', 'quota', 'Quota Status'],
  ['Entitlements', 'entitlements', 'Entitlements'],
] as const;

test.describe('Admin customer view', () => {
  test('staff walks hub → each screen → back with the org kept', async ({ page }) => {
    await mockMe(page, MOCK_STAFF_ME_RESPONSE);
    const requested = await stubGateway(page);

    await page.goto('/admin/customers');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByLabel('Organization').selectOption(ORG_B.id);
    await expect(page).toHaveURL(`/admin/customers?org=${ORG_B.id}`);

    for (const [card, segment, heading] of SCREENS) {
      await page.getByRole('link', { name: new RegExp(`^${card}`) }).click();
      await expect(page).toHaveURL(`/admin/customers/${ORG_B.id}/${segment}`);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await expect(page.getByText(`Org id: ${ORG_B.id}`)).toBeVisible();
      await page.getByRole('link', { name: /Back to customers/ }).click();
      await expect(page).toHaveURL(`/admin/customers?org=${ORG_B.id}`);
      await expect(page.getByLabel('Organization')).toHaveValue(ORG_B.id);
    }

    expect(requested.every((p) => p === '/v1/admin/orgs' || p.startsWith(`/v1/admin/orgs/${ORG_B.id}/`))).toBe(true);
  });

  test('a reload on a screen renders that org', async ({ page }) => {
    await mockMe(page, MOCK_STAFF_ME_RESPONSE);
    await stubGateway(page);

    await page.goto(`/admin/customers/${ORG_A.id}/usage`);

    await expect(page.getByRole('heading', { name: 'Usage Summary', exact: true })).toBeVisible();
    await expect(page.getByText('12345 / 500000 units')).toBeVisible();
    await expect(page.getByText(`Org id: ${ORG_A.id}`)).toBeVisible();
  });

  test('the Customers link is in the header for staff', async ({ page }) => {
    await mockMe(page, MOCK_STAFF_ME_RESPONSE);
    await stubGateway(page);

    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Customers' })).toHaveAttribute('href', '/admin/customers');
  });

  test('a dashboard.admin session that is not staff gets Access Denied and no link', async ({ page }) => {
    const requested = await stubGateway(page);

    await page.goto('/admin/customers');

    await expect(page.getByText('Access Denied')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Customers' })).toHaveCount(0);
    expect(requested).toEqual([]);
  });
});
