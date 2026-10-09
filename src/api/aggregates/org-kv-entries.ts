/**
 * Every KV entry one org's dashboard is served from, computed from that org's
 * cloud rows. The CLI sync (`scripts/sync-to-kv.ts`) calls this and owns the
 * delta state, the Cloudflare writes and the two owner-local inputs it passes
 * in (`calibrationEntry`, `degradationState`); the Workflow port
 * (`services/kv-sync-workflow`, `docs/roadmap/kv-sync-in-worker.md`) is meant
 * to call the same functions, so nothing here reads a file, the environment
 * or `process.argv`.
 */

import { group, minIndex, quantileSorted } from 'd3-array';
import type { CloudBackend } from '../parent/backends.js';
import { queriedDateWindow } from '../parent/backends.js';
import { getQualityMetric, QUALITY_METRICS } from '../parent/quality-metrics.js';
import { computeRollingDegradationSignals, type DegradationState } from '../parent/qfe-backtest.js';
import type { CalibrationState } from '../parent/qfe-percentiles.js';
import { computeMultiAgentEvaluation } from '../parent/quality-multi-agent.js';
import { BYTES, PERCENT_MULTIPLIER, SECONDS, TIME_MS } from '../parent/units.js';
import type { EvaluationResult, TraceSpan } from '../../types.js';
import type { CalibrationResponse } from '../../lib/validation/dashboard-schemas.js';
import { PERIOD_MS, DEFAULT_TOP_N, DEFAULT_BUCKET_COUNT, DEFAULT_TREND_BUCKETS, type Period } from '../../lib/constants.js';
import { SESSION_ATTRIBUTES } from '../../lib/otel-attributes.js';
import { pushTo } from '../../lib/collections.js';
import { buildWorkflowGraph } from '../../lib/workflow-graph.js';
import {
  CANARY_COHORT,
  CANARY_EVALUATOR_TYPE,
  LATENCY_P95,
  RATE_DISPLAY_PRECISION,
  bigintReplacer,
  msToNs,
  timestampToMs,
} from '../api-constants.js';
import {
  CODE_EVENT,
  CODE_EVENT_ATTR,
  CODE_QUALITY_CHECKPOINT_LIMIT,
  CODE_QUALITY_INVOCATION_LIMIT,
  CODE_QUALITY_KV_KEY,
  CODE_QUALITY_LOOKBACK_DAYS,
  summarizeCodeQuality,
} from '../code-quality-summary.js';
import { computeSessionDetail, type AgentActivityEntry } from '../session-detail.js';
import { agentStatsKey, agentStatsWindow, computeAgentStats, isAgentFinalizeSpan } from './agent-stats.js';
import { computeCorrelations } from './correlations.js';
import { computePipeline } from './pipeline.js';
import { computeCoverage } from './coverage.js';
import { projectEvaluationRow } from './evaluation-rows.js';
import { computeAllDashboardEntries } from './dashboard-summary.js';
import { computeMetricDetailView, metricDetailKey, previousWindow } from './metric-detail.js';
import { computeTrend, trendKey, type ScoredBucket } from './trend.js';

const LOG_PREFIX = '[org-kv-entries]';

/** The literal `worker/index.ts` reads at GET /api/degradation-signals; keep the two in step. */
const DEGRADATION_KV_KEY = 'meta/dashboard/degradation-signals';
const META_CALIBRATION_KEY = 'meta:calibration';
export const TRACE_KEY_PREFIX = 'trace:';
export const TRACE_EVALS_KEY_PREFIX = 'evaluations:trace:';

const PERIODS = ['24h', '7d', '30d'] as const;

const MAX_SESSION_DURATIONS = 10_000;
const MAX_AGENT_SESSIONS = 100;
const MAX_RECENT_SESSIONS = 20;

/** Input axes the coverage matrix is built for — one KV key per (period, axis). */
const COVERAGE_INPUT_KEYS = ['traceId', 'sessionId'] as const;
/**
 * Hard cap on the number of input columns stored per coverage key.
 * The dashboard grid renders at most `COVERAGE_GRID_MAX_INPUTS = 30`, so a few
 * hundred is ample headroom for all views. Without a cap the column count grows
 * with each new trace or session in the window (COVERAGE-INPUT-SET-UNBOUNDED).
 */
