import type { UseQueryResult } from '@tanstack/react-query';
import type { QualityDashboardSummary, RoleView, RoleViewType, Period } from '../types.js';
import { DATA_GATE_POLL_INTERVAL_MS, POLL_INTERVAL_MS, STALE_TIME } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';
import { isWorkerNoData, WORKER_ERR_NO_DATA } from '../lib/worker-contract.js';

/**
 * Return a minimal `QualityDashboardSummary` with `overallStatus: 'no_data'`
 * when the worker signals that the active org has no KV keys yet (404 +
 * `{ error: 'No data available' }`). Every other 404 returns `undefined` so
 * the caller falls through to the standard error path.
 */
function dashboardNotFound(body: unknown): QualityDashboardSummary | undefined {
  if (isWorkerNoData(body, WORKER_ERR_NO_DATA)) {
    return {
      overallStatus: 'no_data',
      metrics: [],
      alerts: [],
      summary: { totalMetrics: 0, healthyMetrics: 0, warningMetrics: 0, criticalMetrics: 0, noDataMetrics: 0 },
      timestamp: new Date().toISOString(),
    };
  }
  return undefined;
}

/** The `no_data` summary `dashboardNotFound` returns, for a role view too: there is no role payload to fake. */
export function isNoDataSummary(data: QualityDashboardSummary | RoleView): data is QualityDashboardSummary {
  return !('role' in data) && data.overallStatus === 'no_data';
}

export function useDashboard(
  period: Period,
  role?: RoleViewType,
  refetchInterval: number = POLL_INTERVAL_MS,
): UseQueryResult<QualityDashboardSummary | RoleView> {
  return useApiQuery<QualityDashboardSummary | RoleView>(
    ['dashboard', period, role],
    () => {
      const params = new URLSearchParams({ period });
      if (role) params.set('role', role);
      return `/api/dashboard?${params}`;
    },
    {
      refetchInterval,
      staleTime: STALE_TIME.DEFAULT,
      retry: 3,
      onNotFound: dashboardNotFound,
    },
  );
}

/**
 * Whether to offer `period`: false while its first check is loading and when the worker answers
 * no-data, true otherwise. A failed check offers it, so an outage never hides a period that has data.
 */
export function useOfferPeriod(period: Period): boolean {
  const { data, isError } = useDashboard(period, undefined, DATA_GATE_POLL_INTERVAL_MS);
  return isError || (data !== undefined && !isNoDataSummary(data));
}
