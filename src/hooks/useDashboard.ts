import type { QualityDashboardSummary, RoleView, RoleViewType, Period } from '../types.js';
import { API_BASE, POLL_INTERVAL_MS, STALE_TIME, RETRY_DELAY_BASE, RETRY_DELAY_CAP } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

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
    },
  );
}
