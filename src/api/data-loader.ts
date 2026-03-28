import { MultiDirectoryBackend } from '../../../dist/backends/local-jsonl.js';
import type { EvaluationResult } from '../../../dist/backends/index.js';
import { queryVerifications as queryVerificationsLib, type HumanVerificationEvent } from '../../../dist/lib/audit/verification-events.js';
import { queryTraces as queryTracesTool } from '../../../dist/tools/query-traces.js';
import { queryLogs } from '../../../dist/tools/query-logs.js';
import { TIME_MS, PERIOD_MS } from '../lib/constants.js';
import { toDateOnly } from './api-constants.js';
import { groupBy } from '../lib/quality-utils.js';

const DEFAULT_LOOKBACK_7D = PERIOD_MS['7d'];
const DEFAULT_LOOKBACK_30D = PERIOD_MS['30d'];
const DEFAULT_LOOKBACK_90D = 90 * TIME_MS.DAY;

const LIMIT_EVALS_BULK = 100_000;
const LIMIT_EVALS_METRIC = 10_000;
/**
 * Max evals returned per single traceId query. 1,000 is safe because each
 * trace maps to one Claude session, and observed eval counts top out around
 * 200–400 per session (rule-based + sampled LLM judge). Headroom covers
 * future metric expansion without risking unbounded reads.
 */
const LIMIT_EVALS_PER_TRACE = 1_000;
const LIMIT_EVALS_SESSION = 10_000;
const LIMIT_TRACES = 500;
const LIMIT_LOGS = 1_000;
const LIMIT_HEALTH_PROBE = 1;

let backend: MultiDirectoryBackend | undefined;

function getBackend(): MultiDirectoryBackend {
  if (!backend) {
    backend = new MultiDirectoryBackend(undefined, true);
  }
  return backend;
}

function defaultRange(lookbackMs: number): { start: string; end: string } {
  const now = new Date();
  return {
    start: new Date(now.getTime() - lookbackMs).toISOString(),
    end: now.toISOString(),
  };
}

export async function loadEvaluationsByMetric(
  start: string,
  end: string
): Promise<Map<string, EvaluationResult[]>> {
  const be = getBackend();
  const evals = await be.queryEvaluations({ startDate: start, endDate: end, limit: LIMIT_EVALS_BULK });
  return groupBy(evals, ev => ev.evaluationName);
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
    limit: LIMIT_EVALS_METRIC,
  });
}

export async function loadEvaluationsByTraceId(
  traceId: string,
  startDate?: string,
  endDate?: string,
): Promise<EvaluationResult[]> {
  const be = getBackend();
  const { start, end } = defaultRange(DEFAULT_LOOKBACK_90D);
  return be.queryEvaluations({
    traceId,
    startDate: startDate ?? start,
    endDate: endDate ?? end,
    limit: LIMIT_EVALS_PER_TRACE,
  });
}

const TRACE_QUERY_CONCURRENCY = 10;

/**
 * Deduplicates input, then issues batched per-traceId queries
 * (max {@link TRACE_QUERY_CONCURRENCY} in parallel) to avoid
 * saturating the backend with unbounded concurrent reads.
 */
export async function loadEvaluationsByTraceIds(
  traceIds: string[],
  startDate?: string,
  endDate?: string
): Promise<EvaluationResult[]> {
  const uniqueIds = [...new Set(traceIds)];
  if (uniqueIds.length === 0) return [];
  const be = getBackend();
  const { start: defStart, end: defEnd } = defaultRange(DEFAULT_LOOKBACK_90D);
  const start = startDate ?? defStart;
  const end = endDate ?? defEnd;
  const all: EvaluationResult[] = [];
  for (let i = 0; i < uniqueIds.length; i += TRACE_QUERY_CONCURRENCY) {
    const batch = uniqueIds.slice(i, i + TRACE_QUERY_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(traceId => be.queryEvaluations({ traceId, startDate: start, endDate: end, limit: LIMIT_EVALS_PER_TRACE }))
    );
    for (const result of settled) {
      if (result.status === 'fulfilled') all.push(...result.value);
    }
  }
  return all;
}

function traceQueryDates(startDate?: string, endDate?: string): { start: string; end: string } {
  const { start: defStart, end: defEnd } = defaultRange(DEFAULT_LOOKBACK_30D);
  return { start: toDateOnly(startDate ?? defStart), end: toDateOnly(endDate ?? defEnd) };
}

export async function loadTracesByTraceId(traceId: string, startDate?: string, endDate?: string) {
  const { start, end } = traceQueryDates(startDate, endDate);
  return (await queryTracesTool({ traceId, startDate: start, endDate: end, limit: LIMIT_TRACES })).traces;
}

export async function loadTracesBySessionId(sessionId: string, startDate?: string, endDate?: string) {
  const { start, end } = traceQueryDates(startDate, endDate);
  return (await queryTracesTool({ attributeFilter: { 'session.id': sessionId }, startDate: start, endDate: end, limit: LIMIT_TRACES })).traces;
}

async function queryLogsWithDefaultRange(
  filter: { traceId?: string; sessionId?: string },
  startDate?: string,
  endDate?: string,
): Promise<Awaited<ReturnType<MultiDirectoryBackend['queryLogs']>>> {
  const { start: defStart, end: defEnd } = defaultRange(DEFAULT_LOOKBACK_30D);
  const start = toDateOnly(startDate ?? defStart);
  const end = toDateOnly(endDate ?? defEnd);
  const result = await queryLogs({ ...filter, startDate: start, endDate: end, limit: LIMIT_LOGS });
  return result.logs;
}

export async function loadLogsByTraceId(
  traceId: string,
  startDate?: string,
  endDate?: string,
): Promise<Awaited<ReturnType<MultiDirectoryBackend['queryLogs']>>> {
  return queryLogsWithDefaultRange({ traceId }, startDate, endDate);
}

export async function loadVerifications(opts: {
  startDate?: string;
  endDate?: string;
  sessionId?: string;
  limit?: number;
}): Promise<HumanVerificationEvent[]> {
  const { start, end } = defaultRange(DEFAULT_LOOKBACK_90D);
  return queryVerificationsLib({
    startDate: opts.startDate ?? start,
    endDate: opts.endDate ?? end,
    sessionId: opts.sessionId,
    limit: opts.limit ?? LIMIT_LOGS,
  });
}

export async function loadLogsBySessionId(
  sessionId: string,
  startDate?: string,
  endDate?: string,
): Promise<Awaited<ReturnType<MultiDirectoryBackend['queryLogs']>>> {
  return queryLogsWithDefaultRange({ sessionId }, startDate, endDate);
}

export async function loadEvaluationsBySessionId(
  sessionId: string,
  startDate?: string,
  endDate?: string,
): Promise<EvaluationResult[]> {
  const be = getBackend();
  const { start, end } = defaultRange(DEFAULT_LOOKBACK_30D);
  return be.queryEvaluations({
    sessionId,
    startDate: startDate ?? start,
    endDate: endDate ?? end,
    limit: LIMIT_EVALS_SESSION,
  });
}

export async function checkHealth(): Promise<{ status: string; hasData: boolean }> {
  const be = getBackend();
  const health = await be.healthCheck();
  const { start, end } = defaultRange(DEFAULT_LOOKBACK_7D);
  const evals = await be.queryEvaluations({
    startDate: start,
    endDate: end,
    limit: LIMIT_HEALTH_PROBE,
  });
  return { status: health.status, hasData: evals.length > 0 };
}
