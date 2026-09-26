export const routes = {
  agentSession: (sessionId: string, agentId?: string) =>
    agentId
      ? `/agents/${encodeURIComponent(sessionId)}?agent=${encodeURIComponent(agentId)}`
      : `/agents/${encodeURIComponent(sessionId)}`,
  evaluationDetail: (traceId: string, metric?: string) =>
    metric
      ? `/evaluations/trace/${traceId}?metric=${encodeURIComponent(metric)}`
      : `/evaluations/trace/${traceId}`,
  session: (sessionId: string) => `/sessions/${sessionId}`,
  trace: (traceId: string) => `/traces/${traceId}`,
  workflow: (sessionId: string) => `/workflows/${encodeURIComponent(sessionId)}`,
} as const;
