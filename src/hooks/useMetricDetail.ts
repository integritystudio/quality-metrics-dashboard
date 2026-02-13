import { useQuery } from '@tanstack/react-query';
import type { MetricDetailResult } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export function useMetricDetail(name: string | undefined) {
  return useQuery<MetricDetailResult>({
    queryKey: ['metric', name],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/metrics/${name}?topN=5&bucketCount=10`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!name,
    staleTime: 25_000,
    retry: 2,
  });
}
