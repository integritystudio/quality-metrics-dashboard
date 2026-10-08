#!/usr/bin/env tsx
/**
 * Sync pre-computed dashboard data to Cloudflare Workers KV.
 *
 * Reads local JSONL evaluations, runs quality-metrics computations,
 * and uploads results via `wrangler kv bulk put` (works with both
 * local OAuth session and CLOUDFLARE_API_TOKEN in CI).
 *
 * Rate-limited to stay under Cloudflare free-tier KV write limits
 * (1,000 writes/day). Uses content-hash delta sync to skip unchanged
 * entries and a per-run budget (default 450) with priority ordering:
 *   meta/dashboard/agent > metrics > trends > traces
 *
 * Usage: tsx scripts/sync-to-kv.ts [--days=30] [--dry-run] [--budget=450]
 */

import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CloudBackend, ALL_ORGS_SCOPE, queriedDateWindow } from '../../src/backends/cloud.js';
import { http1Fetch } from '../../src/lib/core/http1-fetch.js';
import {
  computeDashboardSummary,
  computeAggregations,
  getQualityMetric,
  QUALITY_METRICS,
} from '../../src/lib/quality/quality-metrics.js';
import { computeRoleView, computeMetricDetail } from '../../src/lib/quality/quality-views.js';
import { computePipelineView, computeCoverageMatrix } from '../../src/lib/quality/quality-visualization.js';
import type { MetricTrend } from '../../src/lib/quality/quality-constants.js';
import type { EvaluationResult, StepScore, TraceSpan } from '../../src/backends/index.js';
import { computeMetricDynamics, type MetricDynamics } from '../../src/lib/quality/qfe-dynamics.js';
import { computeCorrelationMatrix } from '../../src/lib/quality/qfe-correlation.js';
import {
  computeRollingDegradationSignals,
  loadDegradationState,
  saveDegradationState,
} from '../../src/lib/quality/qfe-backtest.js';
import {
  computePercentileDistribution,
  loadCalibrationState,
  type CalibrationState,
} from '../../src/lib/quality/qfe-percentiles.js';
import { CALIBRATION_STATE_FILE } from '../../src/lib/quality/quality-constants.js';
import { computeMultiAgentEvaluation } from '../../src/lib/quality/quality-multi-agent.js';
import { buildWorkflowGraph } from '../src/lib/workflow-graph.js';
import {
  CODE_EVENT,
  CODE_EVENT_ATTR,
  CODE_QUALITY_CHECKPOINT_LIMIT,
  CODE_QUALITY_INVOCATION_LIMIT,
  CODE_QUALITY_KV_KEY,
  CODE_QUALITY_LOOKBACK_DAYS,
  summarizeCodeQuality,
} from '../src/api/code-quality-summary.js';
import {
  kvSyncStateSchema,
  coverageHeatmapSchema,
  type KvSyncEntry,
  type CoverageHeatmap,
} from '../../src/lib/validation/dashboard-schemas.js';
import {
  loadJsonWithValidationSafe,
  loadJsonWithValidation,
  importMetaDirname,
} from '../src/lib/dashboard-file-utils.js';
import { PERIOD_MS, ROLES, DEFAULT_TOP_N, DEFAULT_BUCKET_COUNT, SCORE_DISPLAY_PRECISION, type Period } from '../src/lib/constants.js';
import { isSpanError, extractGitCommit } from '../src/api/session-detail.js';
import type { CalibrationResponse } from '../src/lib/validation/dashboard-schemas.js';
import { BYTES, PERCENT_MULTIPLIER, TIME_MS, NANOSECONDS_PER_MILLISECOND_BIGINT, SECONDS } from '../../src/lib/core/units.js';
import {
  FILE_ACCESS_TOP_N,
  SCORE_ROUND_FACTOR,
  LATENCY_P50,
  LATENCY_P95,
  LATENCY_DISPLAY_PRECISION,
  RATE_DISPLAY_PRECISION,
  HOOK_NAME,
  incrementCount,
  spanAttr,
  renamedAttr,
  gitRepositoryLabel,
  KV_SCHEMA_VERSION,
} from '../src/api/api-constants.js';
import { CANARY_EVALUATOR_TYPE, CANARY_COHORT, CALIBRATION_STATE_DIR } from './evaluation-constants.js';
import { ascending, extent, group, max, mean, min, minIndex, quantileSorted, rollup } from 'd3-array';
import { exitOnCliArgError, parseCli, positiveIntArg, runIfMain, type CliSpec } from './cli-args.js';
import { DRY_RUN_FLAG } from './pipeline-stages.js';

/** The literal `worker/index.ts` reads at GET /api/degradation-signals; keep the two in step. */
const DEGRADATION_KV_KEY = 'meta/dashboard/degradation-signals';

function resolveNamespaceId(): string {
  if (process.env.KV_NAMESPACE_ID) return process.env.KV_NAMESPACE_ID;
  // Fall back to wrangler.toml kv_namespaces[0].id
  const tomlPath = join(import.meta.dirname, '..', 'wrangler.toml');
  if (existsSync(tomlPath)) {
    const toml = readFileSync(tomlPath, 'utf8');
    const match = toml.match(/\[\[kv_namespaces\]\][\s\S]*?^id\s*=\s*"([^"]+)"/m);
    if (match) {
      const id = match[1];
      if (id) return id;
    }
  }
  throw new Error('KV_NAMESPACE_ID env var not set and could not resolve from wrangler.toml');
}
let namespaceId: string | undefined;
/** Resolved on first wrangler call, so importing this module or a dry run needs no namespace. */
function getNamespaceId(): string {
  return namespaceId ??= resolveNamespaceId();
}

const DEFAULT_DAYS = 30;
const DEFAULT_WRITE_BUDGET = 450;
const DEFAULT_MAX_WRITES_PER_RUN = 500;
const DAYS_FLAG = '--days';
const BUDGET_FLAG = '--budget';
const MAX_WRITES_FLAG = '--max-writes';
const SYNC_CLI: CliSpec = { values: [DAYS_FLAG, BUDGET_FLAG, MAX_WRITES_FLAG], switches: [DRY_RUN_FLAG] };

const { dryRun, maxDays, WRITE_BUDGET, MAX_WRITES_PER_RUN } = exitOnCliArgError('[sync-to-kv]', () => {
  const cli = parseCli(process.argv.slice(2), SYNC_CLI);
  return {
    dryRun: cli.has(DRY_RUN_FLAG),
    maxDays: positiveIntArg(DAYS_FLAG, cli.value(DAYS_FLAG)) ?? DEFAULT_DAYS,
    WRITE_BUDGET: positiveIntArg(BUDGET_FLAG, cli.value(BUDGET_FLAG)) ?? DEFAULT_WRITE_BUDGET,
    // Per-run write warning threshold: half the ~1000/day free-tier cap, matching
    // the twice-daily AlephAuto cron (P4 write-budget instrumentation).
    MAX_WRITES_PER_RUN: positiveIntArg(MAX_WRITES_FLAG, cli.value(MAX_WRITES_FLAG)) ?? DEFAULT_MAX_WRITES_PER_RUN,
  };
});
const MAX_DAYS_MS = maxDays * TIME_MS.DAY;

const PERIODS = ['24h', '7d', '30d'] as const;

const MAX_SESSION_DURATIONS = 10_000;
const MAX_AGENT_SESSIONS = 100;
const MAX_RECENT_SESSIONS = 20;

const META_LAST_SYNC_KEY = 'meta:lastSync';
const META_SYNC_COVERAGE_KEY = 'meta:syncCoverage';
const META_CALIBRATION_KEY = 'meta:calibration';
const META_AGENTS_KEY = 'meta:agents';
const TRACE_KEY_PREFIX = 'trace:';
const TRACE_EVALS_KEY_PREFIX = 'evaluations:trace:';
/** Hex chars of the sha256 kept as the delta-sync content hash. */
const HASH_PREFIX_CHARS = 16;
/** wrangler stderr markers for the KV free-tier daily write limit. */
const KV_WRITE_LIMIT_MARKERS = ['free usage limit', 'code: 10048'] as const;
const STDERR_SNIPPET_CHARS = 300;
const STDERR_DETAIL_CHARS = 500;
/** Coverage percentages keep two decimals. */
const COVERAGE_PERCENT_FACTOR = 100;
const COVERAGE_ROUND_SCALE = PERCENT_MULTIPLIER * COVERAGE_PERCENT_FACTOR;
/** Score assigned to traces with no evaluations, so they sort last. */
const UNEVALUATED_TRACE_SCORE = 1;
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
/** Global (never org-prefixed) heartbeat for the session-less /api/health route (P4/P5). */
export const SYSTEM_LAST_SYNC_KEY = 'system:lastSync';

