import { useQuery } from '@tanstack/react-query';
import type { MultiAgentEvaluation, EvaluationResult } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

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

export interface AgentStat {
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
  raw: string;
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

export interface SpanError {
  spanName: string;
  tool?: string;
  filePath?: string;
  statusMessage?: string;
}

export interface AlertSummary {
  totalFired: number;
  stopEvents: number;
}

export interface SessionDetailResponse {
  sessionId: string;
  sessionInfo: SessionInfo;
  spans: Array<{
    traceId: string;
    spanId: string;
    name: string;
    durationMs?: number;
    status?: { code: number; message?: string };
    attributes?: Record<string, unknown>;
  }>;
  toolUsage: Record<string, number>;
  mcpUsage: Record<string, number>;
  agentActivity: AgentStat[];
  fileAccess: FileAccessEntry[];
  gitCommits: GitCommit[];
  tokenProgression: TokenSnapshot[];
  spanBreakdown: Record<string, number>;
  alertSummary: AlertSummary;
  codeStructure: CodeStructureEntry[];
  errors: SpanError[];
  evaluation: MultiAgentEvaluation;
  evaluations: EvaluationResult[];
}

export function useSessionDetail(sessionId: string | undefined) {
  return useQuery<SessionDetailResponse>({
    queryKey: ['session-detail', sessionId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId!)}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    retry: 2,
  });
}
