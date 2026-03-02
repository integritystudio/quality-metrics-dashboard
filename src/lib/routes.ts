export const routes = {
  evaluationDetail: (traceId: string, metric?: string) =>
    metric
      ? `/evaluations/trace/${traceId}?metric=${encodeURIComponent(metric)}`
      : `/evaluations/trace/${traceId}`,
  session: (sessionId: string) => `/sessions/${sessionId}`,
  trace: (traceId: string) => `/traces/${traceId}`,
} as const;
