import type { QualityDashboardSummary, RoleView, RoleViewType, Period } from '../types.js';
import { POLL_INTERVAL_MS, STALE_TIME, RETRY_DELAY_BASE, RETRY_DELAY_CAP } from '../lib/constants.js';
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

export function useDashboard(period: Period, role?: RoleViewType) {
  return useApiQuery<QualityDashboardSummary | RoleView>(
    ['dashboard', period, role],
    () => {
      const params = new URLSearchParams({ period });
      if (role) params.set('role', role);
      return `/api/dashboard?${params}`;
    },
    {
      refetchInterval: POLL_INTERVAL_MS,
      staleTime: STALE_TIME.DEFAULT,
      retry: 3,
      retryDelay: (i) => Math.min(RETRY_DELAY_BASE * 2 ** i, RETRY_DELAY_CAP),
      onNotFound: dashboardNotFound,
    },
  );
}