/**
 * Org-scoping P4 (docs/roadmap/org-scoped-multi-tenancy.md). When HOME_ORG_ID
 * is set, the sync runs once per discovered org, prefixes every key with
 * `org:<orgId>:`, and DUAL-WRITES the legacy bare keys for the home org so the
 * read cutover (P7) can flip without a data migration. When unset, behavior is
 * byte-identical to the pre-tenancy sync (bare keys only) — the AlephAuto cron
 * keeps working unchanged until the env lands.
 */
const HOME_ORG_ID = process.env.HOME_ORG_ID ?? '';
export const ORG_KEY_PREFIX_RE = /^org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/i;

export function orgPrefixedKey(orgId: string, key: string): string {
  return `org:${orgId}:${key}`;
}

/** Strip an `org:<uuid>:` prefix so key-class checks see the logical key. */
export function stripOrgPrefix(key: string): string {
  return key.replace(ORG_KEY_PREFIX_RE, '');
}

export type KVEntry = { key: string; value: string; expirationTtl?: number };

/**
 * Serialize a KV entry value. Backend spans and evaluations carry `bigint`
 * timestamps (`startTimeUnixNano`, `endTimeUnixNano`, `timestamp`) that
 * `JSON.stringify` throws on; the replacer writes them in their decimal-string
 * wire form, which `timestampToMs` on the read side already accepts. Every KV
 * entry value must be built through this, never bare `JSON.stringify` — the
 * bigint-bearing types nest at varying depth (SYNC-KV-BIGINT). A replacer
 * rather than `jsonSafe`, which deep-copies the value before it is serialized.
 */
export function toKVValue(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
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

export const KV_BATCH_SIZE = 5_000; // reduced from 9,500 to avoid 502s on large syncs
/** Undefined under runners that don't provide import.meta.dirname (e.g. vitest transforms). */
const SCRIPT_DIR = importMetaDirname(import.meta);
const STATE_FILE = join(SCRIPT_DIR ?? '.', '.kv-sync-state.json');
/** Stores last computed coverage object so early-return path can refresh lastChecked. */
const COVERAGE_FILE = join(SCRIPT_DIR ?? '.', '.kv-sync-coverage.json');
const QUERY_LIMIT = 200_000;
/** Span queries need a higher limit than evaluation queries to capture all sessions. */
const SPAN_QUERY_LIMIT = 1_000_000;

/**
 * TTL for per-trace and per-session KV entries (seconds).
 * Must exceed the longest `--days` query window so entries are not prematurely expired.
 * 90 days is 3x the default 30-day window and prevents unbounded key accumulation.
 */
export const TRACE_KEY_TTL_SECONDS = SECONDS.DAY * 90;
export const SESSION_KEY_TTL_SECONDS = SECONDS.DAY * 90;

/** Minimum budget reserved for trace writes regardless of higher-priority entries */
export const MIN_TRACE_BUDGET = 100;
/** Budget headroom above MIN_TRACE_BUDGET for meta and dashboard entries before a warning. */
const HIGH_PRIORITY_HEADROOM = 10;
const RECOMMENDED_MIN_BUDGET = MIN_TRACE_BUDGET + HIGH_PRIORITY_HEADROOM;

const MAX_EVAL_ROWS = 200;
/** Metric detail compares the last week with the one before it, so the read spans at least two. */
const METRIC_DETAIL_WEEKS = 2;

function msToNs(ms: number): bigint {
  return BigInt(ms) * NANOSECONDS_PER_MILLISECOND_BIGINT;
}

const TREND_BUCKETS = 10;

/**
 * The home org's `meta:calibration` entry, from the state derive writes (`CALIBRATION_STATE_DIR`).
 * A missing file is reported loudly: a silent miss leaves the dashboard on stale percentiles
 * (CALIBRATION-READ-WRONG-DIR). An old `lastCalibrated` is not an error — derive rewrites the file only when the
 * score distribution drifts (PSI), so a stable corpus keeps its date — so it is logged, not judged.
 */
export function loadCalibrationEntry(dir: string = CALIBRATION_STATE_DIR): KVEntry | null {
  const state = loadCalibrationState(dir);
  if (!state) {
    console.warn(`[sync-to-kv] calibration: no ${CALIBRATION_STATE_FILE} in ${dir}; meta:calibration not written`);
    return null;
  }
  console.log(`[sync-to-kv] calibration: lastCalibrated=${state.lastCalibrated} (${dir})`);
  return buildCalibrationEntry(state);
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

const TRACE_PRIORITY_WEIGHTS = {
  worstScore: 0.5,   // lower score = higher priority
  recency: 0.3,      // newer = higher priority
  referencedByWorst: 0.2,  // linked from metric detail cards
} as const;

export interface BudgetAllocation {
  highPriorityBudget: number;
  traceBudget: number;
}

export function computeBudgetAllocation(
  highPriorityCount: number,
  writeBudget: number,
): BudgetAllocation {
  const budget = writeBudget - 1; // reserve 1 for meta:lastSync
  const highPriorityBudget = Math.max(0, Math.min(highPriorityCount, budget - MIN_TRACE_BUDGET));
  const rawTraceBudget = Math.max(0, budget - highPriorityBudget);
  // Round down to even so trace entry pairs (evaluations:trace:X + trace:X) are never split.
  const traceBudget = rawTraceBudget - (rawTraceBudget % 2);
  return { highPriorityBudget, traceBudget };
}

/**
 * In-memory form of the persisted `KvSyncState` record. A Map so that reads are
 * honestly `KvSyncEntry | undefined` (tsconfig.scripts.json lacks
 * noUncheckedIndexedAccess, under which a bare index read types as always-present).
 */
type SyncState = Map<string, KvSyncEntry>;

function loadSyncState(): SyncState {
  return new Map(Object.entries(loadJsonWithValidationSafe(STATE_FILE, kvSyncStateSchema, {})));
}

function saveSyncState(state: SyncState): void {
  writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(state)));
}

function loadLastCoverage(): CoverageHeatmap | null {
  try {
    return loadJsonWithValidation(COVERAGE_FILE, coverageHeatmapSchema);
  } catch {
    return null;
  }
}

function saveLastCoverage(coverage: CoverageHeatmap): void {
  writeFileSync(COVERAGE_FILE, JSON.stringify(coverage));
}

/** `part / whole` as a two-decimal percentage; an empty `whole` is full coverage. */
function coveragePercent(part: number, whole: number): number {
  return whole > 0
    ? Math.round(part / whole * COVERAGE_ROUND_SCALE) / COVERAGE_PERCENT_FACTOR
    : PERCENT_MULTIPLIER;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, HASH_PREFIX_CHARS);
}

function filterChanged(entries: KVEntry[], state: SyncState): KVEntry[] {
  return entries.filter(e => state.get(e.key)?.hash !== hashValue(e.value));
}

