import type { MultiAgentEvaluation, EvaluationResult } from '../types.js';
import { API_BASE, STALE_TIME } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export interface SessionInfo {
  projectName: string;
  workingDirectory: string;
  gitRepository: string;
  gitBranch: string;
  nodeVersion: string;
  resumeCount: number;
  initialMessageCount: number;
  initialContextTokens: number;
  finalMessageCount: number;
  taskCount: number;
  uncommittedAtStart: number;
}

export interface TokenSnapshot {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  model: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  messages: number;
  models: Record<string, number>;
}

export interface SessionAgentStat {
  agentName: string;
  invocations: number;
  errors: number;
  hasRateLimit: boolean;
  avgOutputSize: number;
}

export interface FileAccessEntry {
  path: string;
  count: number;
}

export interface GitCommit {
  subject: string;
  body: string;
  files: string;
}

export interface CodeStructureEntry {
  file: string;
  lines: number;
  exports: number;
  functions: number;
  hasTypes: boolean;
  score: number;
  tool: string;
}

export interface AlertSummary {
  totalFired: number;
  stopEvents: number;
}

export interface DataSources {
  traces: { count: number; traceIds: number };
  logs: { count: number };
  evaluations: { count: number };
  total: number;
}

export interface Timespan {
  start: string;
  end: string;
  durationHours: number;
}

export interface HookLatency {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface EvaluationBreakdownEntry {
  name: string;
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

export interface SessionDetailResponse {
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

export function useSessionDetail(sessionId: string | undefined) {
  return useApiQuery<SessionDetailResponse>(
    ['session-detail', sessionId],
    () => `${API_BASE}/api/sessions/${encodeURIComponent(sessionId!)}`,
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
