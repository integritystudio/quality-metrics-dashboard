#!/usr/bin/env tsx
/**
 * Sync pre-computed dashboard data to Cloudflare Workers KV.
 *
 * Reads local JSONL evaluations, runs quality-metrics computations,
 * and uploads results via the Cloudflare SDK's KV bulk endpoints
 * (requires `CLOUDFLARE_API_TOKEN` in env).
 *
 * Uses content-hash delta sync to skip unchanged entries and a per-run
 * write budget (default 3,000; the account is on Workers Paid, 1M KV
 * writes/month) with priority ordering:
 *   meta/dashboard/agent > metrics > trends > traces
 *
 * Usage: tsx scripts/sync-to-kv.ts [--days=30] [--dry-run] [--budget=3000]
 */

import Cloudflare, {
  APIError as CloudflareAPIError,
  APIConnectionError as CloudflareAPIConnectionError,
} from 'cloudflare';
import { parse as parseToml } from 'smol-toml';
import { createHash } from 'crypto';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CloudBackend, ALL_ORGS_SCOPE, queriedDateWindow } from '../../src/backends/cloud.js';
import { http1Fetch, describeFetchError } from '../../src/lib/core/http1-fetch.js';
import {
  computeDashboardSummary,
  computeAggregations,
  getQualityMetric,
  QUALITY_METRICS,
} from '../../src/lib/quality/quality-metrics.js';
import { computeRoleView, computeMetricDetail } from '../../src/lib/quality/quality-views.js';
import { computePipelineView, computeCoverageMatrix } from '../../src/lib/quality/quality-visualization.js';
import type { MetricTrend } from '../../src/lib/quality/quality-constants.js';
import type { EvaluationResult, TraceSpan } from '../../src/backends/index.js';
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
import { PERIOD_MS, ROLES, DEFAULT_TOP_N, DEFAULT_BUCKET_COUNT, type Period } from '../src/lib/constants.js';
import { computeSessionDetail, type AgentActivityEntry } from '../src/api/session-detail.js';
import type { CalibrationResponse } from '../src/lib/validation/dashboard-schemas.js';
import { BYTES, PERCENT_MULTIPLIER, TIME_MS, SECONDS } from '../../src/lib/core/units.js';
import {
  SCORE_ROUND_FACTOR,
  LATENCY_P95,
  RATE_DISPLAY_PRECISION,
  KV_SCHEMA_VERSION,
  timestampToMs,
  extractFiniteScores,
} from '../src/api/api-constants.js';
import { CANARY_EVALUATOR_TYPE, CANARY_COHORT, CALIBRATION_STATE_DIR } from './evaluation-constants.js';
import { group, max, mean, min, minIndex, quantileSorted } from 'd3-array';
import { exitOnCliArgError, parseCli, positiveIntArg, runIfMain, type CliSpec } from './cli-args.js';
import { DRY_RUN_FLAG } from './pipeline-stages.js';
import { incrementIn, pushTo } from './collections.js';
import { msToNs } from './hrt.js';
import { describeUnknown } from '../../src/lib/core/describe-unknown.js';
import { bigintReplacer } from '../../src/lib/core/file-utils.js';
import { buildEvenBucketBoundaries, getEvenBucketIndex } from '../../src/lib/quality/bucket-utils.js';
import { SESSION_ATTRIBUTES } from '../../src/lib/otel/constants-otel.js';

/** The literal `worker/index.ts` reads at GET /api/degradation-signals; keep the two in step. */
const DEGRADATION_KV_KEY = 'meta/dashboard/degradation-signals';

interface CloudflareConfig {
  accountId: string;
  namespaceId: string;
}

function resolveCloudflareConfig(): CloudflareConfig {
  const envNamespaceId = process.env.KV_NAMESPACE_ID;
  const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (envNamespaceId && envAccountId) return { namespaceId: envNamespaceId, accountId: envAccountId };

  const tomlPath = join(import.meta.dirname, '..', 'wrangler.toml');
  if (existsSync(tomlPath)) {
    const raw = readFileSync(tomlPath, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(raw);
    } catch (err) {
      throw new Error(`Failed to parse ${tomlPath}: ${describeUnknown(err)}`, { cause: err });
    }
    const accountId = envAccountId ??
      (typeof parsed.account_id === 'string' ? parsed.account_id : undefined);
    const kvNamespaces = Array.isArray(parsed.kv_namespaces) ? parsed.kv_namespaces : [];
    const firstNs = kvNamespaces[0] as Record<string, unknown> | undefined;
    const namespaceId = envNamespaceId ??
      (typeof firstNs?.id === 'string' ? firstNs.id : undefined);
    if (accountId && namespaceId) return { accountId, namespaceId };
  }

  const missing: string[] = [];
  if (!process.env.KV_NAMESPACE_ID) missing.push('KV_NAMESPACE_ID');
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');
  throw new Error(
    `Could not resolve Cloudflare config. Set ${missing.join(' and ')} or ensure wrangler.toml has account_id and [[kv_namespaces]] with id.`,
  );
}