const MAX_COVERAGE_COLUMNS = 500;
/** Cloudflare KV's per-value limit. A value past it fails its whole bulk-put batch (`kvBulkPut` throws). */
const KV_VALUE_LIMIT_BYTES = 25 * BYTES.MB;
/** Fraction of the limit at which the sync warns, so the column cap is lowered before a write fails. */
const KV_VALUE_WARN_RATIO = 0.8;
const KV_VALUE_WARN_BYTES = Math.round(KV_VALUE_LIMIT_BYTES * KV_VALUE_WARN_RATIO);

export const QUERY_LIMIT = 200_000;
/** Span queries need a higher limit than evaluation queries to capture all sessions. */
const SPAN_QUERY_LIMIT = 1_000_000;

/**
 * TTL for per-trace and per-session KV entries (seconds).
 * Must exceed the longest `--days` query window so entries are not prematurely expired.
 * 90 days is 3x the default 30-day window and prevents unbounded key accumulation.
 */
export const KV_ENTRY_TTL_DAYS = 90;
export const KV_ENTRY_TTL_SECONDS = SECONDS.DAY * KV_ENTRY_TTL_DAYS;

const MAX_EVAL_ROWS = 200;
/** Metric detail baselines each period against the one before it, so the read spans two of the longest. */
const METRIC_DETAIL_WINDOWS = 2;

/** `hashBasis`, when set, is what change detection hashes instead of `value`. */
export type KVEntry = { key: string; value: string; expirationTtl?: number; hashBasis?: string };

/**
 * Serialize a KV entry value. Backend spans and evaluations carry `bigint`
 * timestamps (`startTimeUnixNano`, `endTimeUnixNano`, `timestamp`) that
 * `JSON.stringify` throws on; the replacer writes them in their decimal-string
 * wire form, which `timestampToMs` on the read side already accepts. Every KV
 * entry value must be built through this, never bare `JSON.stringify` — the
 * bigint-bearing types nest at varying depth (SYNC-KV-BIGINT). A replacer
 * rather than `jsonSafe`, which deep-copies the value before it is serialized.
 *
 * Throws when the value has no JSON form (`undefined`, a function, a symbol):
 * `JSON.stringify` returns `undefined` for those, and `kvBulkPut` splices the
 * value into its envelope as text, so nothing later would catch it
 * (KV-VALUE-NOT-JSON-UNGUARDED).
 */
export function toKVValue(value: unknown): string {
  const json: string | undefined = JSON.stringify(value, bigintReplacer);
  if (typeof json !== 'string') throw new TypeError(`${LOG_PREFIX} KV value has no JSON form (${typeof value})`);
  return json;
}

/**
 * Drop canary evaluations before aggregation — their scores are synthetic and
 * would drag every average they land in.
 *
 * **Checks both fields, and must keep doing so.** Records written before OBP16
 * mark a canary in the overloaded `evaluatorType`; records written after it use
 * `cohort`, leaving `evaluatorType` to carry the evaluator kind. Neither set is
 * being backfilled, so dropping either check silently readmits one era's
 * canaries into the aggregates.
 */
function filterCanary(evals: EvaluationResult[]): EvaluationResult[] {
  return evals.filter(ev =>
    ev.cohort !== CANARY_COHORT && ev.evaluatorType !== CANARY_EVALUATOR_TYPE);
}

export function buildCalibrationEntry(
  state: CalibrationState | null,
): KVEntry | null {
  if (!state?.distributions || Object.keys(state.distributions).length === 0) {
    return null;
  }
  const distributions: CalibrationResponse['distributions'] = {};
  const sampleCounts: CalibrationResponse['sampleCounts'] = {};
  for (const [metric, entry] of Object.entries(state.distributions)) {
    distributions[metric] = entry.distribution;
    sampleCounts[metric] = entry.sampleSize;
  }
  // Typed as the shared contract so a drift between what this writes and what
  // `useCalibration` reads is a typecheck failure, not a runtime surprise.
  const payload: CalibrationResponse = {
    distributions,
    sampleCounts,
    lastCalibrated: state.lastCalibrated,
  };
  return { key: META_CALIBRATION_KEY, value: toKVValue(payload) };
}

/** The view's own run-time stamp; a nested `timestamp` (`worstExplanation.timestamp`) is event time, i.e. data. */
const DASHBOARD_RUN_STAMP_FIELD = 'timestamp';
/** Each metric's query window, built from the run's `now`, at any depth. */
const DASHBOARD_PERIOD_FIELD = 'period';
/**
 * Sparkline bucket indices shift with the exact `now` — two runs on the same UTC
 * day over the same data disagree on which bucket holds an evaluation unless the
 * boundaries are day-aligned. Exclude from the hash so the key is not rewritten
 * solely because the run time moved within the same day (SYNC-DASHBOARD-TIMESTAMP-WRITES).
 */
