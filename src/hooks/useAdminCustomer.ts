/**
 * The admin customer view's queries (ADMIN-CV-API-CLIENT). Built on `useQuery` directly
 * rather than `useApiQuery`, which keys every query on the admin's active org and sends
 * `X-Org-Id`; neither applies to a cross-origin read of some other org.
 *
 * Errors carry `DashboardService`'s wording (`GatewayError`), and the retry policy is its
 * too: two retries on a server status or a transport failure, none on anything else.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ZodType } from 'zod';
import { useAuth } from '../contexts/AuthContext.js';
import { RETRY_DELAY_BASE, STALE_TIME } from '../lib/constants.js';
import { GATEWAY_MAX_RETRIES, GATEWAY_TIMEOUT_MS, USAGE_POLL_INTERVAL_MS } from '../lib/admin-customer-constants.js';
import {
  GatewayError,
  gatewayErrorForException,
  gatewayErrorForStatus,
  gatewayFetch,
  gatewayPaths,
  isRetryableGatewayError,
  withTimeout,
} from '../lib/gateway.js';
import {
  AdminOrgDirectorySchema,
  BillingStatusSchema,
  EntitlementsSchema,
  QuotaStatusSchema,
  UsageSummarySchema,
  type AdminOrgSummary,
  type BillingStatusData,
  type EntitlementsData,
  type QuotaStatusData,
  type UsageSummaryData,
} from '../lib/validation/admin-customer-schemas.js';

/** Leads every key here, so the admin reads never share a cache entry with the org-scoped queries. */
export const ADMIN_CUSTOMER_QUERY_SCOPE = 'admin-customer';

function gatewayRetry(failureCount: number, error: unknown): boolean {
  return isRetryableGatewayError(error) && failureCount < GATEWAY_MAX_RETRIES;
}

/** `DashboardService`'s backoff: 1 s, then 2 s. */
function gatewayRetryDelay(attempt: number): number {
  return RETRY_DELAY_BASE * 2 ** attempt;
}

interface GatewayQueryOptions<T> {
  refetchInterval?: number;
  refetchOnWindowFocus?: boolean;
  /**
   * A parsed answer this reader will not take. It fails the fetch instead, which leaves the
   * last accepted answer in place — how a poll keeps good data when a later answer is not.
   */
  accept?: (data: T) => boolean;
}

/**
 * One gateway read, parsed through `schema`. A null `path` is an org id the client refuses
 * to put in a URL: the query fails at once with the unexpected-error message, as
 * `DashboardService` does, and nothing is sent.
 */
function useGatewayQuery<T>(
  key: readonly unknown[],
  path: string | null,
  schema: ZodType<T>,
  options: GatewayQueryOptions<T> = {},
): UseQueryResult<T, GatewayError> {
  const { getAccessToken } = useAuth();
  return useQuery<T, GatewayError>({
    // The key names the reader as well as the org, so the Usage page's quota poll and the
    // Quota page's plain read never share an entry: they accept different answers.
    queryKey: [ADMIN_CUSTOMER_QUERY_SCOPE, ...key],
    queryFn: async ({ signal }) => {
      if (path === null) throw new GatewayError('unexpected');
      let token: string;
      try {
        token = await getAccessToken();
      } catch {
        throw new GatewayError('auth');
      }
      const timed = withTimeout(signal, GATEWAY_TIMEOUT_MS);
      let res: Response;
      try {
        res = await gatewayFetch(path, token, { signal: timed.signal });
      } catch (error) {
        throw gatewayErrorForException(error, timed.signal);
      } finally {
        timed.clear();
      }
      if (!res.ok) throw gatewayErrorForStatus(res.status);
      // A 200 that is not JSON reads as an empty map, which parses to the Dart defaults.
      const body: unknown = await res.json().catch(() => ({}));
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new GatewayError('unexpected');
      if (options.accept && !options.accept(parsed.data)) throw new GatewayError('unexpected');
      return parsed.data;
    },
    retry: gatewayRetry,
    retryDelay: gatewayRetryDelay,
    staleTime: STALE_TIME.DETAIL,
    refetchInterval: options.refetchInterval,
    refetchOnWindowFocus: options.refetchOnWindowFocus,
  });
}

/** `GET /v1/admin/orgs`: every org, for the hub. */
export function useAdminOrgDirectory(): UseQueryResult<AdminOrgSummary[], GatewayError> {
  return useGatewayQuery(['directory'], gatewayPaths.adminOrgs(), AdminOrgDirectorySchema);
}

export function useAdminBillingStatus(orgId: string): UseQueryResult<BillingStatusData, GatewayError> {
  return useGatewayQuery([orgId, 'billing'], gatewayPaths.adminBillingStatus(orgId), BillingStatusSchema);
}

/** Polls every 30 s and on focus, as the Flutter Usage page does on its timer and on resume. */
export function useAdminUsageSummary(orgId: string): UseQueryResult<UsageSummaryData, GatewayError> {
  return useGatewayQuery([orgId, 'usage'], gatewayPaths.adminUsageSummary(orgId), UsageSummarySchema, {
    refetchInterval: USAGE_POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
}

/** The Quota page's read: every answer, the uninitialized one included, since the page renders it. */
export function useAdminQuotaStatus(orgId: string): UseQueryResult<QuotaStatusData, GatewayError> {
  return useGatewayQuery([orgId, 'quota'], gatewayPaths.adminQuotaStatus(orgId), QuotaStatusSchema);
}

/** `_fetchQuota`'s rule: a quota with no plan would read as "no limit", so it is refused. */
const hasPlan = (quota: QuotaStatusData): boolean => quota.planKey !== null;

/**
 * The Usage page's quota: polled with the summary (`_refresh` fetches both), and an answer
 * without a plan — the Durable Object's uninitialized state — is treated as a failed poll,
 * so the last accepted quota stays on screen rather than reading as unlimited.
 */
export function useAdminUsageQuota(orgId: string): UseQueryResult<QuotaStatusData, GatewayError> {
  return useGatewayQuery([orgId, 'usage-quota'], gatewayPaths.adminQuotaStatus(orgId), QuotaStatusSchema, {
    refetchInterval: USAGE_POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    accept: hasPlan,
  });
}

export function useAdminEntitlements(orgId: string): UseQueryResult<EntitlementsData, GatewayError> {
  return useGatewayQuery([orgId, 'entitlements'], gatewayPaths.adminEntitlements(orgId), EntitlementsSchema);
}