let cfConfig: CloudflareConfig | undefined;
/** Resolved on first KV call, so importing this module or a dry run needs no config. */
function getCloudflareConfig(): CloudflareConfig {
  return cfConfig ??= resolveCloudflareConfig();
}

let cfClient: Cloudflare | undefined;
function getCloudflareClient(): Cloudflare {
  // HTTP/1.1: under Node 26's default HTTP/2 fetch a destroyed session fails the
  // SDK's own retries too (ERR_HTTP2_INVALID_SESSION; NODE-FETCH-HTTP2-DEAD-SESSION).
  return cfClient ??= new Cloudflare({ fetch: http1Fetch });
}

const DEFAULT_DAYS = 30;
/**
 * Sized to Workers Paid (1M KV writes/month included): about 680 keys change
 * between the twice-daily runs, so the old free-tier 450 let `deferred` grow.
 * 3,000 × 60 runs/month stays under a fifth of the included writes.
 */
const DEFAULT_WRITE_BUDGET = 3_000;
const MAX_WRITES_HEADROOM = 50;
const DEFAULT_MAX_WRITES_PER_RUN = DEFAULT_WRITE_BUDGET + MAX_WRITES_HEADROOM;
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
    // Per-run write warning threshold: the budget plus room for meta entries
    // (P4 write-budget instrumentation).
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
/** Cloudflare API error code for the KV daily write limit (free tier only). */
const KV_DAILY_WRITE_LIMIT_CODE = 10048;
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
const ORG_KEY_PREFIX = 'org:';
export const ORG_KEY_PREFIX_RE = /^org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/i;

export function orgPrefixedKey(orgId: string, key: string): string {
  return `${ORG_KEY_PREFIX}${orgId}:${key}`;
}

/** Write-counter scopes for keys that carry no `org:<uuid>:` prefix. */
const WRITE_SCOPE = { SYSTEM: 'system', LEGACY: 'legacy' } as const;

/** Strip an `org:<uuid>:` prefix so key-class checks see the logical key. */
export function stripOrgPrefix(key: string): string {
  return key.replace(ORG_KEY_PREFIX_RE, '');
}

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
  if (typeof json !== 'string') throw new TypeError(`[sync-to-kv] KV value has no JSON form (${typeof value})`);
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

/** Cloudflare KV bulk PUT accepts up to 10,000 pairs; 5,000 keeps requests well inside the 100 MB body limit. */
export const KV_BATCH_SIZE = 5_000;
/**
 * Byte cap per bulk PUT. Requests up to 30 MB succeeded, but one dropped connection
 * defers its whole request, so smaller requests lose less (KV-SYNC-LAG-AND-APRIL-RECOUNT).
 */
export const KV_BATCH_MAX_BYTES = 8 * 1024 * 1024;
/** Undefined under runners that don't provide import.meta.dirname (e.g. vitest transforms). */
const SCRIPT_DIR = importMetaDirname(import.meta);
const STATE_FILE = join(SCRIPT_DIR ?? '.', '.kv-sync-state.json');
/** Stores last computed coverage object so early-return path can refresh lastChecked. */
const COVERAGE_FILE = join(SCRIPT_DIR ?? '.', '.kv-sync-coverage.json');
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

/** Minimum budget reserved for trace writes regardless of higher-priority entries */
export const MIN_TRACE_BUDGET = 100;
/** Budget headroom above MIN_TRACE_BUDGET for meta and dashboard entries before a warning. */
const HIGH_PRIORITY_HEADROOM = 10;
const RECOMMENDED_MIN_BUDGET = MIN_TRACE_BUDGET + HIGH_PRIORITY_HEADROOM;

const MAX_EVAL_ROWS = 200;
/** Metric detail compares the last week with the one before it, so the read spans at least two. */
const METRIC_DETAIL_WEEKS = 2;

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