const DASHBOARD_SPARKLINES_FIELD = 'sparklines';

/**
 * A dashboard summary or role view as a KV entry. The view's top-level `timestamp`,
 * each metric's `period`, and `sparklines` come from the run's clock, so the change
 * hash leaves them out and a sync over unchanged data rewrites no `dashboard:*` key
 * (SYNC-DASHBOARD-TIMESTAMP-WRITES). The stored value keeps them, so they show the
 * run that last changed the data, not the latest run.
 */
export function dashboardEntry(key: string, view: object): KVEntry {
  const hashBasis = JSON.stringify(view, function (this: unknown, field: string, v: unknown) {
    if (field === DASHBOARD_PERIOD_FIELD) return undefined;
    if (field === DASHBOARD_SPARKLINES_FIELD) return undefined;
    if (field === DASHBOARD_RUN_STAMP_FIELD && this === view) return undefined;
    return bigintReplacer(field, v);
  });
  return { key, value: toKVValue(view), hashBasis };
}

function spanSessionId(span: { attributes?: Record<string, unknown> }): string | undefined {
  return (span.attributes?.[SESSION_ATTRIBUTES.ID] ?? span.attributes?.['session_id']) as string | undefined;
}

/** Groups by metric with canaries dropped, the input every aggregate is built from. */
function groupByMetric(evals: EvaluationResult[]): EvaluationsByName {
  return group(filterCanary(evals), ev => ev.evaluationName);
}

/** Narrows to rows with a non-empty `traceId`, so `group` keys them by `string`. */
function hasTraceId<T extends { traceId?: string }>(row: T): row is T & { traceId: string } {
  return Boolean(row.traceId);
}

/** In-memory cross-session accumulator for a single agent. Never serialized directly. */
interface AgentAccumulator {
  totalInvocations: number;
  totalErrors: number;
  rateLimitEvents: number;
  totalOutputSize: number;
  weightedDurationSum: number;
  sessionDurations: number[];
  truncatedCount: number;
  emptyCount: number;
  totalSessionCount: number;
  lastSeenDate: string | null;
  sessions: Array<{
    sessionId: string;
    invocations: number;
    errors: number;
    hasRateLimit: boolean;
    avgDurationMs: number;
    date: string | null;
    project: string | null;
  }>;
}

/** The two cloud reads one org's aggregation makes; a `CloudBackend` scoped to that org. */
export type OrgReadBackend = Pick<CloudBackend, 'queryEvaluations' | 'queryTraces'>;

/**
 * Add one session to an agent's bounded buffer of recent sessions. Once the
 * buffer holds `capacity`, a dated entry replaces the oldest dated session (the
 * first of a tie) if it is newer; when no buffered session has a date, it
 * replaces the last slot. An undated entry is dropped from a full buffer.
 */
export function addRecentSession<T extends { date: string | null }>(sessions: T[], entry: T, capacity: number): void {
  if (sessions.length < capacity) {
    sessions.push(entry);
    return;
  }
  if (!entry.date) return;
  const datedIdx = minIndex(sessions, s => s.date);
  const oldestIdx = datedIdx >= 0 ? datedIdx : sessions.length - 1;
  const oldestDate = sessions[oldestIdx]?.date;
  if (!oldestDate || entry.date > oldestDate) {
    sessions[oldestIdx] = entry;
  }
}

export interface OrgComputation {
  /** All computed entries under their BARE (unprefixed) keys. */
  allEntries: KVEntry[];
  evalsByTrace: Map<string, EvaluationResult[]>;
  referencedTraceIds: Set<string>;
  traceIds: string[];
  evalCount: number;
  spanCount: number;
  periodCounts: string;
  hitCap: boolean;
}

/** Per-trace KV entries; spans/evaluations carry bigint timestamps, hence toKVValue. */
export function buildTraceEntries(
  traceIds: string[],
  evalsByTrace: Map<string, EvaluationResult[]>,
  spansByTrace: Map<string, TraceSpan[]>,
): KVEntry[] {
  const traceEntries: KVEntry[] = [];
  for (const traceId of traceIds) {
    const traceEvals = evalsByTrace.get(traceId) ?? [];
    const spans = spansByTrace.get(traceId) ?? [];
    traceEntries.push({
      key: `${TRACE_EVALS_KEY_PREFIX}${traceId}`,
      value: toKVValue({ evaluations: traceEvals }),
      expirationTtl: KV_ENTRY_TTL_SECONDS,
    });
    traceEntries.push({
      key: `${TRACE_KEY_PREFIX}${traceId}`,
      value: toKVValue({ traceId, spans, evaluations: traceEvals }),
      expirationTtl: KV_ENTRY_TTL_SECONDS,
    });
  }
  return traceEntries;
}

