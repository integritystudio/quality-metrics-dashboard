import pLimit from 'p-limit';
import { group } from 'd3-array';
import { CloudBackend } from './parent/backends.js';
import type { EvaluationResult, HumanVerificationEvent, TraceSpan } from '../types.js';
import { queryVerifications as queryVerificationsLib } from './parent/verification-events.js';
import { queryTraces as queryTracesTool } from './parent/query-traces.js';
import { queryLogs } from './parent/query-logs.js';
import { PERIOD_MS, lookbackRange } from '../lib/constants.js';
import { isoToNs, toIsoWindowBound } from './api-constants.js';
import { SESSION_ATTRIBUTES } from '../lib/otel-attributes.js';
import { cloudReadKey, sharedCloudRead } from './cloud-reads.js';

const DEFAULT_LOOKBACK_7D = PERIOD_MS['7d'];
const DEFAULT_LOOKBACK_30D = PERIOD_MS['30d'];
const DEFAULT_LOOKBACK_90D = PERIOD_MS['90d'];

const LIMIT_EVALS_BULK = 100_000;
const LIMIT_EVALS_METRIC = 10_000;
/**
 * Max evals returned per single traceId query. 1,000 is safe because each
 * trace maps to one Claude session, and observed eval counts top out around
 * 200–400 per session (rule-based + sampled LLM judge). Headroom covers
 * future metric expansion without risking unbounded reads.
 */
const LIMIT_EVALS_PER_TRACE = 1_000;
/**
 * Most evaluations returned for one session. {@link loadEvaluationsBySessionId}
 * reads {@link TRUNCATION_PROBE_ROWS} past it, so a longer session comes back
 * flagged `truncated` instead of cut off with no signal.
 */
