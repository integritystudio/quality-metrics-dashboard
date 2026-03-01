import { useQuery } from '@tanstack/react-query';
import type { Period, CoverageHeatmap } from '../types.js';
import { API_BASE, STALE_TIME, DEFAULT_INPUT_KEY, type InputKey } from '../lib/constants.js';

export type CoverageResponse = CoverageHeatmap & { period: string };

export function useCoverage(period: Period, inputKey: InputKey = DEFAULT_INPUT_KEY) {
  return useQuery<CoverageResponse>({
    queryKey: ['coverage', period, inputKey],
    queryFn: async () => {
      const params = new URLSearchParams({ period, inputKey });
      const res = await fetch(`${API_BASE}/api/coverage?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: STALE_TIME.DEFAULT,
    retry: 2,
  });
}
