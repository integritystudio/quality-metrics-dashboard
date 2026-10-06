/**
 * The admin customer view's five screens and its gate, rendered against the real query
 * stack, the real `OrgProvider` and a memory router, with `useAuth` substituted and
 * `fetch` backed by the fake gateway. Each screen's assertions follow the Flutter page it
 * clones (IntegrityLandingPage lib/pages/*.dart) and the epic's acceptance list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { ReactNode } from 'react';
import { OrgProvider } from '../contexts/OrgContext.js';
import { StaffGuard, StaffCustomersLink } from '../components/StaffGuard.js';
import { PageShell } from '../components/PageShell.js';
import { AdminCustomerHubPage } from '../pages/admin-customer/AdminCustomerHubPage.js';
import { AdminCustomerBillingPage } from '../pages/admin-customer/AdminCustomerBillingPage.js';
import { AdminCustomerUsagePage } from '../pages/admin-customer/AdminCustomerUsagePage.js';
import { AdminCustomerQuotaPage } from '../pages/admin-customer/AdminCustomerQuotaPage.js';
import { AdminCustomerEntitlementsPage } from '../pages/admin-customer/AdminCustomerEntitlementsPage.js';
import { routes } from '../lib/routes.js';
import { ADMIN_VIEW, CUSTOMER_VIEW } from '../lib/admin-customer-strings.js';
import type { AppSession } from '../types/auth.js';
import { TEST_ACCESS_TOKEN, makeQueryWrapper } from './support/query-harness.js';
import { startFakeGateway } from './support/fake-gateway.js';
import {
  BILLING_ACTIVE, ENTITLEMENTS_EMPTY, ENTITLEMENTS_GROWTH, ORG_A, ORG_B,
  QUOTA_GROWTH, QUOTA_UNINITIALIZED, USAGE_EMPTY, USAGE_SUMMARY,
} from './support/admin-customer-fixtures.js';

let currentSession: AppSession | null = null;
const getAccessToken = () => Promise.resolve(TEST_ACCESS_TOKEN);

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ session: currentSession, isLoading: false, getAccessToken }),
}));

const HTTP_FORBIDDEN = 403;

const STAFF_SESSION: AppSession = {
  email: 'staff@example.com',
  roles: [],
  permissions: ['dashboard.read', 'dashboard.admin'],
  allowedViews: [],
  activeOrgId: ORG_B.id,
  memberships: [{ orgId: ORG_B.id, slug: 'beta-labs', name: 'Beta Labs', membershipRole: 'owner', dashboardRole: 'owner' }],
  role: 'owner',
  isStaff: true,
};

/** An org owner: `dashboard.admin` without `isStaff`, the case the gate exists for. */
const OWNER_SESSION: AppSession = { ...STAFF_SESSION, isStaff: false };

const ALL_FIXTURES = {
  directory: () => ({ organizations: [ORG_A, ORG_B] }),
  billing: () => BILLING_ACTIVE,
  usage: () => USAGE_SUMMARY,
  quota: () => QUOTA_GROWTH,
  entitlements: () => ENTITLEMENTS_GROWTH,
};

/** Mount `ui` at `path` under the real providers; returns the memory router for navigation assertions. */
function renderAt(path: string, ui: ReactNode, session: AppSession = STAFF_SESSION) {
  currentSession = session;
  const location = memoryLocation({ path, record: true });
  const { wrapper: QueryWrapper } = makeQueryWrapper();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryWrapper>
        <OrgProvider>
          <Router hook={location.hook} searchHook={location.searchHook}>{children}</Router>
        </OrgProvider>
      </QueryWrapper>
    );
  }
  render(ui, { wrapper: Wrapper });
  return location;
}

const currentPath = (location: ReturnType<typeof memoryLocation>) => location.history!.at(-1);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  currentSession = null;
  try {
    window.localStorage.clear();
  } catch {
    // Node's own localStorage shadows jsdom's and may be unavailable; nothing was persisted then.
  }
});