export const LIMIT_EVALS_SESSION = 10_000;
/** Rows read past a limit: getting one back is the only evidence that more exist. */
export const TRUNCATION_PROBE_ROWS = 1;
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
  const orgId = process.env.DEV_ORG_ID;
  const baseUrl = process.env.OBTOOL_API_URL;
  backend ??= new CloudBackend({
    ...(orgId !== undefined ? { orgId } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
  return backend;
}

type EvaluationRead = {
  start: string;
  end: string;
  limit: number;
  evaluationName?: string;
  traceId?: string;
  sessionId?: string;
};

/** Every evaluations read goes through the shared layer, keyed on the request it sends. */
async function readEvaluations({ start, end, ...filters }: EvaluationRead): Promise<EvaluationResult[]> {
  return sharedCloudRead(cloudReadKey('evaluations', { start, end, ...filters }), async () =>
    getBackend().queryEvaluations({ startDate: isoToNs(start), endDate: isoToNs(end), ...filters }),
  );
}

export async function loadEvaluationsByMetric(
  start: string,
  end: string
): Promise<Map<string, EvaluationResult[]>> {
  const evals = await readEvaluations({ start, end, limit: LIMIT_EVALS_BULK });
  return group(evals, ev => ev.evaluationName);
}

export async function loadEvaluationsForMetric(
  metricName: string,
  start: string,
  end: string
): Promise<EvaluationResult[]> {
  return readEvaluations({ start, end, evaluationName: metricName, limit: LIMIT_EVALS_METRIC });
}

export async function loadEvaluationsByTraceId(
  traceId: string,
  startDate?: string,
  endDate?: string,
): Promise<EvaluationResult[]> {
  const { start, end } = lookbackRange(DEFAULT_LOOKBACK_90D);
  return readEvaluations({ traceId, start: startDate ?? start, end: endDate ?? end, limit: LIMIT_EVALS_PER_TRACE });
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
  const { start: defStart, end: defEnd } = lookbackRange(DEFAULT_LOOKBACK_90D);
  const start = startDate ?? defStart;
  const end = endDate ?? defEnd;
  const limiter = pLimit(TRACE_QUERY_CONCURRENCY);
  const settled = await Promise.allSettled(
    uniqueIds.map(async traceId =>
      limiter(async () => readEvaluations({ traceId, start, end, limit: LIMIT_EVALS_PER_TRACE }))
    )
  );
  const all: EvaluationResult[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') all.push(...result.value);
  }
  return all;
}

/**
 * One span as the loaders return it. `queryTraces` projects nine fields, so this is
 * narrower than the full span schema, whose other fields the projection never sends.
 * Derived from the tool rather than restated so the two cannot drift.
 */
export type LoadedSpan = Awaited<ReturnType<typeof queryTracesTool>>['traces'][number];

function traceQueryDates(startDate?: string, endDate?: string): { start: string; end: string } {
  const { start: defStart, end: defEnd } = lookbackRange(DEFAULT_LOOKBACK_30D);
  // queryTracesTool validates startDate/endDate as ISO 8601 datetime (not date-only).
  // toIsoWindowBound expands 'YYYY-MM-DD' → 'YYYY-MM-DDT00:00:00.000Z'; ISO strings pass through.
  return {
    start: toIsoWindowBound(startDate ?? defStart, 'start'),
    end: toIsoWindowBound(endDate ?? defEnd, 'end'),
  };
}

type TraceRead = Parameters<typeof queryTracesTool>[0];

async function readTraces(query: TraceRead): Promise<LoadedSpan[]> {
  const { attributeFilter, startDate, endDate, ...rest } = query;
  const key = cloudReadKey('traces', {
    start: startDate === undefined ? undefined : String(startDate),
    end: endDate === undefined ? undefined : String(endDate),
    ...rest,
    attributeFilter: JSON.stringify(attributeFilter),
  });
  return sharedCloudRead(key, async () => (await queryTracesTool(query, { backend: getBackend() })).traces);
}

export async function loadTracesByTraceId(traceId: string, startDate?: string, endDate?: string): Promise<LoadedSpan[]> {
  const { start, end } = traceQueryDates(startDate, endDate);
  return readTraces({ traceId, startDate: start, endDate: end, limit: LIMIT_TRACES });
}

export async function loadTracesBySessionId(sessionId: string, startDate?: string, endDate?: string): Promise<LoadedSpan[]> {
  const { start, end } = traceQueryDates(startDate, endDate);
  return readTraces({ attributeFilter: { [SESSION_ATTRIBUTES.ID]: sessionId }, startDate: start, endDate: end, limit: LIMIT_TRACES });
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
): Promise<LoadedSpan[]> {
  return readTraces({ attributeFilter, startDate, endDate, limit });
}

/**
 * Query traces by attribute filter, bypassing the MCP tool's 1000-row cap.
 * Calls `CloudBackend.queryTraces` directly so `fetchAllPages` follows cursors
 * and returns all matching spans up to `limit`.
 *
 * Use when the expected count can exceed 1000, e.g. code-quality checkpoints.
 */
export async function loadSpansByFilterUnbounded(
  attributeFilter: Record<string, string | boolean | number>,
  startDate: string,
  endDate: string,
  limit: number,
): Promise<TraceSpan[]> {
  const key = cloudReadKey('traces', {
    start: startDate,
    end: endDate,
    limit: String(limit),
    attributeFilter: JSON.stringify(attributeFilter),
  });
  const startNs = isoToNs(startDate);
  const endNs = isoToNs(endDate);
  return sharedCloudRead(key, async () =>
    getBackend().queryTraces({ attributeFilter, startDate: startNs, endDate: endNs, limit })
  );
}

async function queryLogsWithDefaultRange(
  filter: { traceId?: string; sessionId?: string },
  startDate?: string,
  endDate?: string,
): Promise<Awaited<ReturnType<typeof queryLogs>>['logs']> {
  const { start: defStart, end: defEnd } = lookbackRange(DEFAULT_LOOKBACK_30D);
  // queryLogs validates startDate/endDate as ISO 8601 datetime (not date-only).
  // toIsoWindowBound expands 'YYYY-MM-DD' → 'YYYY-MM-DDT00:00:00.000Z'; ISO strings pass through.
  const start = toIsoWindowBound(startDate ?? defStart, 'start');
  const end = toIsoWindowBound(endDate ?? defEnd, 'end');
  const query = { ...filter, startDate: start, endDate: end, limit: LIMIT_LOGS };
  return sharedCloudRead(cloudReadKey('logs', query), async () => (await queryLogs(query, { backend: getBackend() })).logs);
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
  const { start, end } = lookbackRange(DEFAULT_LOOKBACK_90D);
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

export type SessionEvaluations = {
  /** At most {@link LIMIT_EVALS_SESSION} rows, in the order the backend returned them. */
  evaluations: EvaluationResult[];
  /** True when the session has more evaluations in the window than `evaluations` holds. */
  truncated: boolean;
}

export async function loadEvaluationsBySessionId(
  sessionId: string,
  startDate?: string,
  endDate?: string,
): Promise<SessionEvaluations> {
  const { start, end } = lookbackRange(DEFAULT_LOOKBACK_30D);
  const rows = await readEvaluations({
    sessionId,
    start: startDate ?? start,
    end: endDate ?? end,
    limit: LIMIT_EVALS_SESSION + TRUNCATION_PROBE_ROWS,
  });
  return {
    evaluations: rows.slice(0, LIMIT_EVALS_SESSION),
    truncated: rows.length > LIMIT_EVALS_SESSION,
  };
}

export async function checkHealth(): Promise<{ status: string; hasData: boolean }> {
  const health = await getBackend().healthCheck();
  const { start, end } = lookbackRange(DEFAULT_LOOKBACK_7D);
  const evals = await readEvaluations({ start, end, limit: LIMIT_HEALTH_PROBE });
  return { status: health.status, hasData: evals.length > 0 };
}
