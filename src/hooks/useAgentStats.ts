import type { Period } from '../types.js';
import { API_BASE, STALE_TIME, ErrorMessage } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export interface EvalMetricSummary {
  avg: number;
  min: number;
  max: number;
  count: number;
}

export interface AgentStat {
  agentName: string;
  invocations: number;
  errors: number;
  errorRate: number;
  rateLimitCount: number;
  avgOutputSize: number;
  sessionCount: number;
  sessionIds: string[];
  sessionIdsTruncated: boolean;
  traceIdsTotal?: number;
  traceIds: string[];
  traceIdsTruncated: boolean;
  sourceTypes: Record<string, number>;
  dailyCounts: number[];
  evalSummary: Record<string, EvalMetricSummary>;
}

interface AgentStatsResponse {
  period: string;
  startDate: string;
  endDate: string;
  agents: AgentStat[];
}

/** Shallow shape check — validates envelope fields only, not individual AgentStat elements. */
function assertAgentStatsResponse(data: unknown): asserts data is AgentStatsResponse {
  if (!data || typeof data !== 'object') throw new Error(ErrorMessage.InvalidResponseShape);
  const obj = data as Record<string, unknown>;
  if (typeof obj.period !== 'string' || !Array.isArray(obj.agents)) {
    throw new Error(ErrorMessage.MissingPeriodOrAgents);
  }
}

export function useAgentStats(period: Period) {
  return useApiQuery<AgentStatsResponse>(
    ['agent-stats', period],
    () => `${API_BASE}/api/agents?period=${encodeURIComponent(period)}`,
    {
      staleTime: STALE_TIME.AGGREGATE,
      select: (raw) => { assertAgentStatsResponse(raw); return raw; },
    },
  );
}