describe('StaffGuard and the Customers link (ADMIN-CV-STAFF-GATE)', () => {
  it('hides the entry point and refuses the route for an org owner with dashboard.admin', () => {
    renderAt('/admin/customers', <><StaffCustomersLink /><StaffGuard><p>customer view</p></StaffGuard></>, OWNER_SESSION);
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(screen.queryByText('customer view')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: ADMIN_VIEW.customersLink })).not.toBeInTheDocument();
  });

  it('treats a session with no isStaff field as not staff', () => {
    const { isStaff: _dropped, ...legacy } = STAFF_SESSION;
    renderAt('/admin/customers', <StaffGuard><p>customer view</p></StaffGuard>, legacy);
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
  });

  it('shows both for staff', () => {
    renderAt('/admin/customers', <><StaffCustomersLink /><StaffGuard><p>customer view</p></StaffGuard></>);
    expect(screen.getByText('customer view')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: ADMIN_VIEW.customersLink })).toHaveAttribute('href', routes.adminCustomers());
  });
});

describe('PageShell back link (ADMIN-CV-LAYOUT-NAV)', () => {
  it('still goes home for existing callers', () => {
    renderAt('/x', <PageShell isLoading={false} error={null}><p>body</p></PageShell>);
    expect(screen.getByRole('link', { name: /Back to dashboard/ })).toHaveAttribute('href', '/');
  });

  it('goes where a page says', () => {
    renderAt('/x', <PageShell isLoading={false} error={null} backHref="/admin/customers?org=1" backLabel="Back to customers"><p>body</p></PageShell>);
    expect(screen.getByRole('link', { name: /Back to customers/ })).toHaveAttribute('href', '/admin/customers?org=1');
  });
});

describe('AdminCustomerHubPage (ADMIN-CV-HUB)', () => {
  it('shows a loading indicator, then the directory in one dropdown with the first org selected', async () => {
    startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomers(), <AdminCustomerHubPage />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    const select = await screen.findByLabelText(CUSTOMER_VIEW.hub.orgLabel);
    expect(select).toHaveValue(ORG_A.id);
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([ORG_A.name, ORG_B.name]);
    expect(screen.getByRole('heading', { name: CUSTOMER_VIEW.hub.title })).toBeInTheDocument();
  });

  it('shows the error with Try again, and loads after a retry', async () => {
    const gateway = startFakeGateway(ALL_FIXTURES);
    gateway.control.refuse = { status: HTTP_FORBIDDEN };
    renderAt(routes.adminCustomers(), <AdminCustomerHubPage />);

    expect(await screen.findByText(CUSTOMER_VIEW.errors.forbidden)).toBeInTheDocument();
    gateway.control.refuse = null;
    fireEvent.click(screen.getByRole('button', { name: CUSTOMER_VIEW.common.tryAgain }));

    expect(await screen.findByLabelText(CUSTOMER_VIEW.hub.orgLabel)).toBeInTheDocument();
  });

  it('says so when there are no orgs', async () => {
    startFakeGateway({ directory: () => ({ organizations: [] }) });
    renderAt(routes.adminCustomers(), <AdminCustomerHubPage />);
    expect(await screen.findByText(CUSTOMER_VIEW.hub.empty)).toBeInTheDocument();
  });

  it('shows the name as text, not a dropdown, for exactly one org', async () => {
    startFakeGateway({ directory: () => ({ organizations: [ORG_A] }) });
    renderAt(routes.adminCustomers(), <AdminCustomerHubPage />);
    expect(await screen.findByText(ORG_A.name)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Billing/ })).toHaveAttribute('href', routes.adminCustomerBilling(ORG_A.id));
  });

  it('lists the five cards in order, linking the four screens to the selected org', async () => {
    startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomers(ORG_B.id), <AdminCustomerHubPage />);
    await screen.findByLabelText(CUSTOMER_VIEW.hub.orgLabel);

    const nav = screen.getByRole('navigation');
    const cards = within(nav).getAllByText(/^(Billing|Usage|Quota|Entitlements|Observability)$/).map((el) => el.textContent);
    expect(cards).toEqual(['Billing', 'Usage', 'Quota', 'Entitlements', 'Observability']);
    expect(screen.getByRole('link', { name: /^Billing/ })).toHaveAttribute('href', routes.adminCustomerBilling(ORG_B.id));
    expect(screen.getByRole('link', { name: /^Usage/ })).toHaveAttribute('href', routes.adminCustomerUsage(ORG_B.id));
    expect(screen.getByRole('link', { name: /^Quota/ })).toHaveAttribute('href', routes.adminCustomerQuota(ORG_B.id));
    expect(screen.getByRole('link', { name: /^Entitlements/ })).toHaveAttribute('href', routes.adminCustomerEntitlements(ORG_B.id));
    expect(within(nav).getByText(CUSTOMER_VIEW.hub.cards.observability.description)).toBeInTheDocument();
  });

  it('reselects the org named in the URL on return, and falls back to the first when it is gone', async () => {
    startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomers(ORG_B.id), <AdminCustomerHubPage />);
    expect(await screen.findByLabelText(CUSTOMER_VIEW.hub.orgLabel)).toHaveValue(ORG_B.id);
    cleanup();

    startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomers('c0000000-0000-4000-8000-00000000000c'), <AdminCustomerHubPage />);
    expect(await screen.findByLabelText(CUSTOMER_VIEW.hub.orgLabel)).toHaveValue(ORG_A.id);
  });

  it('choosing an org changes the URL and the cards, and never calls the org switch', async () => {
    const gateway = startFakeGateway(ALL_FIXTURES);
    const location = renderAt(routes.adminCustomers(), <AdminCustomerHubPage />);
    const select = await screen.findByLabelText(CUSTOMER_VIEW.hub.orgLabel);

    fireEvent.change(select, { target: { value: ORG_B.id } });

    expect(currentPath(location)).toBe(routes.adminCustomers(ORG_B.id));
    expect(screen.getByRole('link', { name: /^Billing/ })).toHaveAttribute('href', routes.adminCustomerBilling(ORG_B.id));
    expect(gateway.switchRequests()).toEqual([]);
  });

  it('Observability opens this app in the selected org through the org switch', async () => {
    const gateway = startFakeGateway(ALL_FIXTURES);
    const location = renderAt(routes.adminCustomers(ORG_A.id), <AdminCustomerHubPage />);
    await screen.findByLabelText(CUSTOMER_VIEW.hub.orgLabel);

    fireEvent.click(screen.getByRole('button', { name: /^Observability/ }));

    await waitFor(() => { expect(currentPath(location)).toBe('/'); });
    expect(gateway.switchRequests()).toHaveLength(1);
    expect(gateway.switchRequests()[0]!.headers['X-Org-Id']).toBe(ORG_A.id);
  });
});

