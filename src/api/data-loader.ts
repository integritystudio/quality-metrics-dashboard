import { MultiDirectoryBackend } from '../../../dist/backends/local-jsonl.js';
import type { EvaluationResult, TraceSpan } from '../../../dist/backends/index.js';
import { queryVerifications as queryVerificationsLib, type HumanVerificationEvent, type VerificationQueryOptions } from '../../../dist/lib/verification-events.js';
import { queryTraces as queryTracesTool } from '../../../dist/tools/query-traces.js';

let backend: MultiDirectoryBackend | undefined;

function getBackend(): MultiDirectoryBackend {
  if (!backend) {
    backend = new MultiDirectoryBackend(undefined, true);
  }
  return backend;
}

/** Convert ISO timestamp or date string to YYYY-MM-DD */
function toDateOnly(d: string): string {
  return d.split('T')[0];
}

export async function loadEvaluationsByMetric(
  start: string,
  end: string
): Promise<Map<string, EvaluationResult[]>> {
  const be = getBackend();
  const evals = await be.queryEvaluations({ startDate: start, endDate: end, limit: 100_000 });
  const grouped = new Map<string, EvaluationResult[]>();
  for (const ev of evals) {
    const name = ev.evaluationName;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name)!.push(ev);
  }
  return grouped;
}

export async function loadEvaluationsForMetric(
  metricName: string,
  start: string,
  end: string
): Promise<EvaluationResult[]> {
  const be = getBackend();
  return be.queryEvaluations({
    startDate: start,
    endDate: end,
    evaluationName: metricName,
    limit: 10000,
  });
}

export async function loadEvaluationsByTraceId(
  traceId: string,
  startDate?: string,
  endDate?: string,
): Promise<EvaluationResult[]> {
  const be = getBackend();
  const now = new Date();
  return be.queryEvaluations({
    traceId,
    startDate: startDate ?? new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    endDate: endDate ?? now.toISOString(),
    limit: 1000,
  });
}

export async function loadEvaluationsByTraceIds(
  traceIds: string[],
  startDate?: string,
  endDate?: string
): Promise<EvaluationResult[]> {
  if (traceIds.length === 0) return [];
  const be = getBackend();
  const now = new Date();
  const start = startDate ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const end = endDate ?? now.toISOString();
  const allEvals = await be.queryEvaluations({
    startDate: start,
    endDate: end,
    limit: 10000,
  });
  const idSet = new Set(traceIds);
  return allEvals.filter(e => e.traceId && idSet.has(e.traceId));
}

export async function loadTracesByTraceId(
  traceId: string,
  startDate?: string,
  endDate?: string,
) {
  const now = new Date();
  const start = startDate ? toDateOnly(startDate)
    : toDateOnly(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
  const end = endDate ? toDateOnly(endDate) : toDateOnly(now.toISOString());
  const result = await queryTracesTool({
    traceId,
    startDate: start,
    endDate: end,
    limit: 500,
  });
  return result.traces;
}

export async function loadTracesBySessionId(
  sessionId: string,
  startDate?: string,
  endDate?: string,
) {
  const now = new Date();
  const start = startDate ? toDateOnly(startDate)
    : toDateOnly(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
  const end = endDate ? toDateOnly(endDate) : toDateOnly(now.toISOString());
  const result = await queryTracesTool({
    attributeFilter: { 'session.id': sessionId },
    startDate: start,
    endDate: end,
    limit: 500,
  });
  return result.traces;
}

export async function loadLogsByTraceId(
  traceId: string,
  startDate?: string,
  endDate?: string,
): Promise<Awaited<ReturnType<MultiDirectoryBackend['queryLogs']>>> {
  const { queryLogs } = await import('../../../dist/tools/query-logs.js');
  const now = new Date();
  const start = startDate ? toDateOnly(startDate)
    : toDateOnly(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
  const end = endDate ? toDateOnly(endDate) : toDateOnly(now.toISOString());
  const result = await queryLogs({
    traceId,
    startDate: start,
    endDate: end,
    limit: 1000,
  });
  return result.logs;
}

export async function loadVerifications(opts: {
  startDate?: string;
  endDate?: string;
  sessionId?: string;
  limit?: number;
}): Promise<HumanVerificationEvent[]> {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  return queryVerificationsLib({
    startDate: opts.startDate ?? ninetyDaysAgo.toISOString(),
    endDate: opts.endDate ?? now.toISOString(),
    sessionId: opts.sessionId,
    limit: opts.limit ?? 1000,
  });
}

export async function loadLogsBySessionId(
  sessionId: string,
  startDate?: string,
  endDate?: string,
): Promise<Awaited<ReturnType<MultiDirectoryBackend['queryLogs']>>> {
  const { queryLogs } = await import('../../../dist/tools/query-logs.js');
  const now = new Date();
  const start = startDate ? toDateOnly(startDate)
    : toDateOnly(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
  const end = endDate ? toDateOnly(endDate) : toDateOnly(now.toISOString());
  const result = await queryLogs({
    sessionId,
    startDate: start,
    endDate: end,
    limit: 1000,
  });
  return result.logs;
}

export async function loadEvaluationsBySessionId(
  sessionId: string,
  startDate?: string,
  endDate?: string,
): Promise<EvaluationResult[]> {
  const be = getBackend();
  const now = new Date();
  return be.queryEvaluations({
    sessionId,
    startDate: startDate ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    endDate: endDate ?? now.toISOString(),
    limit: 10000,
  });
}

export async function checkHealth(): Promise<{ status: string; hasData: boolean }> {
  const be = getBackend();
  const health = await be.healthCheck();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const evals = await be.queryEvaluations({
    startDate: weekAgo.toISOString(),
    endDate: now.toISOString(),
    limit: 1,
  });
  return { status: health.status, hasData: evals.length > 0 };
}
