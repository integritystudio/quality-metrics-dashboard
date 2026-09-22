import type { QualityDashboardSummary, RoleView, RoleViewType, Period } from '../types.js';
import { API_BASE, POLL_INTERVAL_MS, STALE_TIME, RETRY_DELAY_BASE, RETRY_DELAY_CAP, WORKER_ERR_NO_DATA } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

/**
 * Return a minimal `QualityDashboardSummary` with `overallStatus: 'no_data'`
 * when the worker signals that the active org has no KV keys yet (404 +
 * `{ error: 'No data available' }`). Every other 404 returns `undefined` so
 * the caller falls through to the standard error path.
 */
function dashboardNotFound(body: unknown): QualityDashboardSummary | undefined {
  if (
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    (body as { error: unknown }).error === WORKER_ERR_NO_DATA
  ) {
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

export function useDashboard(period: Period, role?: RoleViewType) {
  return useApiQuery<QualityDashboardSummary | RoleView>(
    ['dashboard', period, role],
    () => {
      const params = new URLSearchParams({ period });
      if (role) params.set('role', role);
      return `${API_BASE}/api/dashboard?${params}`;
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