/**
 * The Agent Code Quality page's data. The Worker has no live query path, so
 * this KV key is the only way `/api/code-quality` reaches production; the dev
 * API route computes the same summary from a live query.
 */
async function computeCodeQuality(backend: OrgReadBackend, now: Date) {
  const startDate = msToNs(now.getTime() - CODE_QUALITY_LOOKBACK_DAYS * TIME_MS.DAY);
  const endDate = msToNs(now.getTime());
  const [checkpointSpans, invocationSpans] = await Promise.all([
    backend.queryTraces({
      startDate, endDate, limit: CODE_QUALITY_CHECKPOINT_LIMIT,
      attributeFilter: { [CODE_EVENT_ATTR]: CODE_EVENT.CHECKPOINT },
    }),
    backend.queryTraces({
      startDate, endDate, limit: CODE_QUALITY_INVOCATION_LIMIT,
      attributeFilter: { [CODE_EVENT_ATTR]: CODE_EVENT.GENERATED },
    }),
  ]);
  if (checkpointSpans.length === CODE_QUALITY_CHECKPOINT_LIMIT) {
    console.warn(`${LOG_PREFIX} Code-quality checkpoint query hit ${CODE_QUALITY_CHECKPOINT_LIMIT} — oldest checkpoints dropped`);
  }
  return summarizeCodeQuality(checkpointSpans, invocationSpans);
}

/** One org's evaluation read, and the windows sliced from it in memory. */
interface OrgEvaluations {
  /** At most QUERY_LIMIT rows, newest first. */
  evals: EvaluationResult[];
  /** The read held more than QUERY_LIMIT rows, so the oldest were dropped. */
  truncated: boolean;
  /** Rows with `startNs <= timestamp < endNs`. */
  inWindow(startNs: bigint, endNs: bigint): EvaluationResult[];
  /** The rows a separate `[startMs, endMs]` read would return; the server rounds both bounds to whole UTC days. */
  between(startMs: number, endMs?: number): EvaluationResult[];
}

type EvaluationsByName = Map<string, EvaluationResult[]>;

/** What `accumulateAgent` reads from one session's detail. */
type AgentSessionContext = {
  timespan: { start: string } | null;
  sessionInfo: { projectName: string } | null;
};

/**
 * One read serves every window: the periods, each metric-detail baseline and the
 * session/trace window. Separate reads fetched the same rows up to 22 times per org.
 * One extra row detects truncation (KV-SESSION-EVALS-TRUNCATION-UNFLAGGED); the server
 * returns the newest ids first, so a truncated read loses the oldest rows.
 */
async function readOrgEvaluations(backend: OrgReadBackend, nowMs: number, maxDaysMs: number): Promise<OrgEvaluations> {
  const fetched = await backend.queryEvaluations({
    startDate: msToNs(nowMs - METRIC_DETAIL_WINDOWS * maxDaysMs),
    endDate: msToNs(nowMs),
    limit: QUERY_LIMIT + 1,
  });
  const truncated = fetched.length > QUERY_LIMIT;
  const evals = truncated ? fetched.slice(0, QUERY_LIMIT) : fetched;
  if (truncated) {
    console.warn(
      `${LOG_PREFIX} Evaluation query returned ${QUERY_LIMIT} results — oldest evaluations dropped; all sessions marked partial`,
    );
  }
  const inWindow = (startNs: bigint, endNs: bigint): EvaluationResult[] =>
    evals.filter(ev => ev.timestamp >= startNs && ev.timestamp < endNs);
  const between = (startMs: number, endMs: number = nowMs): EvaluationResult[] => {
    const { startNs = 0n, endNs = 0n } = queriedDateWindow({ startDate: msToNs(startMs), endDate: msToNs(endMs) });
    return inWindow(startNs, endNs);
  };
  return { evals, truncated, inWindow, between };
}

