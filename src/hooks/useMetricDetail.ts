import { useQuery } from '@tanstack/react-query';
import type { MetricDetailResult, Period } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export function useMetricDetail(name: string | undefined, period: Period = '30d') {
  return useQuery<MetricDetailResult>({
    queryKey: ['metric', name, period],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/metrics/${name}?period=${period}&topN=5&bucketCount=10`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!name,
    staleTime: 25_000,
    retry: 2,
  });
}
