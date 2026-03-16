import type { PercentileDistribution } from '../lib/quality-utils.js';
import { API_BASE, STALE_TIME } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export interface CalibrationResponse {
  distributions: Record<string, PercentileDistribution>;
  sampleCounts: Record<string, number>;
  lastCalibrated: string;
}

export interface MetricCalibration {
  distribution: PercentileDistribution;
  sampleSize: number;
}

export function useCalibration() {
  return useApiQuery<CalibrationResponse>(
    ['calibration'],
    () => `${API_BASE}/api/calibration`,
    { staleTime: STALE_TIME.AGGREGATE, retry: 1 },
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