/** `dashboard:`, role views, `correlations:`, `coverage:` and `pipeline:` for one period. */
function computePeriodEntries(period: Period, grouped: EvaluationsByName, dates: { start: string; end: string }): KVEntry[] {
  const entries: KVEntry[] = [];

  // Dashboard: one projection shared with the dev route — now includes `cqi` and `sparklines`.
  const { full, roleViews } = computeAllDashboardEntries(grouped, dates);
  entries.push(dashboardEntry(`dashboard:${period}`, full));
  for (const [role, view] of Object.entries(roleViews)) {
    entries.push(dashboardEntry(`dashboard:${period}:${role}`, view));
  }

  // Correlations: shared with the dev route.
  entries.push({ key: `correlations:${period}`, value: toKVValue(computeCorrelations(grouped)) });

  // Coverage: shared filter + matrix, one KV key per (period, inputKey).
  for (const inputKey of COVERAGE_INPUT_KEYS) {
    const matrix = computeCoverage(grouped, { inputKey, maxInputs: MAX_COVERAGE_COLUMNS });
    const coverageKey = `coverage:${period}:${inputKey}`;
    const coverageValue = toKVValue({ period, ...matrix });
    const coverageSizeBytes = new TextEncoder().encode(coverageValue).length;
    if (coverageSizeBytes > KV_VALUE_WARN_BYTES) {
      console.warn(
        `${LOG_PREFIX} ${coverageKey} is ${Math.round(coverageSizeBytes / BYTES.KB)} KB,` +
        ` over ${KV_VALUE_WARN_RATIO * PERCENT_MULTIPLIER}% of KV's ${KV_VALUE_LIMIT_BYTES / BYTES.MB} MiB value limit` +
        ' — reduce MAX_COVERAGE_COLUMNS',
      );
    }
    entries.push({ key: coverageKey, value: coverageValue });
  }

  // Pipeline: shared with the dev route.
  entries.push({ key: `pipeline:${period}`, value: toKVValue({ period, ...computePipeline(grouped) }) });

  return entries;
}

/**
 * `metric:<name>:<period>`: each period against the one before it, from the
 * projection the dev route serves. Also returns the trace ids the metric cards
 * link to, which the trace write budget favours.
 */
function computeMetricDetailEntries(
  groupedByPeriod: Map<Period, EvaluationsByName>,
  orgEvals: OrgEvaluations,
  nowMs: number,
  metricNames: string[],
): { entries: KVEntry[]; referencedTraceIds: Set<string> } {
  const entries: KVEntry[] = [];
  const referencedTraceIds = new Set<string>();

  for (const [period, current] of groupedByPeriod) {
    // The current window matches `dashboard:<period>`; `between` rounds the baseline's
    // bounds as the server does for the route's read.
    const baseline = previousWindow(period, new Date(nowMs));
    const previous = groupByMetric(orgEvals.between(baseline.start.getTime(), baseline.end.getTime()));

    for (const name of metricNames) {
      const config = getQualityMetric(name);
      const evals = current.get(name);
      if (!config || !evals) continue;

      const view = computeMetricDetailView(evals, previous.get(name) ?? [], config, {
        period,
        topN: DEFAULT_TOP_N,
        bucketCount: DEFAULT_BUCKET_COUNT,
      });
      for (const w of view.worstEvaluations) {
        if (w.traceId) referencedTraceIds.add(w.traceId);
      }
      entries.push({ key: metricDetailKey(name, period), value: toKVValue(view) });
    }
  }
  return { entries, referencedTraceIds };
}

/** `metric:evaluations:<name>:<period>`: the newest MAX_EVAL_ROWS rows per metric and period. */
function computeEvaluationRowEntries(
  groupedByPeriod: Map<Period, EvaluationsByName>,
  metricNames: string[],
): KVEntry[] {
  const entries: KVEntry[] = [];
  for (const [period, grouped] of groupedByPeriod) {
    for (const name of metricNames) {
      const evals = grouped.get(name);
      if (!evals || evals.length === 0) continue;
      const sorted = [...evals].sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
      const rows = sorted.slice(0, MAX_EVAL_ROWS).map(projectEvaluationRow);
      entries.push({
        key: `metric:evaluations:${name}:${period}`,
        value: toKVValue({ rows }),
      });
    }
  }
  return entries;
}

/**
 * `trend:<name>:<period>` from the projection the dev route serves, plus the
 * scored buckets per period × metric that the degradation signals are computed
 * from. Those buckets follow the series, so they narrow to concentrated data as
 * the chart does.
 */
