import type { Period } from '../types.js';
import { API_BASE } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export interface RoutingTelemetrySummary {
  routedSpans: number;
  fallbackRate: number;
}

export interface RoutingTelemetryModelPairGroup {
  pair: string;
  requestedModel: string;
  actualModel: string;
  provider: string | null;
  count: number;
}

export interface RoutingTelemetryStrategyGroup {
  strategy: string;
  count: number;
  fallbackCount: number;
  fallbackRate: number;
}

export type RoutingTelemetryGroup = RoutingTelemetryModelPairGroup | RoutingTelemetryStrategyGroup;

export interface RoutingTelemetryResponse {
  period: string;
  totalSpansScanned: number;
  summary: RoutingTelemetrySummary;
  modelDistribution: Record<string, number>;
  providerDistribution: Record<string, number>;
  costSavings: number;
  routingLatency?: { p50: number; p99: number; source: 'classification_time' | 'span_duration' };
  groups: RoutingTelemetryGroup[];
}

export function useRoutingTelemetry(period: Period) {
  return useApiQuery<RoutingTelemetryResponse>(
    ['routing-telemetry', period],
    () => `${API_BASE}/api/routing-telemetry?${new URLSearchParams({ period })}`,
  );
}
