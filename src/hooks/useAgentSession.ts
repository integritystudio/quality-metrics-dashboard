import type { MultiAgentEvaluation, EvaluationResult } from '../types.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';
import { STALE_TIME } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export interface AgentSessionResponse {
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
  /** Null when the production worker serves a session key synced before graphs were precomputed. */
  graph: WorkflowGraph | null;
}

/** The workflow view's slice of a session: no spans, evaluations or agentMap. */
export type AgentWorkflowResponse = Pick<AgentSessionResponse, 'sessionId' | 'evaluation' | 'graph'>;

/**
 * The workflow view reads `/graph`, not the full session. A node click then
 * fetches the session page's payload cold, instead of sharing this cache entry.
 */
export function useAgentWorkflow(sessionId: string | undefined) {
  return useApiQuery<AgentWorkflowResponse>(
    ['agent-workflow', sessionId],
    () => {
      if (!sessionId) throw new Error('sessionId is required');
      return `/api/agents/${encodeURIComponent(sessionId)}/graph`;
    },
    { enabled: !!sessionId, staleTime: STALE_TIME.DETAIL },
  );
}

export function useAgentSession(sessionId: string | undefined) {
  return useApiQuery<AgentSessionResponse>(
    ['agent-session', sessionId],
    () => {
      if (!sessionId) throw new Error('sessionId is required');
      return `/api/agents/${encodeURIComponent(sessionId)}`;
    },
    { enabled: !!sessionId, staleTime: STALE_TIME.DETAIL },
  );
}
