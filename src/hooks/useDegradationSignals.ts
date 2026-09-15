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
  /**
   * Nominal p-value for the drift test; null when no p-value is defined.
   * Optional because KV serves signals computed before this field existed —
   * absent until the next pipeline run overwrites them.
   */
  ewmaDriftPValue?: number | null;
  /**
   * Benjamini-Hochberg verdict across every metric queried together.
   * `false` means the drift is within what testing N metrics at once yields by
   * chance, so it did not escalate the status. `null` means uncorrected.
   */
  ewmaDriftFdrSignificant?: boolean | null;
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
