import type { Period, MetricTrend, MetricDynamics } from '../types.js';
import { DEFAULT_TREND_BUCKETS } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

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
  narrowed?: boolean;
}

/** The Worker serves the synced `trend:<name>:<period>` key, which holds DEFAULT_TREND_BUCKETS buckets whatever `buckets` says. */
export function useTrend(metricName: string, period: Period, buckets: number = DEFAULT_TREND_BUCKETS) {
  return useApiQuery<TrendResponse>(
    ['trend', metricName, period, buckets],
    () => `/api/trends/${encodeURIComponent(metricName)}?${new URLSearchParams({ period, buckets: String(buckets) })}`,
    { enabled: !!metricName },
  );
}
