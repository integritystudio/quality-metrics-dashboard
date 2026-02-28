import { useQuery } from '@tanstack/react-query';
import type { Period, CoverageHeatmap } from '../types.js';
import { API_BASE } from '../lib/api.js';

export type CoverageResponse = CoverageHeatmap & { period: string };

export function useCoverage(period: Period, inputKey: 'traceId' | 'sessionId' = 'traceId') {
  return useQuery<CoverageResponse>({
    queryKey: ['coverage', period, inputKey],
    queryFn: async () => {
      const params = new URLSearchParams({ period, inputKey });
      const res = await fetch(`${API_BASE}/api/coverage?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 25_000,
    retry: 2,
  });
}