describe('AdminCustomerBillingPage (ADMIN-CV-BILLING)', () => {
  it.each([
    ['active', 'Active', 'success'],
    ['past_due', 'Past Due', 'warning'],
    ['inactive', 'Inactive', 'error'],
    ['canceled', 'Inactive', 'error'],
    ['trialing', 'Inactive', 'error'],
  ])('badges billing_status %s as %s / %s', async (status, label, tone) => {
    startFakeGateway({ ...ALL_FIXTURES, billing: () => ({ ...BILLING_ACTIVE, billing_status: status }) });
    renderAt(routes.adminCustomerBilling(ORG_A.id), <AdminCustomerBillingPage orgId={ORG_A.id} />);
    const badge = await screen.findByText(label);
    expect(badge).toHaveAttribute('data-tone', tone);
  });

  it('shows the plan row, "Renews on: —" and the Manage Billing label for an org with a billing account', async () => {
    const gateway = startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomerBilling(ORG_A.id), <AdminCustomerBillingPage orgId={ORG_A.id} />);

    expect(await screen.findByText('growth')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: CUSTOMER_VIEW.billing.defaultCardTitle })).toBeInTheDocument();
    expect(screen.getByText(`${CUSTOMER_VIEW.billing.renewsRow}:`).parentElement).toHaveTextContent(CUSTOMER_VIEW.common.dash);
    expect(screen.getByText(CUSTOMER_VIEW.billing.manageBilling)).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(CUSTOMER_VIEW.billing.noAccountNote)).not.toBeInTheDocument();
    // Read-only: the customer's CTA endpoints are never called.
    expect(gateway.requests.map((r) => r.path)).not.toContainEqual(expect.stringMatching(/billing-portal|checkout-session/));
  });

  it('shows the no-account note and the Choose a plan label without a billing account', async () => {
    startFakeGateway({ ...ALL_FIXTURES, billing: () => ({ ...BILLING_ACTIVE, has_billing_account: false }) });
    renderAt(routes.adminCustomerBilling(ORG_A.id), <AdminCustomerBillingPage orgId={ORG_A.id} />);
    expect(await screen.findByText(CUSTOMER_VIEW.billing.noAccountNote)).toBeInTheDocument();
    expect(screen.getByText(CUSTOMER_VIEW.billing.choosePlan)).toBeInTheDocument();
  });

  it('shows the contract note and no label for an enterprise org without a billing account', async () => {
    startFakeGateway({ ...ALL_FIXTURES, billing: () => ({ ...BILLING_ACTIVE, current_plan: 'enterprise', has_billing_account: false }) });
    renderAt(routes.adminCustomerBilling(ORG_A.id), <AdminCustomerBillingPage orgId={ORG_A.id} />);
    expect(await screen.findByText(CUSTOMER_VIEW.billing.contractNote)).toBeInTheDocument();
    expect(screen.queryByText(CUSTOMER_VIEW.billing.choosePlan)).not.toBeInTheDocument();
    expect(screen.queryByText(CUSTOMER_VIEW.billing.manageBilling)).not.toBeInTheDocument();
  });

  it('uses the display name, Cancels on and the formatted date when the gateway sends them', async () => {
    startFakeGateway({
      ...ALL_FIXTURES,
      billing: () => ({ ...BILLING_ACTIVE, plan_display_name: 'Growth', cancel_at_period_end: true, current_period_end: '2026-11-15T12:00:00Z' }),
    });
    renderAt(routes.adminCustomerBilling(ORG_A.id), <AdminCustomerBillingPage orgId={ORG_A.id} />);
    expect(await screen.findByRole('heading', { name: 'Growth' })).toBeInTheDocument();
    expect(screen.getByText(`${CUSTOMER_VIEW.billing.cancelsRow}:`).parentElement).toHaveTextContent('November 15, 2026');
  });

  it('shows the org name and id in the header, and a back link to the hub with the org selected', async () => {
    startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomerBilling(ORG_B.id), <AdminCustomerBillingPage orgId={ORG_B.id} />);
    expect(await screen.findByText(ORG_B.name)).toBeInTheDocument();
    expect(screen.getByText(`${ADMIN_VIEW.orgIdLabel}: ${ORG_B.id}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: new RegExp(ADMIN_VIEW.backToHub) })).toHaveAttribute('href', routes.adminCustomers(ORG_B.id));
  });

  it('replaces the card with the error and Try again on a failure', async () => {
    const gateway = startFakeGateway(ALL_FIXTURES);
    gateway.control.refuse = { status: HTTP_FORBIDDEN };
    gateway.control.refuseRoute = 'billing';
    renderAt(routes.adminCustomerBilling(ORG_A.id), <AdminCustomerBillingPage orgId={ORG_A.id} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(CUSTOMER_VIEW.errors.forbidden);
    gateway.control.refuse = null;
    fireEvent.click(screen.getByRole('button', { name: CUSTOMER_VIEW.common.tryAgain }));

    expect(await screen.findByText('growth')).toBeInTheDocument();
  });
});

describe('AdminCustomerUsagePage (ADMIN-CV-USAGE)', () => {
  it('renders the period, the quota-backed total, the chart and the per-metric table', async () => {
    startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomerUsage(ORG_A.id), <AdminCustomerUsagePage orgId={ORG_A.id} />);

    expect(await screen.findByText(CUSTOMER_VIEW.usage.since('2026-10-01'))).toBeInTheDocument();
    // The bar reads the enforced quota, not the bucket total, once the quota has a plan.
    expect(await screen.findByText(CUSTOMER_VIEW.usage.unitsOfLimit(12345, 500000))).toBeInTheDocument();
    expect(screen.getByText(CUSTOMER_VIEW.usage.percentUsed(2))).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /Monthly usage/ })).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText(/^Resets /)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Daily usage/ })).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual(['Otel Spans3003', 'Requests15015']);
    expect(screen.getByRole('heading', { name: CUSTOMER_VIEW.usage.title })).toBeInTheDocument();
    expect(screen.getAllByText(ORG_A.name).length).toBeGreaterThan(0);
  });

  it('shows the bucket total alone when the quota is uninitialized, with no chart line or bar', async () => {
    startFakeGateway({ ...ALL_FIXTURES, quota: () => QUOTA_UNINITIALIZED });
    renderAt(routes.adminCustomerUsage(ORG_A.id), <AdminCustomerUsagePage orgId={ORG_A.id} />);

    expect(await screen.findByText(CUSTOMER_VIEW.usage.units(450))).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Resets /)).not.toBeInTheDocument();
  });

  it.each([
    [375000, 'warning', CUSTOMER_VIEW.usage.approachingAlertTitle],
    [450000, 'warning', CUSTOMER_VIEW.usage.approachingAlertTitle],
    [500000, 'critical', CUSTOMER_VIEW.usage.reachedAlertTitle],
  ])('at %i of 500000 raises a %s alert: %s', async (monthlyUsed, status, title) => {
    startFakeGateway({ ...ALL_FIXTURES, quota: () => ({ ...QUOTA_GROWTH, monthlyUsed }) });
    renderAt(routes.adminCustomerUsage(ORG_A.id), <AdminCustomerUsagePage orgId={ORG_A.id} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-status', status);
    expect(alert).toHaveTextContent(title);
  });

  it('says "Unlimited plan" for a null monthly limit', async () => {
    startFakeGateway({ ...ALL_FIXTURES, quota: () => ({ ...QUOTA_GROWTH, monthlyLimit: null }) });
    renderAt(routes.adminCustomerUsage(ORG_A.id), <AdminCustomerUsagePage orgId={ORG_A.id} />);
    expect(await screen.findByText(CUSTOMER_VIEW.usage.unlimitedPlan)).toBeInTheDocument();
    expect(screen.getByText(CUSTOMER_VIEW.usage.units(12345))).toBeInTheDocument();
  });

  it('shows "0 units" and neither chart nor table for a month with no buckets', async () => {
    startFakeGateway({ ...ALL_FIXTURES, usage: () => USAGE_EMPTY, quota: () => QUOTA_UNINITIALIZED });
    renderAt(routes.adminCustomerUsage(ORG_A.id), <AdminCustomerUsagePage orgId={ORG_A.id} />);
    expect(await screen.findByText(CUSTOMER_VIEW.usage.units(0))).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(CUSTOMER_VIEW.usage.empty)).not.toBeInTheDocument();
  });

  it('keeps the data on screen when a later poll fails, and shows the error only on a first-load failure', async () => {
    const gateway = startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomerUsage(ORG_A.id), <AdminCustomerUsagePage orgId={ORG_A.id} />);
    await screen.findByText(CUSTOMER_VIEW.usage.since('2026-10-01'));

    gateway.control.refuse = { status: HTTP_FORBIDDEN };
    gateway.control.refuseRoute = 'usage';
    fireEvent.click(screen.getByRole('button', { name: CUSTOMER_VIEW.common.refresh }));
    await waitFor(() => { expect(gateway.requestsFor('usage').length).toBeGreaterThan(1); });

    expect(screen.getByText(CUSTOMER_VIEW.usage.since('2026-10-01'))).toBeInTheDocument();
    expect(screen.queryByText(CUSTOMER_VIEW.errors.forbidden)).not.toBeInTheDocument();
    cleanup();

    const failing = startFakeGateway(ALL_FIXTURES);
    failing.control.refuse = { status: HTTP_FORBIDDEN };
    failing.control.refuseRoute = 'usage';
    renderAt(routes.adminCustomerUsage(ORG_A.id), <AdminCustomerUsagePage orgId={ORG_A.id} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(CUSTOMER_VIEW.errors.forbidden);
  });
});

describe('AdminCustomerQuotaPage (ADMIN-CV-QUOTA)', () => {
  it('renders the plan badge and both rows with bars for an initialized quota', async () => {
    startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomerQuota(ORG_A.id), <AdminCustomerQuotaPage orgId={ORG_A.id} />);

    expect(await screen.findByText('Growth')).toHaveAttribute('data-tone', 'info');
    expect(screen.getByText(`${CUSTOMER_VIEW.quota.minute}:`).parentElement).toHaveTextContent(CUSTOMER_VIEW.quota.usedOfLimit(5, 60));
    expect(screen.getByText(`${CUSTOMER_VIEW.quota.monthly}:`).parentElement).toHaveTextContent(CUSTOMER_VIEW.quota.usedOfLimit(12345, 500000));
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    expect(screen.queryByText(ADMIN_VIEW.quotaUninitialized)).not.toBeInTheDocument();
  });

  it('says "(Unlimited)" with no monthly bar for a null monthly limit', async () => {
    startFakeGateway({ ...ALL_FIXTURES, quota: () => ({ ...QUOTA_GROWTH, monthlyLimit: null }) });
    renderAt(routes.adminCustomerQuota(ORG_A.id), <AdminCustomerQuotaPage orgId={ORG_A.id} />);
    expect(await screen.findByText(`${CUSTOMER_VIEW.quota.monthly}:`)).toBeInTheDocument();
    expect(screen.getByText(`${CUSTOMER_VIEW.quota.monthly}:`).parentElement).toHaveTextContent(CUSTOMER_VIEW.quota.unlimited(12345));
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it.each([
    [74, 'normal'],
    [75, 'warning'],
    [89, 'warning'],
    [90, 'danger'],
  ])('colours the minute bar at %i of 100 as %s', async (minuteUsed, tone) => {
    startFakeGateway({ ...ALL_FIXTURES, quota: () => ({ ...QUOTA_GROWTH, minuteLimit: 100, minuteUsed }) });
    renderAt(routes.adminCustomerQuota(ORG_A.id), <AdminCustomerQuotaPage orgId={ORG_A.id} />);
    const bar = await screen.findByRole('progressbar', { name: /Minute/ });
    expect(bar).toHaveAttribute('data-tone', tone);
    expect(bar).toHaveAttribute('aria-valuenow', String(minuteUsed));
  });

  it('renders the uninitialized answer as the customer sees it, plus the admin note', async () => {
    startFakeGateway({ ...ALL_FIXTURES, quota: () => QUOTA_UNINITIALIZED });
    renderAt(routes.adminCustomerQuota(ORG_A.id), <AdminCustomerQuotaPage orgId={ORG_A.id} />);

    expect(await screen.findByText(ADMIN_VIEW.quotaUninitialized)).toBeInTheDocument();
    expect(screen.getByText(`${CUSTOMER_VIEW.quota.minute}:`).parentElement).toHaveTextContent(CUSTOMER_VIEW.quota.usedOfLimit(0, 0));
    expect(screen.getByText(`${CUSTOMER_VIEW.quota.monthly}:`).parentElement).toHaveTextContent(CUSTOMER_VIEW.quota.unlimited(0));
    expect(screen.queryByText('Growth')).not.toBeInTheDocument();
    // A limit of 0 draws an empty bar.
    expect(screen.getByRole('progressbar', { name: /Minute/ })).toHaveAttribute('aria-valuenow', '0');
  });
});

describe('AdminCustomerEntitlementsPage (ADMIN-CV-ENTITLEMENTS)', () => {
  it('renders every value type, sorted by key and Title Cased', async () => {
    startFakeGateway(ALL_FIXTURES);
    renderAt(routes.adminCustomerEntitlements(ORG_A.id), <AdminCustomerEntitlementsPage orgId={ORG_A.id} />);

    await screen.findByRole('table');
    const rows = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual(['AlertsDisabled', 'Concurrent JobsN/A', 'Monthly Units500000', 'Usage DashboardEnabled']);
    expect(screen.getByText(CUSTOMER_VIEW.entitlements.enabled)).toHaveAttribute('data-tone', 'success');
    expect(screen.getByText(CUSTOMER_VIEW.entitlements.disabled)).toHaveAttribute('data-tone', 'muted');
  });

  it('says so for an empty map', async () => {
    startFakeGateway({ ...ALL_FIXTURES, entitlements: () => ENTITLEMENTS_EMPTY });
    renderAt(routes.adminCustomerEntitlements(ORG_A.id), <AdminCustomerEntitlementsPage orgId={ORG_A.id} />);
    expect(await screen.findByText(CUSTOMER_VIEW.entitlements.empty)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