function entryHash(entry: KVEntry): string {
  return createHash('sha256').update(entry.hashBasis ?? entry.value).digest('hex').slice(0, HASH_PREFIX_CHARS);
}

function filterChanged(entries: KVEntry[], state: SyncState): KVEntry[] {
  return entries.filter(e => state.get(e.key)?.hash !== entryHash(e));
}

/** Record the hash of each entry `kvBulkPut` reported written, so the next run skips it while unchanged. */
function recordWritten(state: SyncState, entries: KVEntry[], writtenKeys: Set<string>): void {
  for (const e of entries) {
    if (writtenKeys.has(e.key)) state.set(e.key, { hash: entryHash(e) });
  }
}

/** The view's own run-time stamp; a nested `timestamp` (`worstExplanation.timestamp`) is event time, i.e. data. */
const DASHBOARD_RUN_STAMP_FIELD = 'timestamp';
/** Each metric's query window, built from the run's `now`, at any depth. */
const DASHBOARD_PERIOD_FIELD = 'period';

/**
 * A dashboard summary or role view as a KV entry. The view's top-level `timestamp` and
 * each metric's `period` (copied into the auditor and operator views) come from the
 * run's clock, so the change hash leaves them out and a sync over unchanged data
 * rewrites no `dashboard:*` key (SYNC-DASHBOARD-TIMESTAMP-WRITES). The stored value
 * keeps them, so they show the run that last changed the data, not the latest run.
 */
export function dashboardEntry(key: string, view: object): KVEntry {
  const hashBasis = JSON.stringify(view, function (this: unknown, field: string, v: unknown) {
    if (field === DASHBOARD_PERIOD_FIELD) return undefined;
    if (field === DASHBOARD_RUN_STAMP_FIELD && this === view) return undefined;
    return bigintReplacer(field, v);
  });
  return { key, value: toKVValue(view), hashBasis };
}

/** Failed keys named in a warning; the rest are summarised by an ellipsis. */
const FAILED_KEY_PREVIEW_COUNT = 5;

function previewKeys(keys: string[]): string {
  const shown = keys.slice(0, FAILED_KEY_PREVIEW_COUNT).join(', ');
  return keys.length > FAILED_KEY_PREVIEW_COUNT ? `${shown}…` : shown;
}

interface EnvelopedKVPair {
  key: string;
  value: string;
  expiration_ttl?: number;
}

function envelope(e: KVEntry): EnvelopedKVPair {
  return {
    key: e.key,
    // `e.value` is already JSON (toKVValue), so the version envelope is spliced
    // around it as text; parsing and re-serializing gave the same bytes.
    value: `{"v":${JSON.stringify(KV_SCHEMA_VERSION)},"data":${e.value}}`,
    ...(e.expirationTtl != null ? { expiration_ttl: e.expirationTtl } : {}),
  };
}

/**
 * Split pairs into bulk requests of at most `maxCount` pairs and about `maxBytes`
 * of key + value. A pair larger than `maxBytes` goes alone in its own request.
 */
