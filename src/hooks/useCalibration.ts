import type { PercentileDistribution } from '../lib/quality-utils.js';
import type { CalibrationResponse } from '../lib/validation/dashboard-schemas.js';
import { API_BASE, STALE_TIME, WORKER_ERR_NO_CALIBRATION_DATA } from '../lib/constants.js';
import { isWorkerNoData } from '../lib/api-client.js';
import { useApiQuery } from './useApiQuery.js';

export interface MetricCalibration {
  distribution: PercentileDistribution;
  sampleSize: number;
}

/**
 * The org's calibration, or `undefined` while loading or when none has been synced:
 * a new org has none, and the worker's 404 for that is no data, not an error.
 */
export function useCalibration() {
  return useApiQuery<CalibrationResponse | null, CalibrationResponse | undefined>(
    ['calibration'],
    () => `${API_BASE}/api/calibration`,
    {
      staleTime: STALE_TIME.AGGREGATE,
      retry: 1,
      onNotFound: (body) => (isWorkerNoData(body, WORKER_ERR_NO_CALIBRATION_DATA) ? null : undefined),
      select: (raw) => raw ?? undefined,
    },
  );
}

export function getMetricCalibration(
  data: CalibrationResponse | undefined,
  metricName: string,
): MetricCalibration | undefined {
  if (!data) return undefined;
  const distribution = data.distributions[metricName];
  const sampleSize = data.sampleCounts[metricName];
  if (!distribution || sampleSize == null) return undefined;
  return { distribution, sampleSize };
}
