import type { MetricDetailResult, Period } from '../types.js';
import { API_BASE, DEFAULT_TOP_N, DEFAULT_BUCKET_COUNT, DEFAULT_PERIOD_DETAIL } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export function useMetricDetail(name: string | undefined, period: Period = DEFAULT_PERIOD_DETAIL) {
  return useApiQuery<MetricDetailResult>(
    ['metric', name, period],
    () => `${API_BASE}/api/metrics/${name}?period=${period}&topN=${DEFAULT_TOP_N}&bucketCount=${DEFAULT_BUCKET_COUNT}`,
    { enabled: !!name },
  );
}