function kvBulkPut(entries: KVEntry[]): number {
  if (entries.length === 0) return 0;
  let written = 0;
  for (let i = 0; i < entries.length; i += KV_BATCH_SIZE) {
    const batch = entries.slice(i, i + KV_BATCH_SIZE);
    const batchLabel = entries.length > KV_BATCH_SIZE
      ? ` (batch ${Math.floor(i / KV_BATCH_SIZE) + 1}/${Math.ceil(entries.length / KV_BATCH_SIZE)})`
      : '';
    const tmpFile = join(tmpdir(), `kv-sync-${Date.now()}-${randomBytes(4).toString('hex')}-${i}.json`);
    try {
      const enveloped = batch.map(e => ({
        key: e.key,
        // `e.value` is already JSON (toKVValue), so the version envelope is spliced
        // around it as text; parsing and re-serializing gave the same bytes.
        value: `{"v":${JSON.stringify(KV_SCHEMA_VERSION)},"data":${e.value}}`,
        ...(e.expirationTtl != null ? { expiration_ttl: e.expirationTtl } : {}),
      }));
      writeFileSync(tmpFile, JSON.stringify(enveloped));
      if (dryRun) {
        written += batch.length;
        continue;
      }
      try {
        execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', tmpFile, '--namespace-id', getNamespaceId(), '--remote'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer } | null)?.stderr?.toString() ?? '';
        const stdout = (err as { stdout?: Buffer } | null)?.stdout?.toString() ?? '';
        if (KV_WRITE_LIMIT_MARKERS.some(m => stderr.includes(m))) {
          console.warn(`[sync-to-kv] KV write limit hit — ${batch.length} entries deferred. stderr: ${stderr.slice(0, STDERR_SNIPPET_CHARS)}`);
          return written;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync-to-kv] bulk put failed${batchLabel}: ${msg}`);
        if (stderr) console.error(`[sync-to-kv] stderr: ${stderr.slice(0, STDERR_DETAIL_CHARS)}`);
        if (stdout) console.error(`[sync-to-kv] stdout: ${stdout.slice(0, STDERR_DETAIL_CHARS)}`);
        throw new Error(`Wrangler KV bulk put failed for ${batch.length} entries${batchLabel}.`, { cause: err });
      }
      written += batch.length;
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }
  }
  return written;
}

/**
 * Delete a batch of KV keys via `wrangler kv bulk delete`.
 * Warns on failure but does not throw — prune passes are best-effort.
 *
 * @param keys - KV keys to delete
 * @param opts.dryRun - when true, logs instead of calling wrangler; defaults to the module-level dryRun flag
 */
export function kvBulkDelete(keys: string[], opts?: { dryRun?: boolean }): void {
  const isDryRun = opts?.dryRun ?? dryRun;
  if (keys.length === 0) return;
  for (let i = 0; i < keys.length; i += KV_BATCH_SIZE) {
    const batch = keys.slice(i, i + KV_BATCH_SIZE);
    const tmpFile = join(tmpdir(), `kv-delete-${Date.now()}-${randomBytes(4).toString('hex')}-${i}.json`);
    try {
      writeFileSync(tmpFile, JSON.stringify(batch));
      if (isDryRun) {
        console.log(`[sync-to-kv] dry-run: would delete ${batch.length} stale KV key(s)`);
        continue;
      }
      try {
        execFileSync(
          'npx',
          ['wrangler', 'kv', 'bulk', 'delete', tmpFile, '--namespace-id', getNamespaceId(), '--remote', '--force'],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (err) {
        const stderr = (err as { stderr?: Buffer } | null)?.stderr?.toString() ?? '';
        console.warn(
          `[sync-to-kv] bulk delete failed for ${batch.length} key(s): ` +
          `${err instanceof Error ? err.message : String(err)}` +
          (stderr ? ` — stderr: ${stderr.slice(0, STDERR_SNIPPET_CHARS)}` : ''),
        );
      }
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }
  }
}

function extractTraceId(key: string): string | null {
  // Org-prefixed and bare trace keys group under the same traceId, so a home-org
  // dual-written trace moves through the priority budget as one unit.
  const bare = stripOrgPrefix(key);
  if (bare.startsWith(TRACE_EVALS_KEY_PREFIX)) return bare.slice(TRACE_EVALS_KEY_PREFIX.length);
  if (bare.startsWith(TRACE_KEY_PREFIX)) return bare.slice(TRACE_KEY_PREFIX.length);
  return null;
}

interface TracePriorityScore {
  traceId: string;
  priority: number;
  worstScore: number;
  latestTimestamp: number;
  isReferencedByWorst: boolean;
}

export function prioritizeTraces(
  traceEntries: KVEntry[],
  evalsByTrace: Map<string, EvaluationResult[]>,
  referencedTraceIds: Set<string>,
): KVEntry[] {
  const now = Date.now();
  const thirtyDaysMs = PERIOD_MS['30d'];

  // each trace has 2 entries: evaluations:trace:X and trace:X
  const traceGroups = new Map<string, KVEntry[]>();
  let skippedCount = 0;
  for (const entry of traceEntries) {
    const traceId = extractTraceId(entry.key);
    if (!traceId) {
      skippedCount++;
      continue;
    }
    pushToGroup(traceGroups, traceId, entry);
  }
  if (skippedCount > 0) {
    console.warn(`[prioritizeTraces] Skipped ${skippedCount} entries with non-trace key format`);
  }

  const scored: TracePriorityScore[] = [];
  for (const [traceId] of traceGroups) {
    const evals = evalsByTrace.get(traceId) ?? [];

    const worstScore = min(evals.map(e => e.scoreValue).filter(isValidScore)) ?? UNEVALUATED_TRACE_SCORE;

    const timestamps = evals.map(e => Number(e.timestamp / NANOSECONDS_PER_MILLISECOND_BIGINT)).filter(Number.isFinite);
    const latestTimestamp = max(timestamps) ?? 0;

    const isReferencedByWorst = referencedTraceIds.has(traceId);

    const scoreComponent = (1 - worstScore) * TRACE_PRIORITY_WEIGHTS.worstScore;
    const recencyComponent = (latestTimestamp > 0
      ? Math.max(0, 1 - (now - latestTimestamp) / thirtyDaysMs)
      : 0) * TRACE_PRIORITY_WEIGHTS.recency;
    const referencedComponent = (isReferencedByWorst ? 1 : 0) * TRACE_PRIORITY_WEIGHTS.referencedByWorst;

    scored.push({
      traceId,
      priority: scoreComponent + recencyComponent + referencedComponent,
      worstScore,
      latestTimestamp,
      isReferencedByWorst,
    });
  }

  scored.sort((a, b) => b.priority - a.priority);

  const result: KVEntry[] = [];
  for (const { traceId } of scored) {
    const traceGroup = traceGroups.get(traceId);
    if (traceGroup) result.push(...traceGroup);
  }
  return result;
}

type SessionSpan = {
  name: string;
  traceId?: string;
  durationMs?: number;
  status?: { code?: number | string };
  attributes?: Record<string, unknown>;
};

function spanSessionId(span: { attributes?: Record<string, unknown> }): string | undefined {
  return (span.attributes?.['session.id'] ?? span.attributes?.['session_id']) as string | undefined;
}

function isValidScore(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/** Narrows to rows with a non-empty `traceId`, so `group` keys them by `string`. */
function hasTraceId<T extends { traceId?: string }>(row: T): row is T & { traceId: string } {
  return Boolean(row.traceId);
}

function pushToGroup<V>(map: Map<string, V[]>, key: string, value: V): void {
  let group = map.get(key);
  if (!group) map.set(key, group = []);
  group.push(value);
}

function computeDataSources(spans: SessionSpan[], evaluations: EvaluationResult[], evaluationsTruncated = false) {
  const traceIdSet = new Set<string>();
  for (const s of spans) {
    if (s.traceId) traceIdSet.add(s.traceId);
  }
  return {
    traces: { count: spans.length, traceIds: traceIdSet.size },
    logs: { count: 0 },
    evaluations: { count: evaluations.length, ...(evaluationsTruncated && { truncated: true }) },
    total: spans.length + evaluations.length,
  };
}

function computeTimespan(evaluations: EvaluationResult[]) {
  const [tsMin, tsMax] = extent(evaluations, ev => Number(ev.timestamp / NANOSECONDS_PER_MILLISECOND_BIGINT));
  return tsMin !== undefined ? {
    start: new Date(tsMin).toISOString(),
    end: new Date(tsMax).toISOString(),
    durationHours: +((tsMax - tsMin) / TIME_MS.HOUR).toFixed(1),
  } : null;
}

function computeSessionInfo(spans: SessionSpan[]) {
  const sessionStarts = spans.filter(s => spanAttr(s, 'integritystudio.hook.name', 'string') === HOOK_NAME.SESSION_START);
  const first = sessionStarts.at(0);
  if (!first) return null;
  const last = sessionStarts.at(-1) ?? first;
  return {
    projectName: renamedAttr(first, 'integritystudio.project.name', 'project.name', 'string') ?? 'unknown',
    workingDirectory: renamedAttr(first, 'process.working_directory', 'working.directory') ?? '',
    gitRepository: gitRepositoryLabel(first),
    gitBranch: spanAttr(first, 'vcs.ref.head.name', 'string') ?? '',
    nodeVersion: renamedAttr(first, 'process.runtime.version', 'node.version') ?? '',
    resumeCount: sessionStarts.length,
    initialMessageCount: renamedAttr(first, 'integritystudio.context.message_count', 'context.message_count', 'number') ?? 0,
    initialContextTokens: renamedAttr(first, 'integritystudio.context.estimated_tokens', 'context.estimated_tokens', 'number') ?? 0,
    finalMessageCount: renamedAttr(last, 'integritystudio.context.message_count', 'context.message_count', 'number') ?? 0,
    taskCount: renamedAttr(first, 'integritystudio.tasks.active', 'tasks.active', 'number') ?? 0,
    uncommittedAtStart: spanAttr(first, 'integritystudio.git.uncommitted', 'number') ?? 0,
  };
}

function computeTokenMetrics(spans: SessionSpan[]) {
  const tokenProgression = spans
    .filter(s => spanAttr(s, 'integritystudio.hook.name', 'string') === HOOK_NAME.TOKEN_METRICS)
    .map(s => ({
      messages: renamedAttr(s, 'integritystudio.tokens.messages', 'tokens.messages', 'number') ?? 0,
      inputTokens: renamedAttr(s, 'integritystudio.tokens.input', 'tokens.input', 'number') ?? 0,
      outputTokens: renamedAttr(s, 'integritystudio.tokens.output', 'tokens.output', 'number') ?? 0,
      cacheRead: renamedAttr(s, 'integritystudio.tokens.cache_read', 'tokens.cache_read', 'number') ?? 0,
      cacheCreation: renamedAttr(s, 'integritystudio.tokens.cache_creation', 'tokens.cache_creation', 'number') ?? 0,
      model: renamedAttr(s, 'integritystudio.tokens.model', 'tokens.model', 'string') ?? '',
    }))
    .sort((a, b) => a.messages - b.messages);

  const tokenTotals = {
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0, messages: 0,
    models: {} as Record<string, number>,
  };
  for (const t of tokenProgression) {
    tokenTotals.input += t.inputTokens;
    tokenTotals.output += t.outputTokens;
    tokenTotals.cacheRead += t.cacheRead;
    tokenTotals.cacheCreation += t.cacheCreation;
    tokenTotals.messages += t.messages;
    if (t.model) incrementCount(tokenTotals.models, t.model);
  }
  return { tokenProgression, tokenTotals };
}

function computeUsageCounts(spans: SessionSpan[]) {
  const toolUsage: Record<string, number> = {};
  const mcpUsage: Record<string, number> = {};
  for (const s of spans) {
    const trigger = spanAttr(s, 'integritystudio.hook.trigger', 'string');
    if (trigger !== 'PostToolUse') continue;
    const type = spanAttr(s, 'integritystudio.hook.type', 'string');
    if (type === 'builtin') {
      incrementCount(toolUsage, spanAttr(s, 'gen_ai.tool.name', 'string') ?? 'unknown');
    } else if (type === 'mcp') {
      incrementCount(mcpUsage, renamedAttr(s, 'integritystudio.mcp.tool', 'mcp.tool', 'string') ?? 'unknown');
    }
  }
  return { toolUsage, mcpUsage };
}

function computeSpanLatency(spans: SessionSpan[]) {
  const spanBreakdown = Object.fromEntries(rollup(spans, group => group.length, s => s.name));
  const hookDurations = rollup(
    spans.filter(s => (s.durationMs ?? 0) > 0),
    group => group.map(s => s.durationMs ?? 0).sort(ascending),
    s => s.name,
  );
  const hookLatency: Record<string, { count: number; avg: number; p50: number; p95: number; max: number }> = {};
  for (const [name, sorted] of hookDurations) {
    hookLatency[name] = {
      count: sorted.length,
      avg: +(mean(sorted) ?? 0).toFixed(LATENCY_DISPLAY_PRECISION),
      p50: +(quantileSorted(sorted, LATENCY_P50 / PERCENT_MULTIPLIER) ?? 0).toFixed(LATENCY_DISPLAY_PRECISION),
      p95: +(quantileSorted(sorted, LATENCY_P95 / PERCENT_MULTIPLIER) ?? 0).toFixed(LATENCY_DISPLAY_PRECISION),
      max: +(sorted[sorted.length - 1] ?? 0).toFixed(LATENCY_DISPLAY_PRECISION),
    };
  }
  return { spanBreakdown, hookLatency };
}

function computeErrorSummary(spans: SessionSpan[]) {
  const byCategory: Record<string, number> = {};
  const details: Array<{ spanName: string; tool?: string; errorType?: string; filePath?: string }> = [];
  for (const s of spans) {
    if (!isSpanError(s)) continue;
    const tool = spanAttr(s, 'gen_ai.tool.name', 'string') ?? spanAttr(s, 'integritystudio.agent.type', 'string') ?? 'unknown';
    const errType = spanAttr(s, 'integritystudio.tool.error_type', 'string') ?? 'unknown';
    incrementCount(byCategory, `${tool} -> ${errType}`);
    details.push({
      spanName: s.name,
      tool,
      errorType: errType,
      filePath: spanAttr(s, 'file.path', 'string'),
    });
  }
  return { byCategory, details };
}

interface AgentActivityEntry {
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

function summarizeAgentSpans(group: SessionSpan[]) {
  const a = {
    invocations: 0, errors: 0, hasRateLimit: false, rateLimitEvents: 0,
    totalOutputSize: 0, durationSum: 0, durationCount: 0,
    truncatedCount: 0, emptyCount: 0,
  };
  for (const s of group) {
    a.invocations++;
    if (spanAttr(s, 'integritystudio.agent.has_error', 'boolean')) a.errors++;
    if (spanAttr(s, 'integritystudio.agent.has_rate_limit', 'boolean')) {
      a.hasRateLimit = true;
      a.rateLimitEvents++;
    }
    a.totalOutputSize += spanAttr(s, 'integritystudio.agent.output_size', 'number') ?? 0;
    const dur = s.durationMs ?? 0;
    if (dur > 0) { a.durationSum += dur; a.durationCount++; }
    if (spanAttr(s, 'integritystudio.agent.output.truncated', 'boolean')) a.truncatedCount++;
    if (spanAttr(s, 'integritystudio.agent.output.empty', 'boolean')) a.emptyCount++;
  }
  return a;
}

function computeAgentActivity(spans: SessionSpan[]): AgentActivityEntry[] {
  const byAgent = rollup(
    spans.filter(s => spanAttr(s, 'integritystudio.hook.name', 'string') === HOOK_NAME.AGENT_FINALIZE),
    summarizeAgentSpans,
    s => spanAttr(s, 'gen_ai.agent.name', 'string') ?? 'unknown',
  );
  return Array.from(byAgent, ([agentName, d]) => ({
    agentName,
    invocations: d.invocations,
    errors: d.errors,
    hasRateLimit: d.hasRateLimit,
    rateLimitEvents: d.rateLimitEvents,
    totalOutputSize: d.totalOutputSize,
    avgOutputSize: d.invocations > 0 ? Math.round(d.totalOutputSize / d.invocations) : 0,
    avgDurationMs: d.durationCount > 0 ? Math.round(d.durationSum / d.durationCount) : 0,
    truncatedCount: d.truncatedCount,
    emptyCount: d.emptyCount,
  }));
}

function computeEvalBreakdown(evaluations: EvaluationResult[]) {
  const evalByName = rollup(
    evaluations,
    group => ({ count: group.length, scores: group.map(ev => ev.scoreValue).filter(isValidScore) }),
    ev => ev.evaluationName,
  );
  return Array.from(evalByName, ([name, d]) => {
    const sorted = d.scores.sort((a, b) => a - b);
    const avg = mean(sorted);
    return {
      name,
      count: d.count,
      avg: avg != null ? +avg.toFixed(SCORE_DISPLAY_PRECISION) : null,
      min: sorted.length > 0 ? +(sorted[0] ?? 0).toFixed(SCORE_DISPLAY_PRECISION) : null,
      max: sorted.length > 0 ? +(sorted[sorted.length - 1] ?? 0).toFixed(SCORE_DISPLAY_PRECISION) : null,
    };
  });
}

export function computeSessionDetail(
  sessionId: string,
  spans: SessionSpan[],
  evaluations: EvaluationResult[],
  /** When the global evaluation read was cut at QUERY_LIMIT, every session is marked partial. */
  evaluationsTruncated = false,
) {
  const dataSources = computeDataSources(spans, evaluations, evaluationsTruncated);
  const timespan = computeTimespan(evaluations);
  const sessionInfo = computeSessionInfo(spans);
  const { tokenProgression, tokenTotals } = computeTokenMetrics(spans);
  const { toolUsage, mcpUsage } = computeUsageCounts(spans);
  const { spanBreakdown, hookLatency } = computeSpanLatency(spans);
  const errors = computeErrorSummary(spans);
  const agentActivity = computeAgentActivity(spans);
  const evaluationBreakdown = computeEvalBreakdown(evaluations);

  const fileCount: Record<string, number> = {};
  for (const s of spans) {
    const fp = spanAttr(s, 'file.path', 'string');
    if (fp) incrementCount(fileCount, fp);
  }
  const fileAccess = Object.entries(fileCount)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, FILE_ACCESS_TOP_N);

  const gitCommits = spans
    .filter(s => spanAttr(s, 'integritystudio.hook.name', 'string') === HOOK_NAME.POST_COMMIT_REVIEW)
    .flatMap(s => {
      const commit = extractGitCommit(s);
      return commit ? [commit] : [];
    });

  const alertSpans = spans.filter(s => spanAttr(s, 'integritystudio.hook.name', 'string') === HOOK_NAME.ALERT_EVALUATION);
  const alertSummary = {
    totalFired: alertSpans.reduce((sum, s) => sum + (renamedAttr(s, 'integritystudio.alerts.triggered_count', 'alerts.triggered_count', 'number') ?? 0), 0),
    stopEvents: alertSpans.length,
  };

  const codeStructure = spans
    .filter(s => spanAttr(s, 'integritystudio.hook.name', 'string') === HOOK_NAME.CODE_STRUCTURE)
    .map(s => ({
      file: spanAttr(s, 'integritystudio.code.structure.file', 'string') ?? '',
      lines: spanAttr(s, 'integritystudio.code.structure.lines', 'number') ?? 0,
      exports: spanAttr(s, 'integritystudio.code.structure.exports', 'number') ?? 0,
      functions: spanAttr(s, 'integritystudio.code.structure.functions', 'number') ?? 0,
      hasTypes: spanAttr(s, 'integritystudio.code.structure.has_types', 'boolean') ?? false,
      score: spanAttr(s, 'integritystudio.code.structure.score', 'number') ?? 0,
      tool: spanAttr(s, 'integritystudio.code.structure.tool', 'string') ?? '',
    }));

  const agentMapForEval = new Map<number, string>();
  spans.forEach((span, i) => {
    // Hooks emit the semconv 'gen_ai.agent.name'; 'agent.name' is the pre-OBP7b
    // spelling. Reading only the latter left every turn unattributed, so every
    // precomputed workflow graph had zero nodes. Mirrors src/api/routes/agents.ts.
    const agent = spanAttr(span, 'gen_ai.agent.name', 'string') ?? spanAttr(span, 'agent.name', 'string');
    if (agent) agentMapForEval.set(i, agent);
  });
  const stepScores: StepScore[] = spans.map((span, i) => ({
    step: i,
    score: spanAttr(span, 'evaluation.score', 'number')
      ?? (isSpanError(span) ? 0 : 1),
    explanation: span.name,
  }));
  const multiAgentEvaluation = computeMultiAgentEvaluation(stepScores, agentMapForEval);

  return {
    sessionId,
    dataSources,
    timespan,
    sessionInfo,
    tokenTotals,
    tokenProgression,
    toolUsage,
    mcpUsage,
    spanBreakdown,
    hookLatency,
    errors,
    agentActivity,
    fileAccess,
    gitCommits,
    alertSummary,
    codeStructure,
    evaluationBreakdown,
    logSummary: { bySeverity: {} as Record<string, number>, logs: [] },
    multiAgentEvaluation,
    evaluations,
  };
}

/**
 * Enumerate org ids with cloud rows in the query window (P4). Uses the
 * env-gated all-orgs scope; when the deployed obtool-api rejects it
 * (ALLOW_ALL_ORGS_SCOPE unset → 403), falls back to the home org alone so the
 * sync keeps working before that env flip lands. An org with zero evaluations
 * gets no KV keys — its dashboard correctly serves no_data.
 */
async function discoverOrgIds(now: Date): Promise<string[]> {
  const ids = new Set<string>([HOME_ORG_ID]);
  try {
    const probe = new CloudBackend({ orgId: ALL_ORGS_SCOPE, fetch: http1Fetch });
    const start = new Date(now.getTime() - MAX_DAYS_MS);
    const evals = await probe.queryEvaluations({
      startDate: BigInt(start.getTime()) * NANOSECONDS_PER_MILLISECOND_BIGINT,
      endDate: BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND_BIGINT,
      limit: QUERY_LIMIT,
    });
    for (const ev of evals) {
      if (ev.orgId) ids.add(ev.orgId);
    }
  } catch (err) {
    console.warn(
      '[sync-to-kv] all-orgs enumeration unavailable — syncing HOME org only. ' +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return [...ids];
}

interface OrgComputation {
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
      expirationTtl: TRACE_KEY_TTL_SECONDS,
    });
    traceEntries.push({
      key: `${TRACE_KEY_PREFIX}${traceId}`,
      value: toKVValue({ traceId, spans, evaluations: traceEvals }),
      expirationTtl: TRACE_KEY_TTL_SECONDS,
    });
  }
  return traceEntries;
}

/**
 * The Agent Code Quality page's data. The Worker has no live query path, so
 * this KV key is the only way `/api/code-quality` reaches production; the dev
 * API route computes the same summary from a live query.
 */
async function computeCodeQuality(backend: CloudBackend, now: Date) {
  const startDate = BigInt(now.getTime() - CODE_QUALITY_LOOKBACK_DAYS * TIME_MS.DAY) * NANOSECONDS_PER_MILLISECOND_BIGINT;
  const endDate = BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND_BIGINT;
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
    console.warn(`[sync-to-kv] Code-quality checkpoint query hit ${CODE_QUALITY_CHECKPOINT_LIMIT} — oldest checkpoints dropped`);
  }
  return summarizeCodeQuality(checkpointSpans, invocationSpans);
}

/**
 * Run the full aggregation for one org's cloud rows. The only org-aware behavior
 * is that the local sidecar state (degradation breaches, calibration) is
 * owner-local and therefore read/written for the home org alone.
 */
async function computeOrgEntries(backend: CloudBackend, now: Date, isHome: boolean): Promise<OrgComputation> {
  const entries: KVEntry[] = [];

  const groupedByPeriod = new Map<string, Map<string, EvaluationResult[]>>();
  const nowMs = now.getTime();
  const weekMs = PERIOD_MS['7d'];

  // One read serves every window below: the periods, both metric-detail weeks and the
  // session/trace window. Separate reads fetched the same rows up to 22 times per org.
  // One extra row detects truncation (KV-SESSION-EVALS-TRUNCATION-UNFLAGGED); the server
  // returns the newest ids first, so a truncated read loses the oldest rows.
  const fetched = await backend.queryEvaluations({
    startDate: msToNs(nowMs - Math.max(MAX_DAYS_MS, METRIC_DETAIL_WEEKS * weekMs)),
    endDate: msToNs(nowMs),
    limit: QUERY_LIMIT + 1,
  });
  const evaluationsTruncated = fetched.length > QUERY_LIMIT;
  const fetchedEvals = evaluationsTruncated ? fetched.slice(0, QUERY_LIMIT) : fetched;
  if (evaluationsTruncated) {
    console.warn(
      `[sync-to-kv] Evaluation query returned ${QUERY_LIMIT} results — oldest evaluations dropped; all sessions marked partial`,
    );
  }
  /** The rows a separate `[startMs, endMs]` read would return; the server rounds both bounds to whole UTC days. */
  const evalsBetween = (startMs: number, endMs: number = nowMs): EvaluationResult[] => {
    const { startNs = 0n, endNs = 0n } = queriedDateWindow({ startDate: msToNs(startMs), endDate: msToNs(endMs) });
    return fetchedEvals.filter(ev => ev.timestamp >= startNs && ev.timestamp < endNs);
  };

  const activePeriods = PERIODS.filter(p => PERIOD_MS[p] <= MAX_DAYS_MS);
  const periodQueryResults = activePeriods.map(period => {
    const start = new Date(nowMs - PERIOD_MS[period]);
    const dates = { start: start.toISOString(), end: now.toISOString() };
    return { period, evals: evalsBetween(start.getTime()), dates };
  });

  for (const { period, evals, dates } of periodQueryResults) {
    const grouped = group(filterCanary(evals), ev => ev.evaluationName);
    groupedByPeriod.set(period, grouped);

    // `dates` is already `{ start, end }` ISO — a `TimeRange`.
    const dashboard = computeDashboardSummary(grouped, { period: dates });
    entries.push({ key: `dashboard:${period}`, value: toKVValue(dashboard) });

    for (const role of ROLES) {
      const view = computeRoleView(dashboard, role);
      entries.push({ key: `dashboard:${period}:${role}`, value: toKVValue(view) });
    }

    const metricTimeSeries = new Map<string, number[]>();
    const corrMetricNames: string[] = [];
    for (const [name, metricEvals] of grouped) {
      metricTimeSeries.set(name, metricEvals.map(e => e.scoreValue).filter(isValidScore));
      corrMetricNames.push(name);
    }
    const correlations = computeCorrelationMatrix(metricTimeSeries);
    entries.push({
      key: `correlations:${period}`,
      value: toKVValue({ correlations, metrics: corrMetricNames }),
    });

    // Columnar, never the dense metric x input cell list: that shape repeats the
    // metric name and a 32-36 char input id in every cell (and the ids again in
    // `gaps`), reaching 112 MB at the ~85,000-input cardinality that breached
    // KV's 25 MiB value limit and disabled this feature in February 2026 (CVG-1).
    // The columnar matrix measures 4.68 MB for that same case. Sizes and the
    // rejected compression alternatives: `CoverageMatrix` in quality-visualization.ts.
    for (const inputKey of COVERAGE_INPUT_KEYS) {
      const matrix = computeCoverageMatrix(grouped, { inputKey, maxInputs: MAX_COVERAGE_COLUMNS });
      const coverageKey = `coverage:${period}:${inputKey}`;
      const coverageValue = toKVValue({ period, ...matrix });
      const coverageSizeBytes = Buffer.byteLength(coverageValue, 'utf8');
      if (coverageSizeBytes > KV_VALUE_WARN_BYTES) {
        console.warn(
          `[sync-to-kv] ${coverageKey} is ${Math.round(coverageSizeBytes / BYTES.KB)} KB,` +
          ` over ${KV_VALUE_WARN_RATIO * PERCENT_MULTIPLIER}% of KV's ${KV_VALUE_LIMIT_BYTES / BYTES.MB} MiB value limit` +
          ' — reduce MAX_COVERAGE_COLUMNS',
        );
      }
      entries.push({ key: coverageKey, value: coverageValue });
    }

    const pipeline = computePipelineView(grouped, dashboard);
    entries.push({
      key: `pipeline:${period}`,
      value: toKVValue({ period, ...pipeline }),
    });
  }

  entries.push({ key: CODE_QUALITY_KV_KEY, value: toKVValue(await computeCodeQuality(backend, now)) });

  const metricNames = Object.keys(QUALITY_METRICS);
  const currentWeek = group(filterCanary(evalsBetween(nowMs - weekMs)), ev => ev.evaluationName);
  const previousWeek = group(filterCanary(evalsBetween(nowMs - 2 * weekMs, nowMs - weekMs)), ev => ev.evaluationName);
  /** Trace ids the metric cards link to, which the trace write budget favours. */
  const referencedTraceIds = new Set<string>();

  for (const name of metricNames) {
    const config = getQualityMetric(name);
    const evals = currentWeek.get(name);
    if (!config || !evals) continue;

    const prevScores = (previousWeek.get(name) ?? []).map(e => e.scoreValue).filter(isValidScore);
    const previousValues = prevScores.length > 0
      ? computeAggregations(prevScores, config.aggregations)
      : undefined;

    const detail = computeMetricDetail(evals, config, {
      topN: DEFAULT_TOP_N,
      bucketCount: DEFAULT_BUCKET_COUNT,
      previousValues,
    });
    for (const w of detail.worstEvaluations) {
      if (w.traceId) referencedTraceIds.add(w.traceId);
    }
    entries.push({ key: `metric:${name}`, value: toKVValue(detail) });
  }

  for (const period of activePeriods) {
    const grouped = groupedByPeriod.get(period);
    if (!grouped) continue;
    for (const name of metricNames) {
      const evals = grouped.get(name);
      if (!evals || evals.length === 0) continue;
      const sorted = [...evals].sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
      const rows = sorted.slice(0, MAX_EVAL_ROWS).map(e => ({
        score: e.scoreValue ?? 0,
        explanation: e.explanation,
        traceId: e.traceId,
        timestamp: e.timestamp,
        evaluator: e.evaluator,
        label: e.scoreLabel,
        evaluatorType: e.evaluatorType,
        evaluatorKind: e.evaluatorKind,
        cohort: e.cohort,
        spanId: e.spanId,
        sessionId: e.sessionId,
        agentName: e.agentName,
        trajectoryLength: e.trajectoryLength,
        stepScores: e.stepScores,
        toolVerifications: e.toolVerifications,
      }));
      entries.push({
        key: `metric:evaluations:${name}:${period}`,
        value: toKVValue({ rows }),
      });
    }
  }

  // Collect time buckets per period×metric for degradation signal computation
  const degradationBuckets = new Map<Period, Record<string, Array<{ scores: number[]; startTime: string; endTime: string }>>>();
  for (const period of activePeriods) {
    const ms = PERIOD_MS[period];
    const cached = groupedByPeriod.get(period);
    if (!cached) continue;
    const start = new Date(now.getTime() - ms);
    const bucketMs = ms / TREND_BUCKETS;

    for (const name of metricNames) {
      const config = getQualityMetric(name);
      if (!config) continue;
      const evaluations = cached.get(name) ?? [];

      const timeBuckets: Array<{ startTime: string; endTime: string; scores: number[]; evals: EvaluationResult[] }> = [];
      for (let i = 0; i < TREND_BUCKETS; i++) {
        const bStart = new Date(start.getTime() + i * bucketMs);
        const bEnd = new Date(start.getTime() + (i + 1) * bucketMs);
        timeBuckets.push({ startTime: bStart.toISOString(), endTime: bEnd.toISOString(), scores: [], evals: [] });
      }
      for (const ev of evaluations) {
        const ts = Number(ev.timestamp / NANOSECONDS_PER_MILLISECOND_BIGINT);
        const idx = Math.min(Math.floor((ts - start.getTime()) / bucketMs), TREND_BUCKETS - 1);
        const tb = timeBuckets[idx];
        if (idx >= 0 && tb && isValidScore(ev.scoreValue)) {
          tb.scores.push(ev.scoreValue);
          tb.evals.push(ev);
        }
      }

      // Save buckets for degradation signal computation
      let degradBucket = degradationBuckets.get(period);
      if (!degradBucket) degradationBuckets.set(period, degradBucket = {});
      degradBucket[name] = timeBuckets.map(b => ({
        scores: b.scores,
        startTime: b.startTime,
        endTime: b.endTime,
      }));

      const periodHours = ms / (TREND_BUCKETS * TIME_MS.HOUR);
      let previousTrend: MetricTrend | undefined;
      const trendData = timeBuckets.map((bucket, idx) => {
        const { scores } = bucket;
        const percentiles = computePercentileDistribution(scores);
        const avg = mean(scores);
        const prevBucket = idx > 0 ? timeBuckets[idx - 1] : undefined;
        const previousValues = (prevBucket && prevBucket.scores.length > 0)
          ? computeAggregations(prevBucket.scores, config.aggregations)
          : undefined;
        const detail = scores.length > 0
          ? computeMetricDetail(bucket.evals, config, { topN: 0, bucketCount: 0, previousValues })
          : undefined;
        let dynamics: MetricDynamics | undefined;
        if (detail?.trend) {
          dynamics = computeMetricDynamics(detail.trend, periodHours, { previousTrend });
          previousTrend = detail.trend;
        }
        return {
          startTime: bucket.startTime,
          endTime: bucket.endTime,
          count: scores.length,
          avg: avg != null ? Math.round(avg * SCORE_ROUND_FACTOR) / SCORE_ROUND_FACTOR : null,
          percentiles,
          trend: detail?.trend ?? null,
          dynamics: dynamics ?? null,
        };
      });

      const allScores = evaluations
        .map(e => e.scoreValue)
        .filter(isValidScore);

      entries.push({
        key: `trend:${name}:${period}`,
        value: toKVValue({
          metric: name,
          period,
          bucketCount: TREND_BUCKETS,
          totalEvaluations: allScores.length,
          overallPercentiles: computePercentileDistribution(allScores),
          trendData,
        }),
      });
    }
  }

  // Compute degradation signals for all periods
  // Degradation state is this script's own sidecar, so it lives beside the script. Calibration
  // is derive's, read from where derive writes it (loadCalibrationEntry). Both are the owner's
  // single-tenant history — non-home orgs compute signals statelessly (no cross-run breach
  // continuity) and skip calibration.
  const stateDir = isHome ? (SCRIPT_DIR ?? '') : '';
  const degradationState = stateDir ? loadDegradationState(stateDir) : { lastRun: '', breaches: {} };
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
  if (stateDir && !dryRun) saveDegradationState(stateDir, degradationState);

  const calibrationEntry = isHome ? loadCalibrationEntry() : null;
  if (calibrationEntry) entries.push(calibrationEntry);

  const queryWindowStart = new Date(now.getTime() - MAX_DAYS_MS);
  const allEvals = evalsBetween(queryWindowStart.getTime());
  const evalsByTrace: Map<string, EvaluationResult[]> = group(allEvals.filter(hasTraceId), ev => ev.traceId);
  const traceIds = [...evalsByTrace.keys()];

  const allSpans = await backend.queryTraces({
    startDate: BigInt(queryWindowStart.getTime()) * NANOSECONDS_PER_MILLISECOND_BIGINT,
    endDate: BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND_BIGINT,
    limit: SPAN_QUERY_LIMIT,
  });
  if (allSpans.length === SPAN_QUERY_LIMIT) {
    console.warn(`[sync-to-kv] Span query returned ${SPAN_QUERY_LIMIT} results — data may be truncated`);
  }
  const spansByTrace: Map<string, TraceSpan[]> = group(allSpans.filter(hasTraceId), span => span.traceId);

  const traceEntries = buildTraceEntries(traceIds, evalsByTrace, spansByTrace);

  type Span = (typeof allSpans)[number];
  const spansBySession = new Map<string, Span[]>();
  const traceToSession = new Map<string, string>();
  for (const span of allSpans) {
    const sid = spanSessionId(span);
    if (!sid) continue;
    pushToGroup(spansBySession, sid, span);
    if (span.traceId) traceToSession.set(span.traceId, sid);
  }
  const evalsBySession = new Map<string, EvaluationResult[]>();
  for (const ev of allEvals) {
    if (!ev.traceId) continue;
    const sid = traceToSession.get(ev.traceId);
    if (!sid) continue;
    pushToGroup(evalsBySession, sid, ev);
  }

  const agentCrossSession = new Map<string, AgentAccumulator>();

  const sessionEntries: KVEntry[] = [];
  for (const [sessionId, sessionSpans] of spansBySession) {
    const evaluations = evalsBySession.get(sessionId) ?? [];
    const detail = computeSessionDetail(sessionId, sessionSpans, evaluations, evaluationsTruncated);
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
      expirationTtl: SESSION_KEY_TTL_SECONDS,
    });

    for (const ag of detail.agentActivity) {
      let acc = agentCrossSession.get(ag.agentName);
      if (!acc) {
        acc = {
          totalInvocations: 0, totalErrors: 0, rateLimitEvents: 0,
          totalOutputSize: 0, weightedDurationSum: 0, sessionDurations: [],
          truncatedCount: 0, emptyCount: 0,
          totalSessionCount: 0, lastSeenDate: null, sessions: [],
        };
        agentCrossSession.set(ag.agentName, acc);
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
      if (acc.sessions.length < MAX_AGENT_SESSIONS) {
        acc.sessions.push(entry);
      } else if (sessionDate) {
        // Evict oldest to keep the most recent sessions in the buffer; when no
        // buffered session has a date, the last slot is replaced.
        const datedIdx = minIndex(acc.sessions, s => s.date);
        const oldestIdx = datedIdx >= 0 ? datedIdx : acc.sessions.length - 1;
        const oldestDate = acc.sessions[oldestIdx]?.date;
        if (!oldestDate || sessionDate > oldestDate) {
          acc.sessions[oldestIdx] = entry;
        }
      }
    }
  }

  const agentEntries: KVEntry[] = [];
  const agentSummaryList: Array<{
    agentName: string; totalSessions: number; totalInvocations: number;
    errorRate: number; lastSeen: string | null;
  }> = [];
  const computedAt = now.toISOString();

  for (const [agentName, acc] of agentCrossSession) {
    // ISO 8601 sorts lexicographically — take most recent sessions first
    const sessions = acc.sessions
      .slice()
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      .slice(0, MAX_RECENT_SESSIONS);
    const lastSeen = acc.lastSeenDate;
    const totalSessions = acc.totalSessionCount;
    const sortedSessionDurations = acc.sessionDurations.slice().sort((a, b) => a - b);

    const detail = {
      agentName,
      totalSessions,
      totalInvocations: acc.totalInvocations,
      totalErrors: acc.totalErrors,
      errorRate: acc.totalInvocations > 0 ? +(acc.totalErrors / acc.totalInvocations).toFixed(RATE_DISPLAY_PRECISION) : 0,
      rateLimitEvents: acc.rateLimitEvents,
      avgOutputSize: acc.totalInvocations > 0 ? Math.round(acc.totalOutputSize / acc.totalInvocations) : 0,
      avgDurationMs: acc.totalInvocations > 0
        ? Math.round(acc.weightedDurationSum / acc.totalInvocations)
        : 0,
      p95DurationMs: sortedSessionDurations.length > 0 ? Math.round(quantileSorted(sortedSessionDurations, LATENCY_P95 / PERCENT_MULTIPLIER) ?? 0) : 0,
      truncatedRate: acc.totalInvocations > 0 ? +(acc.truncatedCount / acc.totalInvocations).toFixed(RATE_DISPLAY_PRECISION) : 0,
      emptyOutputRate: acc.totalInvocations > 0 ? +(acc.emptyCount / acc.totalInvocations).toFixed(RATE_DISPLAY_PRECISION) : 0,
      lastSeen,
      computedAt,
      sessions,
    };

    agentEntries.push({ key: `agent:${agentName}`, value: toKVValue(detail) });
    agentSummaryList.push({
      agentName,
      totalSessions,
      totalInvocations: acc.totalInvocations,
      errorRate: detail.errorRate,
      lastSeen,
    });
  }

  agentSummaryList.sort((a, b) => b.totalInvocations - a.totalInvocations);
  agentEntries.push({ key: META_AGENTS_KEY, value: toKVValue(agentSummaryList) });

  return {
    allEntries: [...entries, ...sessionEntries, ...traceEntries, ...agentEntries],
    evalsByTrace,
    referencedTraceIds,
    traceIds,
    evalCount: allEvals.length,
    spanCount: allSpans.length,
    periodCounts: periodQueryResults.map(r => `${r.period}:${r.evals.length}`).join(' '),
    hitCap: evaluationsTruncated ||
      allSpans.length >= SPAN_QUERY_LIMIT,
  };
}

