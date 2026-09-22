import pLimit from 'p-limit';
import { group } from 'd3-array';
import { CloudBackend } from './parent/backends.js';
import type { EvaluationResult, HumanVerificationEvent } from '../types.js';
import { queryVerifications as queryVerificationsLib } from './parent/verification-events.js';
import { queryTraces as queryTracesTool } from './parent/query-traces.js';
import { queryLogs } from './parent/query-logs.js';
import { TIME_MS, PERIOD_MS } from '../lib/constants.js';
import { toDateOnly, toIsoWindowBound, NANOS_TO_MS } from './api-constants.js';

const DEFAULT_LOOKBACK_7D = PERIOD_MS['7d']!;
const DEFAULT_LOOKBACK_30D = PERIOD_MS['30d']!;
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

let backend: CloudBackend | undefined;

function getBackend(): CloudBackend {
  // Org scope for the local dev server (org-scoped multi-tenancy P2): this
  // server has no auth middleware, so it must never trust a client-supplied
  // org — the scope is a fixed env value. Absent, obtool-api defaults the
  // scope to its HOME_ORG_ID server-side.
  // Pass baseUrl explicitly so tests can override it via process.env before
  // the first call (the parent's constants.js captures OBTOOL_API_URL at
  // module-load time, which would bypass a beforeAll override otherwise).
  backend ??= new CloudBackend({
    orgId: process.env.DEV_ORG_ID,
    baseUrl: process.env.OBTOOL_API_URL,
  });
  return backend;
}

function defaultRange(lookbackMs: number): { start: string; end: string } {
  const now = new Date();
  return {
    start: new Date(now.getTime() - lookbackMs).toISOString(),
    end: now.toISOString(),
  };
}

function isoToNs(iso: string): bigint {
  return BigInt(new Date(iso).getTime()) * BigInt(NANOS_TO_MS);
}

export async function loadEvaluationsByMetric(
  start: string,
  end: string
): Promise<Map<string, EvaluationResult[]>> {
  const be = getBackend();
  const evals = await be.queryEvaluations({ startDate: isoToNs(start), endDate: isoToNs(end), limit: LIMIT_EVALS_BULK });
  return group(evals, ev => ev.evaluationName);
}

export async function loadEvaluationsForMetric(
  metricName: string,
  start: string,
  end: string
): Promise<EvaluationResult[]> {
  const be = getBackend();
  return be.queryEvaluations({
    startDate: isoToNs(start),
    endDate: isoToNs(end),
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
    startDate: isoToNs(startDate ?? start),
    endDate: isoToNs(endDate ?? end),
    limit: LIMIT_EVALS_PER_TRACE,
  });
}

const TRACE_QUERY_CONCURRENCY = 10;

/**
 * Deduplicates input, then issues all per-traceId queries concurrently with a
 * sliding-window limiter (max {@link TRACE_QUERY_CONCURRENCY} in-flight at a
 * time) to avoid saturating the backend with unbounded concurrent reads.
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
  const limiter = pLimit(TRACE_QUERY_CONCURRENCY);
  const settled = await Promise.allSettled(
    uniqueIds.map(traceId =>
      limiter(() => be.queryEvaluations({ traceId, startDate: isoToNs(start), endDate: isoToNs(end), limit: LIMIT_EVALS_PER_TRACE }))
    )
  );
  const all: EvaluationResult[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') all.push(...result.value);
  }
  return all;
}

function traceQueryDates(startDate?: string, endDate?: string): { start: string; end: string } {
  const { start: defStart, end: defEnd } = defaultRange(DEFAULT_LOOKBACK_30D);
  // queryTracesTool validates startDate/endDate as ISO 8601 datetime (not date-only).
  // toIsoWindowBound expands 'YYYY-MM-DD' → 'YYYY-MM-DDT00:00:00.000Z'; ISO strings pass through.
  return {
    start: toIsoWindowBound(startDate ?? defStart, 'start'),
    end: toIsoWindowBound(endDate ?? defEnd, 'end'),
  };
}

export async function loadTracesByTraceId(traceId: string, startDate?: string, endDate?: string) {
  const { start, end } = traceQueryDates(startDate, endDate);
  return (await queryTracesTool({ traceId, startDate: start, endDate: end, limit: LIMIT_TRACES }, { backend: getBackend() })).traces;
}

export async function loadTracesBySessionId(sessionId: string, startDate?: string, endDate?: string) {
  const { start, end } = traceQueryDates(startDate, endDate);
  return (await queryTracesTool({ attributeFilter: { 'session.id': sessionId }, startDate: start, endDate: end, limit: LIMIT_TRACES }, { backend: getBackend() })).traces;
}

/**
 * Query traces by a free-form attributeFilter with explicit ISO datetime bounds.
 * Routes should prefer this over calling queryTraces directly so the singleton
 * backend (configured with the correct API URL at first-use time) is always used.
 */
export async function loadTracesByFilter(
  attributeFilter: Record<string, string | boolean | number>,
  startDate: string,
  endDate: string,
  limit: number,
) {
  return (await queryTracesTool({ attributeFilter, startDate, endDate, limit }, { backend: getBackend() })).traces;
}

async function queryLogsWithDefaultRange(
  filter: { traceId?: string; sessionId?: string },
  startDate?: string,
  endDate?: string,
): Promise<Awaited<ReturnType<typeof queryLogs>>['logs']> {
  const { start: defStart, end: defEnd } = defaultRange(DEFAULT_LOOKBACK_30D);
  // queryLogs validates startDate/endDate as ISO 8601 datetime (not date-only).
  // toIsoWindowBound expands 'YYYY-MM-DD' → 'YYYY-MM-DDT00:00:00.000Z'; ISO strings pass through.
  const start = toIsoWindowBound(startDate ?? defStart, 'start');
  const end = toIsoWindowBound(endDate ?? defEnd, 'end');
  const result = await queryLogs({ ...filter, startDate: start, endDate: end, limit: LIMIT_LOGS }, { backend: getBackend() });
  return result.logs;
}

export async function loadLogsByTraceId(
  traceId: string,
  startDate?: string,
  endDate?: string,
): Promise<Awaited<ReturnType<typeof queryLogs>>['logs']> {
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
    startDate: isoToNs(opts.startDate ?? start),
    endDate: isoToNs(opts.endDate ?? end),
    sessionId: opts.sessionId,
    limit: opts.limit ?? LIMIT_LOGS,
  });
}

export async function loadLogsBySessionId(
  sessionId: string,
  startDate?: string,
  endDate?: string,
): Promise<Awaited<ReturnType<typeof queryLogs>>['logs']> {
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
    startDate: isoToNs(startDate ?? start),
    endDate: isoToNs(endDate ?? end),
    limit: LIMIT_EVALS_SESSION,
  });
}

export async function checkHealth(): Promise<{ status: string; hasData: boolean }> {
  const be = getBackend();
  const health = await be.healthCheck();
  const { start, end } = defaultRange(DEFAULT_LOOKBACK_7D);
  const evals = await be.queryEvaluations({
    startDate: isoToNs(start),
    endDate: isoToNs(end),
    limit: LIMIT_HEALTH_PROBE,
  });
  return { status: health.status, hasData: evals.length > 0 };
}
