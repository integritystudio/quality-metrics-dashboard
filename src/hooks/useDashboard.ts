import { useQuery } from '@tanstack/react-query';
import type { QualityDashboardSummary, RoleView, RoleViewType, Period } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

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
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: 3,
    retryDelay: (i) => Math.min(1000 * 2 ** i, 30_000),
  });
}