function computeTrendEntries(
  groupedByPeriod: Map<Period, EvaluationsByName>,
  metricNames: string[],
  now: Date,
): { entries: KVEntry[]; degradationBuckets: Map<Period, Record<string, ScoredBucket[]>> } {
  const entries: KVEntry[] = [];
  const degradationBuckets = new Map<Period, Record<string, ScoredBucket[]>>();
  for (const [period, cached] of groupedByPeriod) {
    const periodBuckets: Record<string, ScoredBucket[]> = {};
    degradationBuckets.set(period, periodBuckets);

    for (const name of metricNames) {
      const config = getQualityMetric(name);
      if (!config) continue;
      const { view, buckets } = computeTrend(name, cached.get(name) ?? [], config, {
        period,
        bucketCount: DEFAULT_TREND_BUCKETS,
        now,
      });
      periodBuckets[name] = buckets;
      entries.push({ key: trendKey(name, period), value: toKVValue(view) });
    }
  }
  return { entries, degradationBuckets };
}

/** A degradation state with no history: every breach count starts at zero. */
export function statelessDegradation(): DegradationState {
  return { lastRun: '', breaches: {} };
}

/**
 * `degradation:<period>` from the trend buckets. `degradationState` is updated in
 * place: the latest period's breach counts win, and `lastRun` is set to `now`.
 * The caller owns persistence; a fresh `statelessDegradation()` gives signals
 * with no cross-run breach continuity.
 */
function computeDegradationEntries(
  degradationBuckets: Map<Period, Record<string, ScoredBucket[]>>,
  metricNames: string[],
  now: Date,
  degradationState: DegradationState,
): KVEntry[] {
  const entries: KVEntry[] = [];
  for (const [period, metricBuckets] of degradationBuckets) {
    const ms = PERIOD_MS[period];
    const windowStart = new Date(now.getTime() - ms);
    const window = { startDate: windowStart.toISOString(), endDate: now.toISOString() };
    const reports = computeRollingDegradationSignals(metricBuckets, metricNames, degradationState, window);
    // latest period wins
    for (const r of reports) {
      degradationState.breaches[r.metricName] = r.signal.consecutiveBreaches;
    }
    entries.push({
      key: `${DEGRADATION_KV_KEY}:${period}`,
      value: toKVValue({ period, reports, computedAt: now.toISOString() }),
    });
  }
  degradationState.lastRun = now.toISOString();
  return entries;
}

/** Fold one session's activity for one agent into that agent's cross-session totals. */
function accumulateAgent(
  agents: Map<string, AgentAccumulator>,
  ag: AgentActivityEntry,
  sessionId: string,
  detail: AgentSessionContext,
): void {
  let acc = agents.get(ag.agentName);
  if (!acc) {
    acc = {
      totalInvocations: 0, totalErrors: 0, rateLimitEvents: 0,
      totalOutputSize: 0, weightedDurationSum: 0, sessionDurations: [],
      truncatedCount: 0, emptyCount: 0,
      totalSessionCount: 0, lastSeenDate: null, sessions: [],
    };
    agents.set(ag.agentName, acc);
  }
  acc.totalInvocations += ag.invocations;
  acc.totalErrors += ag.errors;
  acc.rateLimitEvents += ag.rateLimitEvents;
  acc.totalOutputSize += ag.totalOutputSize;
  acc.truncatedCount += ag.truncatedCount;
  acc.emptyCount += ag.emptyCount;
  // One duration entry per session; capped to bound memory for p95 computation
  if (ag.avgDurationMs > 0) {
    acc.weightedDurationSum += ag.avgDurationMs * ag.invocations;
    if (acc.sessionDurations.length < MAX_SESSION_DURATIONS) {
      acc.sessionDurations.push(ag.avgDurationMs);
    }
  }
  // sessionDate is always ISO 8601 UTC (from toISOString()), so
  // lexicographic comparison is equivalent to chronological ordering.
  const sessionDate = detail.timespan?.start ?? null;
  acc.totalSessionCount++;
  if (sessionDate && (!acc.lastSeenDate || sessionDate > acc.lastSeenDate)) {
    acc.lastSeenDate = sessionDate;
  }
  const entry: AgentAccumulator['sessions'][number] = {
    sessionId,
    invocations: ag.invocations,
    errors: ag.errors,
    hasRateLimit: ag.hasRateLimit,
    avgDurationMs: ag.avgDurationMs,
    date: sessionDate,
    project: detail.sessionInfo?.projectName ?? null,
  };
  addRecentSession(acc.sessions, entry, MAX_AGENT_SESSIONS);
}

