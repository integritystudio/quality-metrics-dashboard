/**
 * The admin customer hooks against the real `useQuery` + `fetch` path, with `useAuth`
 * substituted (ADMIN-CV-API-CLIENT). What is pinned: the request goes to api-gateway with
 * `Authorization` only — no `X-Org-Id`, even under an active org — and each failure maps to
 * `DashboardService`'s message, with retries only where it retries.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { OrgProvider } from '../contexts/OrgContext.js';
import {
  ADMIN_CUSTOMER_QUERY_SCOPE,
  useAdminBillingStatus,
  useAdminEntitlements,
  useAdminOrgDirectory,
  useAdminQuotaStatus,
  useAdminUsageQuota,
  useAdminUsageSummary,
} from '../hooks/useAdminCustomer.js';
import { API_GATEWAY_URL, GatewayError, gatewayErrorForStatus, isRetryableGatewayError, isSafeOrgId } from '../lib/gateway.js';
import { CUSTOMER_VIEW } from '../lib/admin-customer-strings.js';
import { GATEWAY_MAX_RETRIES, USAGE_POLL_INTERVAL_MS } from '../lib/admin-customer-constants.js';
import { ORG_ID_HEADER } from '../lib/worker-contract.js';
import type { AppSession } from '../types/auth.js';
import { TEST_ACCESS_TOKEN, makeQueryWrapper } from './support/query-harness.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { BILLING_ACTIVE, ORG_A, ORG_B, QUOTA_GROWTH, QUOTA_UNINITIALIZED, USAGE_SUMMARY } from './support/admin-customer-fixtures.js';

/** A staff session with an active org, so the X-Org-Id choke point has a value it could send. */
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

const getAccessToken = vi.fn(() => Promise.resolve(TEST_ACCESS_TOKEN));

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ session: STAFF_SESSION, isLoading: false, getAccessToken }),
}));

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const HTTP_GATEWAY_TIMEOUT = 504;
const RETRY_WAIT_MS = 6_000;

function makeWrapper() {
  const { wrapper: QueryWrapper, queryClient } = makeQueryWrapper();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper><OrgProvider>{children}</OrgProvider></QueryWrapper>;
  }
  return { wrapper: Wrapper, queryClient };
}

afterEach(() => {
  vi.unstubAllGlobals();
  getAccessToken.mockClear();
});

