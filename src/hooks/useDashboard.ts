import { useQuery } from '@tanstack/react-query';
import type { QualityDashboardSummary, RoleView, RoleViewType, Period } from '../types.js';
import { API_BASE, STALE_TIME, POLL_INTERVAL_MS, RETRY_DELAY_BASE, RETRY_DELAY_CAP } from '../lib/constants.js';

export function useDashboard(period: Period, role?: RoleViewType) {
  return useQuery<QualityDashboardSummary | RoleView>({
    queryKey: ['dashboard', period, role],
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      if (role) params.set('role', role);
      const res = await fetch(`${API_BASE}/api/dashboard?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: STALE_TIME.DEFAULT,
    retry: 3,
    retryDelay: (i) => Math.min(RETRY_DELAY_BASE * 2 ** i, RETRY_DELAY_CAP),
  });
}
