import { useQuery } from '@tanstack/react-query';
import type { Period, MetricTrend, MetricDynamics } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

export interface PercentileSnapshot {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface TrendBucket {
  startTime: string;
  endTime: string;
  count: number;
  avg: number | null;
  percentiles: PercentileSnapshot | null;
  trend: MetricTrend | null;
  dynamics: MetricDynamics | null;
}

export interface TrendResponse {
  metric: string;
  period: string;
  bucketCount: number;
  totalEvaluations: number;
  overallPercentiles: PercentileSnapshot | null;
  trendData: TrendBucket[];
}

export function useTrend(metricName: string, period: Period, buckets = 7) {
  return useQuery<TrendResponse>({
    queryKey: ['trend', metricName, period, buckets],
    enabled: !!metricName,
    queryFn: async () => {
      const params = new URLSearchParams({ period, buckets: String(buckets) });
      const res = await fetch(`${API_BASE}/api/trends/${encodeURIComponent(metricName)}?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 25_000,
    retry: 2,
  });
}