describe('what the hooks send', () => {
  it('reads the directory from api-gateway with the bearer token and no X-Org-Id', async () => {
    const gateway = startFakeGateway({ directory: () => ({ organizations: [ORG_A, ORG_B] }) });

    const { result } = renderHook(() => useAdminOrgDirectory(), makeWrapper());
    await waitFor(() => { expect(result.current.data).toBeDefined(); });

    expect(result.current.data?.map((o) => o.name)).toEqual(['Acme', 'Beta Labs']);
    const [request] = gateway.gatewayRequests();
    expect(request).toMatchObject({ method: 'GET', url: `${API_GATEWAY_URL}/v1/admin/orgs` });
    expect(request!.headers).toEqual({ Authorization: `Bearer ${TEST_ACCESS_TOKEN}` });
    expect(request!.headers).not.toHaveProperty(ORG_ID_HEADER);
  });

  it.each([
    ['billing', (id: string) => useAdminBillingStatus(id), `/v1/admin/orgs/${ORG_A.id}/billing-status`],
    ['usage', (id: string) => useAdminUsageSummary(id), `/v1/admin/orgs/${ORG_A.id}/usage/summary`],
    ['quota', (id: string) => useAdminQuotaStatus(id), `/v1/admin/orgs/${ORG_A.id}/quota/status`],
    ['entitlements', (id: string) => useAdminEntitlements(id), `/v1/admin/orgs/${ORG_A.id}/entitlements`],
  ])('%s: puts the viewed org in the path, not in a header', async (_name, useHook, path) => {
    const gateway = startFakeGateway({
      billing: () => BILLING_ACTIVE,
      usage: () => USAGE_SUMMARY,
      quota: () => QUOTA_GROWTH,
      entitlements: () => ({ org_id: ORG_A.id, entitlements: {} }),
    });

    const { result } = renderHook(() => useHook(ORG_A.id), makeWrapper());
    await waitFor(() => { expect(result.current.data).toBeDefined(); });

    const [request] = gateway.gatewayRequests();
    expect(request!.url).toBe(`${API_GATEWAY_URL}${path}`);
    expect(request!.headers).toEqual({ Authorization: `Bearer ${TEST_ACCESS_TOKEN}` });
  });

  it('keys the queries under their own scope, apart from the org-scoped ones', async () => {
    startFakeGateway({ billing: () => BILLING_ACTIVE });
    const { wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(() => useAdminBillingStatus(ORG_A.id), { wrapper });
    await waitFor(() => { expect(result.current.data).toBeDefined(); });

    const keys = queryClient.getQueryCache().findAll().map((q) => q.queryKey);
    expect(keys).toEqual([[ADMIN_CUSTOMER_QUERY_SCOPE, ORG_A.id, 'billing']]);
  });

  it('polls the usage summary every 30 s', async () => {
    startFakeGateway({ usage: () => USAGE_SUMMARY });
    const { wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(() => useAdminUsageSummary(ORG_A.id), { wrapper });
    await waitFor(() => { expect(result.current.data).toBeDefined(); });

    // The interval is an observer option, not a query option.
    const [query] = queryClient.getQueryCache().findAll();
    const [observer] = query!.observers;
    expect(observer!.options.refetchInterval).toBe(USAGE_POLL_INTERVAL_MS);
    expect(USAGE_POLL_INTERVAL_MS).toBe(30_000);
  });
});

describe('what the client refuses to send', () => {
  it.each(['a/b', 'a?b', 'a#b', 'a%2Fb', ''])('an org id of %j, as DashboardService does', async (orgId) => {
    const gateway = startFakeGateway({});
    expect(isSafeOrgId(orgId)).toBe(false);

    const { result } = renderHook(() => useAdminBillingStatus(orgId), makeWrapper());
    await waitFor(() => { expect(result.current.error).not.toBeNull(); });

    expect(result.current.error?.message).toBe(CUSTOMER_VIEW.errors.unexpected);
    expect(gateway.gatewayRequests()).toEqual([]);
  });
});

describe('error wording (DashboardService)', () => {
  it.each([
    [HTTP_UNAUTHORIZED, CUSTOMER_VIEW.errors.auth],
    [HTTP_FORBIDDEN, CUSTOMER_VIEW.errors.forbidden],
    [HTTP_NOT_FOUND, CUSTOMER_VIEW.errors.unexpected],
  ])('a %i is reported once, without a retry', async (status, message) => {
    const gateway = startFakeGateway({});
    gateway.control.refuse = { status };

    const { result } = renderHook(() => useAdminBillingStatus(ORG_A.id), makeWrapper());
    await waitFor(() => { expect(result.current.error).not.toBeNull(); });

    expect(result.current.error).toBeInstanceOf(GatewayError);
    expect(result.current.error?.message).toBe(message);
    expect(gateway.gatewayRequests()).toHaveLength(1);
  });

  it('a network failure is reported as one', async () => {
    const gateway = startFakeGateway({});
    gateway.control.refuse = 'network-error';

    const { result } = renderHook(() => useAdminBillingStatus(ORG_A.id), makeWrapper());
    await waitFor(() => { expect(result.current.error).not.toBeNull(); }, { timeout: RETRY_WAIT_MS });

    expect(result.current.error?.message).toBe(CUSTOMER_VIEW.errors.network);
  });

  it('a missing token is an authentication error, and nothing is sent', async () => {
    const gateway = startFakeGateway({});
    getAccessToken.mockRejectedValueOnce(new Error('login_required'));

    const { result } = renderHook(() => useAdminBillingStatus(ORG_A.id), makeWrapper());
    await waitFor(() => { expect(result.current.error).not.toBeNull(); });

    expect(result.current.error?.message).toBe(CUSTOMER_VIEW.errors.auth);
    expect(gateway.gatewayRequests()).toEqual([]);
  });

  it('a 500 is retried twice, then reported as a server error', async () => {
    const gateway = startFakeGateway({});
    gateway.control.refuse = { status: HTTP_SERVER_ERROR };

    const { result } = renderHook(() => useAdminBillingStatus(ORG_A.id), makeWrapper());
    await waitFor(() => { expect(result.current.error).not.toBeNull(); }, { timeout: RETRY_WAIT_MS });

    expect(result.current.error?.message).toBe(CUSTOMER_VIEW.errors.server);
    expect(gateway.gatewayRequests()).toHaveLength(GATEWAY_MAX_RETRIES + 1);
  }, RETRY_WAIT_MS);

  it('classifies 500 and 504 as retried server errors and 401/403/404 as final', () => {
    expect(isRetryableGatewayError(gatewayErrorForStatus(HTTP_SERVER_ERROR))).toBe(true);
    expect(isRetryableGatewayError(gatewayErrorForStatus(HTTP_GATEWAY_TIMEOUT))).toBe(true);
    expect(isRetryableGatewayError(gatewayErrorForStatus(HTTP_UNAUTHORIZED))).toBe(false);
    expect(isRetryableGatewayError(gatewayErrorForStatus(HTTP_FORBIDDEN))).toBe(false);
    expect(isRetryableGatewayError(gatewayErrorForStatus(HTTP_NOT_FOUND))).toBe(false);
    expect(isRetryableGatewayError(new GatewayError('network'))).toBe(true);
    expect(isRetryableGatewayError(new GatewayError('timeout'))).toBe(true);
    expect(isRetryableGatewayError(new Error('other'))).toBe(false);
  });

  it('reads a 200 that is not JSON as the Dart defaults', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>', { status: 200 }))));

    const { result } = renderHook(() => useAdminBillingStatus(ORG_A.id), makeWrapper());
    await waitFor(() => { expect(result.current.data).toBeDefined(); });

    expect(result.current.data).toMatchObject({ planKey: '', billingStatus: 'inactive', hasBillingAccount: false });
  });
});

describe('the Usage page quota reader', () => {
  it('refuses an uninitialized quota, keeping the last accepted one', async () => {
    let answer: unknown = QUOTA_GROWTH;
    startFakeGateway({ quota: () => answer });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAdminUsageQuota(ORG_A.id), { wrapper });
    await waitFor(() => { expect(result.current.data?.planKey).toBe('growth'); });

    answer = QUOTA_UNINITIALIZED;
    // The refetch's own result is read rather than `result.current.isError`: react-query
    // re-renders only for properties a render has read, and nothing read `isError` yet.
    const refetched = await result.current.refetch();

    expect(refetched.status).toBe('error');
    expect(refetched.error?.message).toBe(CUSTOMER_VIEW.errors.unexpected);
    expect(refetched.data?.planKey).toBe('growth');
    expect(result.current.data?.planKey).toBe('growth');
  });

  it('while the Quota page reader takes the uninitialized answer as data', async () => {
    startFakeGateway({ quota: () => QUOTA_UNINITIALIZED });

    const { result } = renderHook(() => useAdminQuotaStatus(ORG_A.id), makeWrapper());
    await waitFor(() => { expect(result.current.data).toBeDefined(); });

    expect(result.current.data?.uninitialized).toBe(true);
  });
});
