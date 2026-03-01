import { useQuery } from '@tanstack/react-query';
import type { MultiAgentEvaluation, EvaluationResult } from '../types.js';
import { API_BASE, STALE_TIME } from '../lib/constants.js';

interface AgentSessionResponse {
  sessionId: string;
  spans: Array<{
    traceId: string;
    spanId: string;
    name: string;
    durationMs?: number;
    status?: { code: number; message?: string };
    attributes?: Record<string, unknown>;
  }>;
  evaluation: MultiAgentEvaluation;
  evaluations: EvaluationResult[];
  agentMap: Record<string, string>;
}

export function useAgentSession(sessionId: string | undefined) {
  return useQuery<AgentSessionResponse>({
    queryKey: ['agent-session', sessionId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(sessionId!)}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!sessionId,
    staleTime: STALE_TIME.DETAIL,
    retry: 2,
  });
}