export function chunkKvPairs<T extends { key: string; value: string }>(
  pairs: T[],
  maxCount = KV_BATCH_SIZE,
  maxBytes = KV_BATCH_MAX_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const pair of pairs) {
    const bytes = Buffer.byteLength(pair.key) + Buffer.byteLength(pair.value);
    if (current.length > 0 && (current.length >= maxCount || currentBytes + bytes > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(pair);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Write entries in byte-capped bulk requests and return the keys written.
 * A connection failure defers only its own chunk, so later chunks still land
 * and the next run retries the rest; it throws only when every request failed.
 */
export async function kvBulkPut(entries: KVEntry[]): Promise<Set<string>> {
  const writtenKeys = new Set<string>();
  if (entries.length === 0) return writtenKeys;
  const chunks = chunkKvPairs(entries.map(envelope));
  let connectionFailures = 0;
  let lastConnectionError: unknown;
  for (const [index, batch] of chunks.entries()) {
    const batchLabel = chunks.length > 1 ? ` (batch ${index + 1}/${chunks.length})` : '';
    if (dryRun) {
      for (const e of batch) writtenKeys.add(e.key);
      continue;
    }
    const { namespaceId, accountId } = getCloudflareConfig();
    try {
      const result = await getCloudflareClient().kv.namespaces.bulkUpdate(namespaceId, {
        account_id: accountId,
        body: batch,
      });
      // null result = HTTP 204 (no body): the SDK treats this as success and
      // returns null. Credit all batch keys. If the API later gains a body,
      // unsuccessful_keys will be populated and failures will be excluded below.
      if (result == null) {
        console.warn(`[sync-to-kv] bulk put${batchLabel}: API returned no response body — crediting all ${batch.length} keys as written`);
      }
      const failed = new Set(result?.unsuccessful_keys ?? []);
      if (failed.size > 0) {
        console.warn(`[sync-to-kv] ${failed.size} key(s) not written in batch${batchLabel} — will retry on next run: ${previewKeys([...failed])}`);
      }
      for (const e of batch) {
        if (!failed.has(e.key)) writtenKeys.add(e.key);
      }
    } catch (err) {
      if (err instanceof CloudflareAPIError &&
          err.errors.some(e => e.code === KV_DAILY_WRITE_LIMIT_CODE)) {
        console.warn(`[sync-to-kv] KV write limit hit — ${batch.length} entries deferred.`);
        return writtenKeys;
      }
      if (err instanceof CloudflareAPIConnectionError) {
        connectionFailures++;
        lastConnectionError = err;
        console.warn(
          `[sync-to-kv] bulk put${batchLabel} could not connect — ${batch.length} entries deferred to the next run: ` +
          describeFetchError(err.cause ?? err),
        );
        continue;
      }
      console.error(`[sync-to-kv] bulk put failed${batchLabel}: ${describeUnknown(err)}`);
      throw new Error(`Cloudflare KV bulk put failed for ${batch.length} entries${batchLabel}.`, { cause: err });
    }
  }
  if (connectionFailures === chunks.length) {
    throw new Error(
      `Cloudflare KV bulk put could not connect for any of ${chunks.length} request(s).`,
      { cause: lastConnectionError },
    );
  }
  return writtenKeys;
}

/**
 * Delete a batch of KV keys via the Cloudflare SDK.
 * Warns on failure but does not throw — prune passes are best-effort.
 *
 * @param keys - KV keys to delete
 * @param opts.dryRun - when true, logs instead of calling the API; defaults to the module-level dryRun flag
 */
export async function kvBulkDelete(keys: string[], opts?: { dryRun?: boolean }): Promise<Set<string>> {
  const failedKeys = new Set<string>();
  const isDryRun = opts?.dryRun ?? dryRun;
  if (keys.length === 0) return failedKeys;
  for (let i = 0; i < keys.length; i += KV_BATCH_SIZE) {
    const batch = keys.slice(i, i + KV_BATCH_SIZE);
    if (isDryRun) {
      console.log(`[sync-to-kv] dry-run: would delete ${batch.length} stale KV key(s)`);
      continue;
    }
    const { namespaceId, accountId } = getCloudflareConfig();
    try {
      const result = await getCloudflareClient().kv.namespaces.bulkDelete(namespaceId, {
        account_id: accountId,
        body: batch,
      });
      const failedDeletes = result?.unsuccessful_keys ?? [];
      if (failedDeletes.length > 0) {
        console.warn(
          `[sync-to-kv] ${failedDeletes.length} key(s) not deleted — will be retried on next sync: ${previewKeys(failedDeletes)}`,
        );
        for (const k of failedDeletes) failedKeys.add(k);
      }
    } catch (err) {
      console.warn(`[sync-to-kv] bulk delete failed for ${batch.length} key(s): ${describeUnknown(err)}`);
      // Conservatively keep all batch keys in state so the next run retries.
      for (const k of batch) failedKeys.add(k);
    }
  }
  return failedKeys;
}

function extractTraceId(key: string): string | null {
  // Org-prefixed and bare trace keys group under the same traceId, so a home-org
  // dual-written trace moves through the priority budget as one unit.
  const bare = stripOrgPrefix(key);
  if (bare.startsWith(TRACE_EVALS_KEY_PREFIX)) return bare.slice(TRACE_EVALS_KEY_PREFIX.length);
  if (bare.startsWith(TRACE_KEY_PREFIX)) return bare.slice(TRACE_KEY_PREFIX.length);
  return null;
}

/** Weighted sum of how bad, how recent, and whether a metric card links to the trace. */
function tracePriority(evals: EvaluationResult[], isReferencedByWorst: boolean, now: number): number {
  const worstScore = min(extractFiniteScores(evals)) ?? UNEVALUATED_TRACE_SCORE;
  const latestTimestamp = max(evals.map(e => timestampToMs(e.timestamp)).filter(Number.isFinite)) ?? 0;
  const recency = latestTimestamp > 0 ? Math.max(0, 1 - (now - latestTimestamp) / PERIOD_MS['30d']) : 0;
  return (1 - worstScore) * TRACE_PRIORITY_WEIGHTS.worstScore
    + recency * TRACE_PRIORITY_WEIGHTS.recency
    + (isReferencedByWorst ? 1 : 0) * TRACE_PRIORITY_WEIGHTS.referencedByWorst;
}

export function prioritizeTraces(
  traceEntries: KVEntry[],
  evalsByTrace: Map<string, EvaluationResult[]>,
  referencedTraceIds: Set<string>,
): KVEntry[] {
  const now = Date.now();

  // each trace has 2 entries: evaluations:trace:X and trace:X
  const traceGroups = new Map<string, KVEntry[]>();
  let skippedCount = 0;
  for (const entry of traceEntries) {
    const traceId = extractTraceId(entry.key);
    if (!traceId) {
      skippedCount++;
      continue;
    }
    pushTo(traceGroups, traceId, entry);
  }
  if (skippedCount > 0) {
    console.warn(`[prioritizeTraces] Skipped ${skippedCount} entries with non-trace key format`);
  }

  const scored = Array.from(traceGroups, ([traceId, entries]) => ({
    entries,
    priority: tracePriority(evalsByTrace.get(traceId) ?? [], referencedTraceIds.has(traceId), now),
  }));
  scored.sort((a, b) => b.priority - a.priority);
  return scored.flatMap(t => t.entries);
}

function spanSessionId(span: { attributes?: Record<string, unknown> }): string | undefined {
  return (span.attributes?.[SESSION_ATTRIBUTES.ID] ?? span.attributes?.['session_id']) as string | undefined;
}

function isValidScore(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
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
      startDate: msToNs(start.getTime()),
      endDate: msToNs(now.getTime()),
      limit: QUERY_LIMIT,
    });
    for (const ev of evals) {
      if (ev.orgId) ids.add(ev.orgId);
    }
  } catch (err) {
    console.warn(
      '[sync-to-kv] all-orgs enumeration unavailable — syncing HOME org only. ' +
      `(${describeUnknown(err)})`,
    );
  }
  return [...ids];
}

