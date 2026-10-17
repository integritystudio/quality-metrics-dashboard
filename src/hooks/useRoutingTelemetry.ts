import type { UseQueryResult } from '@tanstack/react-query';
import type { Period } from '../types.js';
import { useApiQuery } from './useApiQuery.js';

export type RoutingTelemetrySummary = {
  routedSpans: number;
  fallbackRate: number;
}

export type RoutingTelemetryModelPairGroup = {
  pair: string;
  requestedModel: string;
  actualModel: string;
  provider: string | null;
  count: number;
}

export type RoutingTelemetryStrategyGroup = {
  strategy: string;
  count: number;
  fallbackCount: number;
  fallbackRate: number;
}

export type RoutingTelemetryGroup = RoutingTelemetryModelPairGroup | RoutingTelemetryStrategyGroup;

export type RoutingTelemetryResponse = {
  period: string;
  totalSpansScanned: number;
  summary: RoutingTelemetrySummary;
  modelDistribution: Record<string, number>;
  providerDistribution: Record<string, number>;
  costSavings: number;
  routingLatency?: { p50: number; p99: number; source: 'classification_time' | 'span_duration' };
  groups: RoutingTelemetryGroup[];
}

export function useRoutingTelemetry(period: Period): UseQueryResult<RoutingTelemetryResponse> {
  return useApiQuery<RoutingTelemetryResponse>(
    ['routing-telemetry', period],
    () => `/api/routing-telemetry?${new URLSearchParams({ period })}`,
  );
}