/** `agent:<name>` per agent. */
function buildAgentEntries(agents: Map<string, AgentAccumulator>, now: Date): KVEntry[] {
  const agentEntries: KVEntry[] = [];
  const computedAt = now.toISOString();

  for (const [agentName, acc] of agents) {
    // ISO 8601 sorts lexicographically — take most recent sessions first
    const sessions = acc.sessions
      .slice()
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      .slice(0, MAX_RECENT_SESSIONS);
    const lastSeen = acc.lastSeenDate;
    const totalSessions = acc.totalSessionCount;
    const sortedSessionDurations = acc.sessionDurations.slice().sort((a, b) => a - b);
    const perInvocation = (total: number) => (acc.totalInvocations > 0 ? total / acc.totalInvocations : 0);
    const rate = (count: number) => +perInvocation(count).toFixed(RATE_DISPLAY_PRECISION);

    const detail = {
      agentName,
      totalSessions,
      totalInvocations: acc.totalInvocations,
      totalErrors: acc.totalErrors,
      errorRate: rate(acc.totalErrors),
      rateLimitEvents: acc.rateLimitEvents,
      avgOutputSize: Math.round(perInvocation(acc.totalOutputSize)),
      avgDurationMs: Math.round(perInvocation(acc.weightedDurationSum)),
      p95DurationMs: Math.round(quantileSorted(sortedSessionDurations, LATENCY_P95 / PERCENT_MULTIPLIER) ?? 0),
      truncatedRate: rate(acc.truncatedCount),
      emptyOutputRate: rate(acc.emptyCount),
      lastSeen,
      computedAt,
      sessions,
    };

    agentEntries.push({ key: `agent:${agentName}`, value: toKVValue(detail) });
  }
  return agentEntries;
}

/**
 * `meta:agents:<period>`: the agents page, from the projection the dev route
 * uses on its live read. The spans are the agent-finalize spans of the span
 * read, cut to the period; the evaluations are the period's rows (the
 * projection keeps only those on an agent's trace).
 */
function computeAgentStatsEntries(allSpans: TraceSpan[], orgEvals: OrgEvaluations, now: Date, maxDaysMs: number): KVEntry[] {
  const agentSpans = allSpans.filter(isAgentFinalizeSpan);
  const entries: KVEntry[] = [];
  for (const period of PERIODS.filter(p => PERIOD_MS[p] <= maxDaysMs)) {
    const { windowStart } = agentStatsWindow(period, now);
    const spans = agentSpans.filter(span => timestampToMs(span.startTimeUnixNano) >= windowStart.getTime());
    const stats = computeAgentStats(spans, orgEvals.between(windowStart.getTime()), period, now);
    entries.push({ key: agentStatsKey(period), value: toKVValue(stats) });
  }
  return entries;
}

/** `session:<id>` per session with spans, then the `agent:` entries accumulated across them. */
function computeSessionAndAgentEntries(
  allSpans: TraceSpan[],
  allEvals: EvaluationResult[],
  evaluationsTruncated: boolean,
  now: Date,
): { sessionEntries: KVEntry[]; agentEntries: KVEntry[] } {
  const spansBySession = new Map<string, TraceSpan[]>();
  const traceToSession = new Map<string, string>();
  for (const span of allSpans) {
    const sid = spanSessionId(span);
    if (!sid) continue;
    pushTo(spansBySession, sid, span);
    if (span.traceId) traceToSession.set(span.traceId, sid);
  }
  const evalsBySession = new Map<string, EvaluationResult[]>();
  for (const ev of allEvals) {
    if (!ev.traceId) continue;
    const sid = traceToSession.get(ev.traceId);
    if (!sid) continue;
    pushTo(evalsBySession, sid, ev);
  }

  const agentCrossSession = new Map<string, AgentAccumulator>();
  const sessionEntries: KVEntry[] = [];
  for (const [sessionId, sessionSpans] of spansBySession) {
    const evaluations = evalsBySession.get(sessionId) ?? [];
    const detail = computeSessionDetail(
      { sessionId, spans: sessionSpans, evaluations, evaluationsTruncated },
      computeMultiAgentEvaluation,
    );
    sessionEntries.push({
      key: `session:${sessionId}`,
      value: toKVValue({
        ...detail,
        agentActivity: detail.agentActivity.map(
          ({ totalOutputSize: _, ...rest }) => rest,
        ),
        // The worker has no spans to build this from, so /api/agents/:sessionId
        // serves the graph precomputed here.
        workflowGraph: buildWorkflowGraph(detail.multiAgentEvaluation, sessionSpans),
      }),
      expirationTtl: KV_ENTRY_TTL_SECONDS,
    });

    for (const ag of detail.agentActivity) {
      accumulateAgent(agentCrossSession, ag, sessionId, detail);
    }
  }
  return { sessionEntries, agentEntries: buildAgentEntries(agentCrossSession, now) };
}

