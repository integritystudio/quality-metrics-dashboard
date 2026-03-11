import type { MultiAgentEvaluation, EvaluationResult } from '../types.js';
import { API_BASE, STALE_TIME } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

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
  return useApiQuery<AgentSessionResponse>(
    ['agent-session', sessionId],
    () => `${API_BASE}/api/agents/${encodeURIComponent(sessionId ?? '')}`,
    { enabled: !!sessionId, staleTime: STALE_TIME.DETAIL },
  );
}
