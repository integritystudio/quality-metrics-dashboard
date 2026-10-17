import type { UseQueryResult } from '@tanstack/react-query';
import type { MultiAgentEvaluation, EvaluationResult } from '../types.js';
// The shapes the API computes, imported rather than restated so the two cannot drift
// (type-only, so none of src/api's Node-only code reaches the bundle).
import type {
  AlertSummary,
  CodeStructureEntry,
  FileAccessEntry,
  GitCommit,
  SessionInfo,
  Timespan,
  TokenTotals,
} from '../api/session-detail.js';
import { STALE_TIME } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export type TokenSnapshot = {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  model: string;
}

export type SessionAgentStat = {
  agentName: string;
  invocations: number;
  errors: number;
  hasRateLimit: boolean;
  rateLimitEvents: number;
  totalOutputSize: number;
  avgOutputSize: number;
  avgDurationMs: number;
  truncatedCount: number;
  emptyCount: number;
}

/**
 * Deliberately NOT the API's `DataSources`: that type describes what the writer emits
 * (`truncated` present only when true), while this one describes what a reader may
 * receive. A payload can arrive with `truncated: false` from a producer that writes the
 * flag either way, which the writer-side union rejects — see the `is false` case in
 * SessionDetailPage.test.tsx. Keep the two separate.
 */
export type DataSources = {
  traces: {
    count: number;
    traceIds: number;
    /** As `evaluations.truncated`, for spans and every field derived from them. */
    truncated?: boolean;
  };
  logs: { count: number };
  evaluations: {
    count: number;
    /**
     * True when the session has more evaluations than `count`, so `evaluations`
     * and everything derived from it is a partial read. Optional because not
     * every producer of this payload sets it: the local API route always does,
     * while a `session:` key read from KV may predate the flag or come from a
     * writer that never sets it. Absent reads as not truncated.
     */
    truncated?: boolean;
  };
  total: number;
}

export type HookLatency = {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export type EvaluationBreakdownEntry = {
  name: string;
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

export type { AlertSummary, CodeStructureEntry, FileAccessEntry, GitCommit, SessionInfo, Timespan, TokenTotals };

export type SessionDetailResponse = {
  sessionId: string;
  dataSources: DataSources;
  timespan: Timespan | null;
  sessionInfo: SessionInfo | null;
  tokenTotals: TokenTotals;
  tokenProgression: TokenSnapshot[];
  toolUsage: Record<string, number>;
  mcpUsage: Record<string, number>;
  spanBreakdown: Record<string, number>;
  hookLatency: Record<string, HookLatency>;
  errors: {
    byCategory: Record<string, number>;
    details: Array<{
      spanName: string;
      tool?: string;
      errorType?: string;
      filePath?: string;
    }>;
  };
  agentActivity: SessionAgentStat[];
  fileAccess: FileAccessEntry[];
  gitCommits: GitCommit[];
  alertSummary: AlertSummary;
  codeStructure: CodeStructureEntry[];
  evaluationBreakdown: EvaluationBreakdownEntry[];
  logSummary: {
    bySeverity: Record<string, number>;
    logs: unknown[];
  };
  multiAgentEvaluation: MultiAgentEvaluation;
  evaluations: EvaluationResult[];
}

export function useSessionDetail(sessionId: string | undefined): UseQueryResult<SessionDetailResponse> {
  return useApiQuery<SessionDetailResponse>(
    ['session-detail', sessionId],
    () => `/api/sessions/${encodeURIComponent(sessionId ?? '')}`,
    {
      enabled: !!sessionId,
      staleTime: STALE_TIME.DETAIL,
      retry: (failureCount, error) =>
        error instanceof Error && error.message.startsWith('API error: 404')
          ? false
          : failureCount < 2,
    },
  );
}
