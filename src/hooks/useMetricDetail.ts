import { useQuery } from '@tanstack/react-query';
import type { MetricDetailResult, Period } from '../types.js';
import { API_BASE, STALE_TIME, DEFAULT_TOP_N, DEFAULT_BUCKET_COUNT, DEFAULT_PERIOD_DETAIL } from '../lib/constants.js';

export function useMetricDetail(name: string | undefined, period: Period = DEFAULT_PERIOD_DETAIL) {
  return useQuery<MetricDetailResult>({
    queryKey: ['metric', name, period],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/metrics/${name}?period=${period}&topN=${DEFAULT_TOP_N}&bucketCount=${DEFAULT_BUCKET_COUNT}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!name,
    staleTime: STALE_TIME.DEFAULT,
    retry: 2,
  });
}
