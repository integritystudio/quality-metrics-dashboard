import type { UseQueryResult } from '@tanstack/react-query';
import type { Period } from '../types.js';
import type { TrendView } from '../api/aggregates/trend.js';
import { DEFAULT_TREND_BUCKETS } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

/** The Worker serves the synced `trend:<name>:<period>` key, which holds DEFAULT_TREND_BUCKETS buckets whatever `buckets` says. */
export function useTrend(metricName: string, period: Period, buckets: number = DEFAULT_TREND_BUCKETS): UseQueryResult<TrendView> {
  return useApiQuery<TrendView>(
    ['trend', metricName, period, buckets],
    () => `/api/trends/${encodeURIComponent(metricName)}?${new URLSearchParams({ period, buckets: String(buckets) })}`,
    { enabled: !!metricName },
  );
}
