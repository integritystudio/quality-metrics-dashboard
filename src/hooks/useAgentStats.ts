import type { Period } from '../types.js';
import type { AgentStat, EvalMetricSummary } from '../api/aggregates/agent-stats.js';
import { STALE_TIME, ErrorMessage } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export type { AgentStat, EvalMetricSummary };

/** The dev route and the synced KV value; the Worker answers null dates when no key is synced. */
interface AgentStatsResponse {
  period: string;
  startDate: string | null;
  endDate: string | null;
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
  return useApiQuery<unknown, AgentStatsResponse>(
    ['agent-stats', period],
    () => `/api/agents?period=${encodeURIComponent(period)}`,
    {
      staleTime: STALE_TIME.AGGREGATE,
      select: (raw) => { assertAgentStatsResponse(raw); return raw; },
    },
  );
}
