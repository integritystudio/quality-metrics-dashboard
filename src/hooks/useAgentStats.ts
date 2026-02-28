import { useQuery } from '@tanstack/react-query';
import type { Period } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

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
  traceIds: string[];
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

export function useAgentStats(period: Period) {
  return useQuery<AgentStatsResponse>({
    queryKey: ['agent-stats', period],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/agents?period=${encodeURIComponent(period)}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    retry: 2,
  });
}
