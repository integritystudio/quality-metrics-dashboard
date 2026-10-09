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
import { CloudBackend, ALL_ORGS_SCOPE } from '../../src/backends/cloud.js';
import { http1Fetch, describeFetchError } from '../../src/lib/core/http1-fetch.js';
import type { EvaluationResult } from '../../src/backends/index.js';
import { loadDegradationState, saveDegradationState } from '../../src/lib/quality/qfe-backtest.js';
import { loadCalibrationState } from '../../src/lib/quality/qfe-percentiles.js';
import { CALIBRATION_STATE_FILE } from '../../src/lib/quality/quality-constants.js';
import {
  kvSyncStateSchema,
  coverageHeatmapSchema,
  type KvSyncEntry,
  type CoverageHeatmap,
} from '../../src/lib/validation/dashboard-schemas.js';
import {
  buildCalibrationEntry,
  computeOrgKvEntries,
  toKVValue,
  QUERY_LIMIT,
  TRACE_EVALS_KEY_PREFIX,
  TRACE_KEY_PREFIX,
  type KVEntry,
  type OrgComputation,
  type OrgReadBackend,
} from '../src/api/aggregates/org-kv-entries.js';
export {
  addRecentSession,
  buildCalibrationEntry,
  buildTraceEntries,
  dashboardEntry,
  toKVValue,
  KV_ENTRY_TTL_DAYS,
  KV_ENTRY_TTL_SECONDS,
  QUERY_LIMIT,
} from '../src/api/aggregates/org-kv-entries.js';
export type { KVEntry, OrgComputation, OrgReadBackend } from '../src/api/aggregates/org-kv-entries.js';
import {
  loadJsonWithValidationSafe,
  loadJsonWithValidation,
  importMetaDirname,
} from '../src/lib/dashboard-file-utils.js';
import { PERIOD_MS } from '../src/lib/constants.js';
import { PERCENT_MULTIPLIER, TIME_MS } from '../../src/lib/core/units.js';
import { KV_SCHEMA_VERSION, timestampToMs, extractFiniteScores } from '../src/api/api-constants.js';
import { CALIBRATION_STATE_DIR } from './evaluation-constants.js';
import { max, min } from 'd3-array';
import { exitOnCliArgError, parseCli, positiveIntArg, runIfMain, type CliSpec } from './cli-args.js';
import { DRY_RUN_FLAG, SYNC_BUDGET_FLAG } from './pipeline-stages.js';
import { incrementIn, pushTo } from './collections.js';
import { msToNs } from './hrt.js';
import { describeUnknown } from '../../src/lib/core/describe-unknown.js';


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
const BUDGET_FLAG = SYNC_BUDGET_FLAG;
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

const META_LAST_SYNC_KEY = 'meta:lastSync';
const META_SYNC_COVERAGE_KEY = 'meta:syncCoverage';
/** Hex chars of the sha256 kept as the delta-sync content hash. */
const HASH_PREFIX_CHARS = 16;
/** Cloudflare API error code for the KV daily write limit (free tier only). */
const KV_DAILY_WRITE_LIMIT_CODE = 10048;
/** Coverage percentages keep two decimals. */
const COVERAGE_PERCENT_FACTOR = 100;
const COVERAGE_ROUND_SCALE = PERCENT_MULTIPLIER * COVERAGE_PERCENT_FACTOR;
/** Score assigned to traces with no evaluations, so they sort last. */
const UNEVALUATED_TRACE_SCORE = 1;
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
/** Minimum budget reserved for trace writes regardless of higher-priority entries */
export const MIN_TRACE_BUDGET = 100;
/** Budget headroom above MIN_TRACE_BUDGET for meta and dashboard entries before a warning. */
const HIGH_PRIORITY_HEADROOM = 10;
const RECOMMENDED_MIN_BUDGET = MIN_TRACE_BUDGET + HIGH_PRIORITY_HEADROOM;


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

/**
 * One org's entries with the owner-local inputs this script holds: derive's
 * calibration state and the degradation breach history beside the script,
 * both read, and the latter written, for the home org alone.
 */
export async function computeOrgEntries(backend: OrgReadBackend, now: Date, isHome: boolean): Promise<OrgComputation> {
  const stateDir = isHome ? (SCRIPT_DIR ?? '') : '';
  const degradationState = stateDir ? loadDegradationState(stateDir) : undefined;
  const result = await computeOrgKvEntries(backend, now, {
    maxDays,
    calibrationEntry: isHome ? loadCalibrationEntry() : null,
    degradationState,
  });
  if (degradationState && !dryRun) saveDegradationState(stateDir, degradationState);
  return result;
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