/** The two cloud reads one org's aggregation makes; a `CloudBackend` scoped to that org. */
export type OrgReadBackend = Pick<CloudBackend, 'queryEvaluations' | 'queryTraces'>;

/**
 * Add one session to an agent's bounded buffer of recent sessions. Once the
 * buffer holds `max`, a dated entry replaces the oldest dated session (the
 * first of a tie) if it is newer; when no buffered session has a date, it
 * replaces the last slot. An undated entry is dropped from a full buffer.
 */
export function addRecentSession<T extends { date: string | null }>(sessions: T[], entry: T, max: number): void {
  if (sessions.length < max) {
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
    console.warn(`[sync-to-kv] Code-quality checkpoint query hit ${CODE_QUALITY_CHECKPOINT_LIMIT} — oldest checkpoints dropped`);
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
type DegradationBucket = { scores: number[]; startTime: string; endTime: string };
/** What `accumulateAgent` reads from one session's detail. */
type AgentSessionContext = {
  timespan: { start: string } | null;
  sessionInfo: { projectName: string } | null;
};

/** The UTC midnight a read starting at `ms` begins from. */
function dayStartNs(ms: number): bigint {
  return queriedDateWindow({ startDate: msToNs(ms) }).startNs ?? 0n;
}

/**
 * One read serves every window: the periods, both metric-detail weeks and the
 * session/trace window. Separate reads fetched the same rows up to 22 times per org.
 * One extra row detects truncation (KV-SESSION-EVALS-TRUNCATION-UNFLAGGED); the server
 * returns the newest ids first, so a truncated read loses the oldest rows.
 */
async function readOrgEvaluations(backend: OrgReadBackend, nowMs: number): Promise<OrgEvaluations> {
  const fetched = await backend.queryEvaluations({
    startDate: msToNs(nowMs - Math.max(MAX_DAYS_MS, METRIC_DETAIL_WEEKS * PERIOD_MS['7d'])),
    endDate: msToNs(nowMs),
    limit: QUERY_LIMIT + 1,
  });
  const truncated = fetched.length > QUERY_LIMIT;
  const evals = truncated ? fetched.slice(0, QUERY_LIMIT) : fetched;
  if (truncated) {
    console.warn(
      `[sync-to-kv] Evaluation query returned ${QUERY_LIMIT} results — oldest evaluations dropped; all sessions marked partial`,
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
  // `dates` is already `{ start, end }` ISO — a `TimeRange`.
  const dashboard = computeDashboardSummary(grouped, { period: dates });
  entries.push(dashboardEntry(`dashboard:${period}`, dashboard));

  for (const role of ROLES) {
    const view = computeRoleView(dashboard, role);
    entries.push(dashboardEntry(`dashboard:${period}:${role}`, view));
  }

  const metricTimeSeries = new Map([...grouped].map(([name, metricEvals]) => [name, extractFiniteScores(metricEvals)]));
  const correlations = computeCorrelationMatrix(metricTimeSeries);
  entries.push({
    key: `correlations:${period}`,
    value: toKVValue({ correlations, metrics: [...grouped.keys()] }),
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
  return entries;
}

/**
 * `metric:<name>`: the current week against the one before it. Also returns the
 * trace ids the metric cards link to, which the trace write budget favours.
 */
function computeMetricDetailEntries(
  orgEvals: OrgEvaluations,
  nowMs: number,
  metricNames: string[],
): { entries: KVEntry[]; referencedTraceIds: Set<string> } {
  const weekMs = PERIOD_MS['7d'];
  // The current week matches `dashboard:7d`; the previous week is the 7 whole days before
  // it and ends where it starts, so no evaluation counts in both (METRIC-WEEK-OVERLAP).
  const currentWeek = groupByMetric(orgEvals.between(nowMs - weekMs));
  const previousWeek = groupByMetric(orgEvals.inWindow(dayStartNs(nowMs - 2 * weekMs), dayStartNs(nowMs - weekMs)));
  const entries: KVEntry[] = [];
  const referencedTraceIds = new Set<string>();

  for (const name of metricNames) {
    const config = getQualityMetric(name);
    const evals = currentWeek.get(name);
    if (!config || !evals) continue;

    const prevScores = extractFiniteScores(previousWeek.get(name) ?? []);
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
  return entries;
}

/**
 * `trend:<name>:<period>`, plus the time buckets per period × metric that the
 * degradation signals are computed from.
 */
function computeTrendEntries(
  groupedByPeriod: Map<Period, EvaluationsByName>,
  metricNames: string[],
  now: Date,
): { entries: KVEntry[]; degradationBuckets: Map<Period, Record<string, DegradationBucket[]>> } {
  const entries: KVEntry[] = [];
  const degradationBuckets = new Map<Period, Record<string, DegradationBucket[]>>();
  for (const [period, cached] of groupedByPeriod) {
    const ms = PERIOD_MS[period];
    const startMs = now.getTime() - ms;
    const bucketMs = ms / TREND_BUCKETS;
    const bucketWindows = buildEvenBucketBoundaries(startMs, now.getTime(), TREND_BUCKETS).map(b => ({
      startTime: new Date(b.start).toISOString(),
      endTime: new Date(b.end).toISOString(),
    }));

    for (const name of metricNames) {
      const config = getQualityMetric(name);
      if (!config) continue;
      const evaluations = cached.get(name) ?? [];

      const timeBuckets: Array<{ startTime: string; endTime: string; scores: number[]; evals: EvaluationResult[] }> =
        bucketWindows.map(w => ({ ...w, scores: [], evals: [] }));
      for (const ev of evaluations) {
        const idx = getEvenBucketIndex(timestampToMs(ev.timestamp), startMs, bucketMs, TREND_BUCKETS);
        const tb = idx === null ? undefined : timeBuckets[idx];
        if (tb && isValidScore(ev.scoreValue)) {
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

      const allScores = extractFiniteScores(evaluations);

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
  return { entries, degradationBuckets };
}

/**
 * `degradation:<period>` from the trend buckets. Degradation state is this script's own
 * sidecar, so it lives beside the script, and it is the owner's single-tenant history:
 * non-home orgs compute signals statelessly (no cross-run breach continuity).
 */
function computeDegradationEntries(
  degradationBuckets: Map<Period, Record<string, DegradationBucket[]>>,
  metricNames: string[],
  now: Date,
  isHome: boolean,
): KVEntry[] {
  const entries: KVEntry[] = [];
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

/** `agent:<name>` per agent, and `meta:agents` ordered by invocations. */
function buildAgentEntries(agents: Map<string, AgentAccumulator>, now: Date): KVEntry[] {
  const agentEntries: KVEntry[] = [];
  const agentSummaryList: Array<{
    agentName: string; totalSessions: number; totalInvocations: number;
    errorRate: number; lastSeen: string | null;
  }> = [];
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
  return agentEntries;
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

/**
 * Run the full aggregation for one org's cloud rows. The only org-aware behavior
 * is that the local sidecar state (degradation breaches, calibration) is
 * owner-local and therefore read/written for the home org alone.
 */
export async function computeOrgEntries(backend: OrgReadBackend, now: Date, isHome: boolean): Promise<OrgComputation> {
  const entries: KVEntry[] = [];
  const nowMs = now.getTime();
  const orgEvals = await readOrgEvaluations(backend, nowMs);

  const groupedByPeriod = new Map<Period, EvaluationsByName>();
  const periodCounts: string[] = [];
  for (const period of PERIODS.filter(p => PERIOD_MS[p] <= MAX_DAYS_MS)) {
    const start = new Date(nowMs - PERIOD_MS[period]);
    const evals = orgEvals.between(start.getTime());
    periodCounts.push(`${period}:${evals.length}`);
    const grouped = groupByMetric(evals);
    groupedByPeriod.set(period, grouped);
    entries.push(...computePeriodEntries(period, grouped, { start: start.toISOString(), end: now.toISOString() }));
  }

  entries.push({ key: CODE_QUALITY_KV_KEY, value: toKVValue(await computeCodeQuality(backend, now)) });

  const metricNames = Object.keys(QUALITY_METRICS);
  const metricDetail = computeMetricDetailEntries(orgEvals, nowMs, metricNames);
  entries.push(...metricDetail.entries);
  entries.push(...computeEvaluationRowEntries(groupedByPeriod, metricNames));

  const trends = computeTrendEntries(groupedByPeriod, metricNames, now);
  entries.push(...trends.entries);
  entries.push(...computeDegradationEntries(trends.degradationBuckets, metricNames, now, isHome));

  // Calibration is derive's, read from where derive writes it, and the owner's alone.
  const calibrationEntry = isHome ? loadCalibrationEntry() : null;
  if (calibrationEntry) entries.push(calibrationEntry);

  const queryWindowStartMs = nowMs - MAX_DAYS_MS;
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
    console.warn(`[sync-to-kv] Span query returned ${SPAN_QUERY_LIMIT} results — data may be truncated`);
  }
  const spansByTrace: Map<string, TraceSpan[]> = group(allSpans.filter(hasTraceId), span => span.traceId);
  const traceEntries = buildTraceEntries(traceIds, evalsByTrace, spansByTrace);

  const { sessionEntries, agentEntries } = computeSessionAndAgentEntries(allSpans, allEvals, orgEvals.truncated, now);

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
  let hitCap = false;
  const perOrgSummaries: string[] = [];

  for (const orgId of orgIds) {
    const backend = new CloudBackend({ ...(orgId ? { orgId } : {}), fetch: http1Fetch });
    const isHome = orgId === null || orgId === HOME_ORG_ID;
    const res = await computeOrgEntries(backend, now, isHome);
    if (isHome) homeComputation = res;
    hitCap ||= res.hitCap;
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
      for (const ev of evals) pushTo(evalsByTrace, traceId, ev);
    }
    for (const id of res.referencedTraceIds) referencedTraceIds.add(id);
  }

  const traceIds = homeComputation?.traceIds ?? [];

  const prevState = loadSyncState();
  const changed = filterChanged(allEntries, prevState);

  // Every-run bookkeeping keys: the legacy bare heartbeat, the org-prefixed
  // per-org heartbeats, and the global system heartbeat for /api/health (P5).
  const heartbeat = toKVValue(now.toISOString());
  const metaEntries: KVEntry[] = [
    { key: META_LAST_SYNC_KEY, value: heartbeat },
  ];
  if (HOME_ORG_ID) {
    for (const orgId of orgIds) {
      if (orgId) metaEntries.push({ key: orgPrefixedKey(orgId, META_LAST_SYNC_KEY), value: heartbeat });
    }
    metaEntries.push({ key: SYSTEM_LAST_SYNC_KEY, value: heartbeat });
  }

  if (changed.length === 0) {
    console.log(`[sync-to-kv] No-op: computed=${allEntries.length} unchanged=${allEntries.length} changed=0 written=0 deferred=0`);
    // Still update the heartbeat keys (legacy, per-org, and global system)
    const staleMeta = filterChanged(metaEntries, prevState);
    if (staleMeta.length > 0) {
      recordWritten(prevState, staleMeta, await kvBulkPut(staleMeta));
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

  const isTraceKey = (e: KVEntry) => extractTraceId(e.key) !== null;
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

  const writtenKeys = await kvBulkPut(toWrite);

  const newState = new Map(prevState);
  recordWritten(newState, toWrite, writtenKeys);
  const computedKeys = new Set(allEntries.map(e => e.key));
  for (const e of metaEntries) computedKeys.add(e.key);
  computedKeys.add(META_SYNC_COVERAGE_KEY);

  // Delete KV keys that were tracked in local state but are no longer computed.
  // This covers entries whose trace/session was pruned from the query window on this run.
  const staleKeys = [...newState.keys()].filter(k => !computedKeys.has(k));
  if (staleKeys.length > 0) {
    console.log(`[sync-to-kv] Pruning ${staleKeys.length} stale KV key(s) dropped from local state`);
    const failedDeletes = await kvBulkDelete(staleKeys);
    // Remove successfully deleted keys; keep failed ones so the next run retries.
    for (const key of staleKeys) {
      if (!failedDeletes.has(key)) newState.delete(key);
    }
  }

  if (!dryRun) saveSyncState(newState);

  // Compute the final deferred count here — before coverage — so it can be
  // surfaced in meta:syncCoverage where the dashboard or an alert can read it
  // (KV-SYNC-DEFERRED-BACKLOG).
  const metaKeySet = new Set(metaEntries.map(e => e.key));
  const limitDeferred = toWrite.filter(e => !metaKeySet.has(e.key) && !writtenKeys.has(e.key)).length;
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
  const coverageEntry: KVEntry = {
    key: META_SYNC_COVERAGE_KEY,
    value: toKVValue(coverage),
    hashBasis: JSON.stringify(stableCoverage),
  };
  if (filterChanged([coverageEntry], newState).length > 0) {
    const coverageWrittenKeys = await kvBulkPut([coverageEntry]);
    recordWritten(newState, [coverageEntry], coverageWrittenKeys);
    if (coverageWrittenKeys.has(coverageEntry.key) && !dryRun) saveSyncState(newState);
  }
  // Persist coverage data so the early-return path can refresh lastChecked without recomputing.
  if (!dryRun) saveLastCoverage(coverage);

  // KV write-budget instrumentation (P4): total and per-scope counts, so the
  // plan's monthly write allowance can be checked against a concrete number
  // (this counter × cron runs). Warns when a single run exceeds
  // --max-writes; the cap itself is enforced upstream by --budget.
  const writesByScope = new Map<string, number>();
  for (const key of writtenKeys) {
    const orgMatch = ORG_KEY_PREFIX_RE.exec(key);
    const scope = orgMatch
      ? orgMatch[0].slice(0, -1)
      : (key === SYSTEM_LAST_SYNC_KEY ? WRITE_SCOPE.SYSTEM : WRITE_SCOPE.LEGACY);
    incrementIn(writesByScope, scope);
  }
  const writeCounter = [...writesByScope.entries()].map(([scope, n]) => `${scope}=${n}`).join(' ');
  if (writtenKeys.size > MAX_WRITES_PER_RUN) {
    console.warn(
      `[sync-to-kv] WRITE BUDGET WARNING: ${writtenKeys.size} KV writes this run exceeds --max-writes=${MAX_WRITES_PER_RUN}`,
    );
  }

  console.log(
    `[sync-to-kv] Done: computed=${allEntries.length} changed=${changed.length} ` +
    `unchanged=${allEntries.length - changed.length} written=${writtenKeys.size} deferred=${actualDeferred}` +
    (dryRun ? ' (dry-run, no KV writes)' : '') +
    ` | kvWrites[${writeCounter}]` +
    ` | traces=${traceIds.length} | per-org: ${perOrgSummaries.join(' · ')}` +
    (hitCap ? ' | WARNING: query hit page cap — results may be truncated' : ''),
  );
}

runIfMain(import.meta.url, main, '[sync]');