export interface OrgKvOptions {
  /** The query window in days; periods longer than it are skipped. */
  maxDays: number;
  /** The owner's `meta:calibration`, from derive's local state; omitted for every other org. */
  calibrationEntry?: KVEntry | null;
  /**
   * Breach history for the degradation signals, updated in place. Omitted,
   * the signals are computed statelessly (no cross-run breach continuity).
   */
  degradationState?: DegradationState;
}

/**
 * Run the full aggregation for one org's cloud rows. The only org-aware inputs
 * are the two owner-local ones in `options`, which the caller reads and
 * persists; everything else comes from `backend`.
 */
export async function computeOrgKvEntries(backend: OrgReadBackend, now: Date, options: OrgKvOptions): Promise<OrgComputation> {
  const entries: KVEntry[] = [];
  const nowMs = now.getTime();
  const maxDaysMs = options.maxDays * TIME_MS.DAY;
  const orgEvals = await readOrgEvaluations(backend, nowMs, maxDaysMs);

  const groupedByPeriod = new Map<Period, EvaluationsByName>();
  const periodCounts: string[] = [];
  for (const period of PERIODS.filter(p => PERIOD_MS[p] <= maxDaysMs)) {
    const start = new Date(nowMs - PERIOD_MS[period]);
    const evals = orgEvals.between(start.getTime());
    periodCounts.push(`${period}:${evals.length}`);
    const grouped = groupByMetric(evals);
    groupedByPeriod.set(period, grouped);
    entries.push(...computePeriodEntries(period, grouped, { start: start.toISOString(), end: now.toISOString() }));
  }

  entries.push({ key: CODE_QUALITY_KV_KEY, value: toKVValue(await computeCodeQuality(backend, now)) });

  const metricNames = Object.keys(QUALITY_METRICS);
  const metricDetail = computeMetricDetailEntries(groupedByPeriod, orgEvals, nowMs, metricNames);
  entries.push(...metricDetail.entries);
  entries.push(...computeEvaluationRowEntries(groupedByPeriod, metricNames));

  const trends = computeTrendEntries(groupedByPeriod, metricNames, now);
  entries.push(...trends.entries);
  entries.push(...computeDegradationEntries(
    trends.degradationBuckets, metricNames, now, options.degradationState ?? statelessDegradation(),
  ));

  if (options.calibrationEntry) entries.push(options.calibrationEntry);

  const queryWindowStartMs = nowMs - maxDaysMs;
  const allEvals = orgEvals.between(queryWindowStartMs);
  const evalsByTrace: Map<string, EvaluationResult[]> = group(allEvals.filter(hasTraceId), ev => ev.traceId);
  const traceIds = [...evalsByTrace.keys()];

  const allSpans = await backend.queryTraces({
    startDate: msToNs(queryWindowStartMs),
    endDate: msToNs(nowMs),
    limit: SPAN_QUERY_LIMIT,
  });
  const spansHitCap = allSpans.length >= SPAN_QUERY_LIMIT;
  if (spansHitCap) {
    console.warn(`${LOG_PREFIX} Span query returned ${SPAN_QUERY_LIMIT} results — data may be truncated`);
  }
  const spansByTrace: Map<string, TraceSpan[]> = group(allSpans.filter(hasTraceId), span => span.traceId);
  const traceEntries = buildTraceEntries(traceIds, evalsByTrace, spansByTrace);

  const { sessionEntries, agentEntries } = computeSessionAndAgentEntries(allSpans, allEvals, orgEvals.truncated, now);
  entries.push(...computeAgentStatsEntries(allSpans, orgEvals, now, maxDaysMs));

  return {
    allEntries: [...entries, ...sessionEntries, ...traceEntries, ...agentEntries],
    evalsByTrace,
    referencedTraceIds: metricDetail.referencedTraceIds,
    traceIds,
    evalCount: allEvals.length,
    spanCount: allSpans.length,
    periodCounts: periodCounts.join(' '),
    hitCap: orgEvals.truncated || spansHitCap,
  };
}