async function main(): Promise<void> {
  if (!CloudBackend.isConfigured()) {
    console.error('[sync-to-kv] CloudBackend is not configured. Set OBTOOL_API_URL and OBTOOL_API_KEY env vars.');
    process.exit(1);
  }
  if (WRITE_BUDGET < RECOMMENDED_MIN_BUDGET) {
    console.warn(`[sync-to-kv] --budget=${WRITE_BUDGET} is below recommended minimum (${RECOMMENDED_MIN_BUDGET}); high-priority entries may be skipped`);
  }
  console.log(
    `[sync-to-kv] Starting run${dryRun ? ' (dry-run)' : ''} budget=${WRITE_BUDGET} days=${maxDays}` +
    (HOME_ORG_ID ? ` orgScoping=on home=${HOME_ORG_ID}` : ' orgScoping=off (HOME_ORG_ID unset — legacy bare keys only)'),
  );

  const now = new Date();

  // Org-scoping P4: null = pre-tenancy legacy mode (bare keys, single default-scope
  // query). With HOME_ORG_ID set, each discovered org is computed under its own
  // server-side scope; the home org's entries are dual-written (bare + prefixed).
  const orgIds: Array<string | null> = HOME_ORG_ID ? await discoverOrgIds(now) : [null];

  const allEntries: KVEntry[] = [];
  const evalsByTrace = new Map<string, EvaluationResult[]>();
  const referencedTraceIds = new Set<string>();
  let homeComputation: OrgComputation | null = null;
  const perOrgSummaries: string[] = [];

  for (const orgId of orgIds) {
    const backend = new CloudBackend({ ...(orgId ? { orgId } : {}), fetch: http1Fetch });
    const isHome = orgId === null || orgId === HOME_ORG_ID;
    const res = await computeOrgEntries(backend, now, isHome);
    if (isHome) homeComputation = res;
    perOrgSummaries.push(
      `${orgId ?? 'legacy'}: entries=${res.allEntries.length} evals=${res.evalCount} spans=${res.spanCount} periods=[${res.periodCounts}]` +
      (res.hitCap ? ' CAP-HIT' : ''),
    );

    for (const e of res.allEntries) {
      if (orgId) allEntries.push({ ...e, key: orgPrefixedKey(orgId, e.key) });
      // Dual-write: the home org (and legacy mode) also emits the bare key so
      // pre-cutover readers keep serving identical content. P8 removes this arm.
      if (isHome) allEntries.push(e);
    }
    for (const [traceId, evals] of res.evalsByTrace) {
      const existing = evalsByTrace.get(traceId);
      if (existing) existing.push(...evals);
      else evalsByTrace.set(traceId, evals);
    }
    for (const id of res.referencedTraceIds) referencedTraceIds.add(id);
  }

  const traceIds = homeComputation?.traceIds ?? [];
  const hitCap = perOrgSummaries.some(s => s.endsWith('CAP-HIT'));

  const prevState = loadSyncState();
  const changed = filterChanged(allEntries, prevState);

  // Every-run bookkeeping keys: the legacy bare heartbeat, the org-prefixed
  // per-org heartbeats, and the global system heartbeat for /api/health (P5).
  const metaEntries: KVEntry[] = [
    { key: META_LAST_SYNC_KEY, value: toKVValue(now.toISOString()) },
  ];
  if (HOME_ORG_ID) {
    for (const orgId of orgIds) {
      if (orgId) metaEntries.push({ key: orgPrefixedKey(orgId, META_LAST_SYNC_KEY), value: toKVValue(now.toISOString()) });
    }
    metaEntries.push({ key: SYSTEM_LAST_SYNC_KEY, value: toKVValue(now.toISOString()) });
  }

  if (changed.length === 0) {
    console.log(`[sync-to-kv] No-op: computed=${allEntries.length} unchanged=${allEntries.length} changed=0 written=0 deferred=0`);
    // Still update the heartbeat keys (legacy, per-org, and global system)
    const staleMeta = filterChanged(metaEntries, prevState);
    if (staleMeta.length > 0) {
      kvBulkPut(staleMeta);
      for (const e of staleMeta) prevState.set(e.key, { hash: hashValue(e.value) });
      if (!dryRun) saveSyncState(prevState);
    }
    // Refresh lastChecked in the local sidecar so it reflects this run even when nothing changed.
    // KV consumers can use meta:lastSync (written above) to see when sync last ran; updating
    // meta:syncCoverage in KV here would burn 1 write per no-op run without changing stable data.
    const prevCoverage = loadLastCoverage();
    if (prevCoverage && !dryRun) {
      saveLastCoverage({ ...prevCoverage, lastChecked: now.toISOString() });
    }
    return;
  }

  const isTraceKey = (e: KVEntry) => {
    const bare = stripOrgPrefix(e.key);
    return bare.startsWith(TRACE_KEY_PREFIX) || bare.startsWith(TRACE_EVALS_KEY_PREFIX);
  };
  const highPriority = changed.filter(e => !isTraceKey(e));
  const traceChanged = changed.filter(isTraceKey);
  const { highPriorityBudget, traceBudget } = computeBudgetAllocation(highPriority.length, WRITE_BUDGET);

  const prioritizedTraces = prioritizeTraces(traceChanged, evalsByTrace, referencedTraceIds);

  const toWrite: KVEntry[] = [
    ...highPriority.slice(0, highPriorityBudget),
    ...prioritizedTraces.slice(0, traceBudget),
    ...metaEntries,
  ];
  const deferred = changed.length - (toWrite.length - metaEntries.length);

  const written = kvBulkPut(toWrite);

  const newState = new Map(prevState);
  for (const e of toWrite.slice(0, written)) {
    newState.set(e.key, { hash: hashValue(e.value) });
  }
  const computedKeys = new Set(allEntries.map(e => e.key));
  for (const e of metaEntries) computedKeys.add(e.key);
  computedKeys.add(META_LAST_SYNC_KEY);
  computedKeys.add(META_SYNC_COVERAGE_KEY);

  // Delete KV keys that were tracked in local state but are no longer computed.
  // This covers entries whose trace/session was pruned from the query window on this run.
  const staleKeys = [...newState.keys()].filter(k => !computedKeys.has(k));
  if (staleKeys.length > 0) {
    console.log(`[sync-to-kv] Pruning ${staleKeys.length} stale KV key(s) dropped from local state`);
    kvBulkDelete(staleKeys);
  }

  for (const key of staleKeys) newState.delete(key);
  if (!dryRun) saveSyncState(newState);

  // Compute the final deferred count here — before coverage — so it can be
  // surfaced in meta:syncCoverage where the dashboard or an alert can read it
  // (KV-SYNC-DEFERRED-BACKLOG).
  const limitDeferred = Math.max(0, toWrite.length - metaEntries.length - written);
  const actualDeferred = deferred + limitDeferred;

  // syncedTraces reflects best-known state from the local state file, not a confirmed live KV scan.
  // It may over-count if a prior wrangler write failed silently.
  const syncedTraceKeys = [...newState.keys()].filter(k => k.startsWith(TRACE_KEY_PREFIX));
  const syncedReferencedCount = syncedTraceKeys
    .filter(k => referencedTraceIds.has(k.slice(TRACE_KEY_PREFIX.length))).length;
  const coverage = {
    totalTraces: traceIds.length,
    syncedTraces: syncedTraceKeys.length,
    coveragePercent: coveragePercent(syncedTraceKeys.length, traceIds.length),
    referencedCoverage: coveragePercent(syncedReferencedCount, referencedTraceIds.size),
    // runsRemaining: additional runs after this one needed to drain the trace backlog
    runsRemaining: traceBudget > 0
      ? Math.ceil(Math.max(0, traceChanged.length - traceBudget) / traceBudget)
      : (traceChanged.length > 0 ? null : 0),
    /** Entries computed this run that were not written because they exceed the KV budget. */
    deferred: actualDeferred,
    // timestamp: when stable coverage numbers were last computed/changed (not updated on no-op runs)
    timestamp: now.toISOString(),
    // lastChecked: when sync last ran regardless of whether data changed (refreshed even on no-op runs)
    lastChecked: now.toISOString(),
  };
  // Exclude lastChecked (and timestamp) from the change-detection hash so a new timestamp alone
  // does not burn a KV write every run. `deferred` is intentionally included — a change in the
  // backlog size triggers a write so the latest count is always visible.
  const { lastChecked: _lc, timestamp: _ts, ...stableCoverage } = coverage;
  const coverageHash = hashValue(JSON.stringify(stableCoverage));
  const coverageEntry: KVEntry = { key: META_SYNC_COVERAGE_KEY, value: toKVValue(coverage) };
  if (newState.get(META_SYNC_COVERAGE_KEY)?.hash !== coverageHash) {
    const coverageWritten = kvBulkPut([coverageEntry]);
    if (coverageWritten > 0) {
      newState.set(META_SYNC_COVERAGE_KEY, { hash: coverageHash });
      if (!dryRun) saveSyncState(newState);
    }
  }
  // Persist coverage data so the early-return path can refresh lastChecked without recomputing.
  if (!dryRun) saveLastCoverage(coverage);

  // KV write-budget instrumentation (P4): total and per-scope counts, so the
  // free-tier ~1000/day cap can be checked against a concrete number
  // (this counter × daily cron runs). Warns when a single run exceeds
  // --max-writes; the cap itself is enforced upstream by --budget.
  const writesByScope = new Map<string, number>();
  for (const e of toWrite.slice(0, written)) {
    const orgMatch = ORG_KEY_PREFIX_RE.exec(e.key);
    const scope = orgMatch
      ? `org:${orgMatch[0].slice('org:'.length, -1)}`
      : (e.key === SYSTEM_LAST_SYNC_KEY ? 'system' : 'legacy');
    writesByScope.set(scope, (writesByScope.get(scope) ?? 0) + 1);
  }
  const writeCounter = [...writesByScope.entries()].map(([scope, n]) => `${scope}=${n}`).join(' ');
  if (written > MAX_WRITES_PER_RUN) {
    console.warn(
      `[sync-to-kv] WRITE BUDGET WARNING: ${written} KV writes this run exceeds --max-writes=${MAX_WRITES_PER_RUN} ` +
      '(free tier is ~1000/day across all runs)',
    );
  }

  console.log(
    `[sync-to-kv] Done: computed=${allEntries.length} changed=${changed.length} ` +
    `unchanged=${allEntries.length - changed.length} written=${written} deferred=${actualDeferred}` +
    (dryRun ? ' (dry-run, no KV writes)' : '') +
    ` | kvWrites[${writeCounter}]` +
    ` | traces=${traceIds.length} | per-org: ${perOrgSummaries.join(' · ')}` +
    (hitCap ? ' | WARNING: query hit page cap — results may be truncated' : ''),
  );
}

runIfMain(import.meta.url, main, '[sync]');
