import type { Period } from '../types.js';
import { API_BASE } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export interface DegradationSignal {
  featureVersion: string;
  varianceTrend: 'increasing' | 'stable' | 'decreasing';
  varianceRatio: number;
  coverageDropoutRate: number;
  latencySkewRatio: number;
  predictedStatus: 'healthy' | 'warning' | 'critical';
  ewmaDriftDetected: boolean;
  consecutiveBreaches: number;
  confirmed: boolean;
}

export interface DegradationReport {
  metricName: string;
  signal: DegradationSignal;
}

export interface DegradationSignalsResponse {
  period: string;
  reports: DegradationReport[];
  computedAt: string | null;
}

export function useDegradationSignals(period: Period) {
  return useApiQuery<DegradationSignalsResponse>(
    ['degradation-signals', period],
    () => `${API_BASE}/api/degradation-signals?${new URLSearchParams({ period })}`,
  );
}
