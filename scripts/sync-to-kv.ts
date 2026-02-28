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
import { MultiDirectoryBackend } from '../../dist/backends/local-jsonl.js';
import {
  computeDashboardSummary,
  computeRoleView,
  computeMetricDetail,
  computeAggregations,
  getQualityMetric,
  QUALITY_METRICS,
} from '../../dist/lib/quality-metrics.js';
import { computeCoverageHeatmap, computePipelineView } from '../../dist/lib/quality-visualization.js';
import type { RoleViewType, QualityMetricConfig, MetricTrend } from '../../dist/lib/quality-metrics.js';
import type { EvaluationResult, StepScore } from '../../dist/backends/index.js';
import {
  computePercentileDistribution,
  computeMetricDynamics,
  computeCorrelationMatrix,
} from '../../dist/lib/quality-feature-engineering.js';
import { computeMultiAgentEvaluation } from '../../dist/lib/quality-multi-agent.js';

const NAMESPACE_ID = process.env.KV_NAMESPACE_ID;
if (!NAMESPACE_ID) throw new Error('KV_NAMESPACE_ID env var is required');

function parseIntArg(args: string[], flag: string, defaultValue: number): number {
  const match = args.find(a => a.startsWith(`--${flag}=`));
  const parsed = match ? parseInt(match.split('=')[1], 10) : defaultValue;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const maxDays = parseIntArg(args, 'days', 30);
const MAX_DAYS_MS = maxDays * 24 * 60 * 60 * 1000;
const WRITE_BUDGET = parseIntArg(args, 'budget', 450);

const PERIODS = ['24h', '7d', '30d'] as const;
const ROLES: RoleViewType[] = ['executive', 'operator', 'auditor'];
const PERIOD_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const HOOK_NAMES = {
  SESSION_START: 'session-start',
  TOKEN_METRICS: 'token-metrics-extraction',
  AGENT_POST_TOOL: 'agent-post-tool',
  POST_COMMIT_REVIEW: 'post-commit-review',
  ALERT_EVALUATION: 'telemetry-alert-evaluation',
  CODE_STRUCTURE: 'code-structure',
} as const;

type KVEntry = { key: string; value: string };

/** Filter out canary evaluations (intentionally degraded scores for testing). */
function filterCanary(evals: EvaluationResult[]): EvaluationResult[] {
  return evals.filter(ev => (ev as Record<string, unknown>).evaluatorType !== 'canary');
}

const KV_BATCH_SIZE = 5_000; // reduced from 9,500 to avoid 502s on large syncs
const STATE_FILE = join(import.meta.dirname ?? '.', '.kv-sync-state.json');
/** Stores last computed coverage object so early-return path can refresh lastChecked. */
const COVERAGE_FILE = join(import.meta.dirname ?? '.', '.kv-sync-coverage.json');
const QUERY_LIMIT = 200_000;

/** Minimum budget reserved for trace writes regardless of higher-priority entries */
export const MIN_TRACE_BUDGET = 100;

/** Trace priority weights */
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

// ---- Delta sync state ----

type SyncState = Record<string, string>; // key → sha256(value)

function loadJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; }
  catch { return fallback; }
}

function loadSyncState(): SyncState {
  return loadJsonFile(STATE_FILE, {} as SyncState);
}

function saveSyncState(state: SyncState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

interface CoverageData {
  totalTraces: number;
  syncedTraces: number;
  coveragePercent: number;
  referencedCoverage: number;
  runsRemaining: number | null;
  /** When stable coverage numbers were last computed/changed. */
  timestamp: string;
  /** When sync last ran, regardless of whether data changed. Refreshed on every run. */
  lastChecked: string;
}

function loadLastCoverage(): CoverageData | null {
  return loadJsonFile<CoverageData | null>(COVERAGE_FILE, null);
}

function saveLastCoverage(coverage: CoverageData): void {
  writeFileSync(COVERAGE_FILE, JSON.stringify(coverage));
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Filter to only entries whose content changed since last sync. */
function filterChanged(entries: KVEntry[], state: SyncState): KVEntry[] {
  return entries.filter(e => {
    const hash = hashValue(e.value);
    return state[e.key] !== hash;
  });
}

// ---- KV bulk write ----

/** Returns the number of entries successfully written. */
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
      writeFileSync(tmpFile, JSON.stringify(batch));
      if (dryRun) {
        for (const e of batch) {
          console.log(`[dry-run] PUT ${e.key} (${e.value.length} bytes)`);
        }
        written += batch.length;
        continue;
      }
      try {
        execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', tmpFile, '--namespace-id', NAMESPACE_ID, '--remote'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? '';
        if (stderr.includes('free usage limit') || stderr.includes('code: 10048')) {
          console.warn(`[sync-to-kv] KV daily write limit reached — ${batch.length} entries deferred to next run`);
          return written;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Wrangler KV bulk put failed for ${batch.length} entries${batchLabel}. Ensure wrangler is installed and authenticated. Error: ${msg}`);
      }
      written += batch.length;
      console.log(`PUT ${batch.length} entries${batchLabel}`);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }
  return written;
}

// ---- Evaluation-weighted trace prioritization ----

function extractTraceId(key: string): string | null {
  if (key.startsWith('evaluations:trace:')) return key.slice('evaluations:trace:'.length);
  if (key.startsWith('trace:')) return key.slice('trace:'.length);
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

  // Group entries by traceId (each trace has 2 entries: evaluations:trace:X and trace:X)
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

  // Score each trace
  const scored: TracePriorityScore[] = [];
  for (const [traceId] of traceGroups) {
    const evals = evalsByTrace.get(traceId) ?? [];

    const scores = evals
      .map(e => e.scoreValue)
      .filter(isValidScore);
    const worstScore = scores.length > 0
      ? scores.reduce((min, v) => v < min ? v : min, Infinity)
      : 1.0; // unevaluated traces get lowest priority

    const timestamps = evals.map(e => new Date(e.timestamp).getTime()).filter(Number.isFinite);
    const latestTimestamp = timestamps.length > 0
      ? timestamps.reduce((max, v) => v > max ? v : max, 0)
      : 0;

    const isReferencedByWorst = referencedTraceIds.has(traceId);

    // Composite priority (higher = sync first)
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
    const group = traceGroups.get(traceId);
    if (group) result.push(...group);
  }
  return result;
}

// ---- Session detail pre-computation (mirrors src/api/routes/sessions.ts) ----

type SessionSpan = {
  name: string;
  traceId?: string;
  durationMs?: number;
  status?: { code?: number };
  attributes?: Record<string, unknown>;
};

function spanAttr<T>(span: { attributes?: Record<string, unknown> }, key: string): T | undefined {
  return span.attributes?.[key] as T | undefined;
}

function spanSessionId(span: { attributes?: Record<string, unknown> }): string | undefined {
  return (span.attributes?.['session.id'] ?? span.attributes?.['session_id']) as string | undefined;
}

function isValidScore(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function pushToGroup<V>(map: Map<string, V[]>, key: string, value: V): void {
  if (!map.has(key)) map.set(key, []);
  map.get(key)!.push(value);
}

function arrayAvg(nums: number[]): number | null {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function computeDataSources(spans: SessionSpan[], evaluations: EvaluationResult[]) {
  const traceIdSet = new Set<string>();
  for (const s of spans) {
    if (s.traceId) traceIdSet.add(s.traceId);
  }
  return {
    traces: { count: spans.length, traceIds: traceIdSet.size },
    logs: { count: 0 },
    evaluations: { count: evaluations.length },
    total: spans.length + evaluations.length,
  };
}

function computeTimespan(evaluations: EvaluationResult[]) {
  let tsMin = Infinity;
  let tsMax = -Infinity;
  for (const ev of evaluations) {
    const t = new Date(ev.timestamp).getTime();
    if (t < tsMin) tsMin = t;
    if (t > tsMax) tsMax = t;
  }
  return tsMin < Infinity ? {
    start: new Date(tsMin).toISOString(),
    end: new Date(tsMax).toISOString(),
    durationHours: +((tsMax - tsMin) / 3_600_000).toFixed(1),
  } : null;
}

function computeSessionInfo(spans: SessionSpan[]) {
  const sessionStarts = spans.filter(s => spanAttr<string>(s, 'hook.name') === HOOK_NAMES.SESSION_START);
  const first = sessionStarts[0];
  const last = sessionStarts[sessionStarts.length - 1] ?? first;
  return first ? {
    projectName: spanAttr<string>(first, 'project.name') ?? 'unknown',
    workingDirectory: spanAttr<string>(first, 'working.directory') ?? '',
    gitRepository: spanAttr<string>(first, 'git.repository') ?? '',
    gitBranch: spanAttr<string>(first, 'git.branch') ?? '',
    nodeVersion: spanAttr<string>(first, 'node.version') ?? '',
    resumeCount: sessionStarts.length,
    initialMessageCount: spanAttr<number>(first, 'context.message_count') ?? 0,
    initialContextTokens: spanAttr<number>(first, 'context.estimated_tokens') ?? 0,
    finalMessageCount: spanAttr<number>(last, 'context.message_count') ?? 0,
    taskCount: spanAttr<number>(first, 'tasks.active') ?? 0,
    uncommittedAtStart: spanAttr<number>(first, 'git.uncommitted') ?? 0,
  } : null;
}

function computeTokenMetrics(spans: SessionSpan[]) {
  const tokenProgression = spans
    .filter(s => spanAttr<string>(s, 'hook.name') === HOOK_NAMES.TOKEN_METRICS)
    .map(s => ({
      messages: spanAttr<number>(s, 'tokens.messages') ?? 0,
      inputTokens: spanAttr<number>(s, 'tokens.input') ?? 0,
      outputTokens: spanAttr<number>(s, 'tokens.output') ?? 0,
      cacheRead: spanAttr<number>(s, 'tokens.cache_read') ?? 0,
      cacheCreation: spanAttr<number>(s, 'tokens.cache_creation') ?? 0,
      model: spanAttr<string>(s, 'tokens.model') ?? '',
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
    if (t.model) tokenTotals.models[t.model] = (tokenTotals.models[t.model] ?? 0) + 1;
  }
  return { tokenProgression, tokenTotals };
}

function computeUsageCounts(spans: SessionSpan[]) {
  const toolUsage: Record<string, number> = {};
  const mcpUsage: Record<string, number> = {};
  for (const s of spans) {
    const trigger = spanAttr<string>(s, 'hook.trigger');
    if (trigger !== 'PostToolUse') continue;
    const type = spanAttr<string>(s, 'hook.type');
    if (type === 'builtin') {
      const tool = spanAttr<string>(s, 'builtin.tool') ?? 'unknown';
      toolUsage[tool] = (toolUsage[tool] ?? 0) + 1;
    } else if (type === 'mcp') {
      const tool = spanAttr<string>(s, 'mcp.tool') ?? 'unknown';
      mcpUsage[tool] = (mcpUsage[tool] ?? 0) + 1;
    }
  }
  return { toolUsage, mcpUsage };
}

function computeSpanLatency(spans: SessionSpan[]) {
  const spanBreakdown: Record<string, number> = {};
  const hookDurations: Record<string, number[]> = {};
  for (const s of spans) {
    spanBreakdown[s.name] = (spanBreakdown[s.name] ?? 0) + 1;
    const ms = s.durationMs ?? 0;
    if (ms > 0) {
      if (!hookDurations[s.name]) hookDurations[s.name] = [];
      hookDurations[s.name].push(ms);
    }
  }
  const hookLatency: Record<string, { count: number; avg: number; p50: number; p95: number; max: number }> = {};
  for (const [name, durations] of Object.entries(hookDurations)) {
    const sorted = durations.sort((a, b) => a - b);
    hookLatency[name] = {
      count: sorted.length,
      avg: +(arrayAvg(sorted) ?? 0).toFixed(1),
      p50: +percentile(sorted, 50).toFixed(1),
      p95: +percentile(sorted, 95).toFixed(1),
      max: +sorted[sorted.length - 1].toFixed(1),
    };
  }
  return { spanBreakdown, hookLatency };
}

function computeErrorSummary(spans: SessionSpan[]) {
  const byCategory: Record<string, number> = {};
  const details: Array<{ spanName: string; tool?: string; errorType?: string; filePath?: string }> = [];
  for (const s of spans) {
    const hasError = spanAttr<boolean>(s, 'builtin.has_error') === true
      || spanAttr<boolean>(s, 'agent.has_error') === true
      || s.status?.code === 2;
    if (!hasError) continue;
    const tool = spanAttr<string>(s, 'builtin.tool') ?? spanAttr<string>(s, 'agent.type') ?? 'unknown';
    const errType = spanAttr<string>(s, 'builtin.error_type') ?? 'unknown';
    const key = `${tool} -> ${errType}`;
    byCategory[key] = (byCategory[key] ?? 0) + 1;
    details.push({
      spanName: s.name,
      tool,
      errorType: errType,
      filePath: spanAttr<string>(s, 'builtin.file_path'),
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

function computeAgentActivity(spans: SessionSpan[]): AgentActivityEntry[] {
  const acc: Record<string, {
    invocations: number; errors: number; hasRateLimit: boolean; rateLimitEvents: number;
    totalOutputSize: number; durations: number[]; truncatedCount: number; emptyCount: number;
  }> = {};
  for (const s of spans) {
    if (spanAttr<string>(s, 'hook.name') === HOOK_NAMES.AGENT_POST_TOOL) {
      const name = spanAttr<string>(s, 'gen_ai.agent.name') ?? 'unknown';
      if (!acc[name]) acc[name] = {
        invocations: 0, errors: 0, hasRateLimit: false, rateLimitEvents: 0,
        totalOutputSize: 0, durations: [], truncatedCount: 0, emptyCount: 0,
      };
      const a = acc[name];
      a.invocations++;
      if (spanAttr<boolean>(s, 'agent.has_error')) a.errors++;
      if (spanAttr<boolean>(s, 'agent.has_rate_limit')) {
        a.hasRateLimit = true;
        a.rateLimitEvents++;
      }
      a.totalOutputSize += spanAttr<number>(s, 'agent.output_size') ?? 0;
      const dur = s.durationMs ?? 0;
      if (dur > 0) a.durations.push(dur);
      if (spanAttr<boolean>(s, 'agent.output.truncated')) a.truncatedCount++;
      if (spanAttr<boolean>(s, 'agent.output.empty')) a.emptyCount++;
    }
  }
  return Object.entries(acc).map(([agentName, d]) => ({
    agentName,
    invocations: d.invocations,
    errors: d.errors,
    hasRateLimit: d.hasRateLimit,
    rateLimitEvents: d.rateLimitEvents,
    totalOutputSize: d.totalOutputSize,
    avgOutputSize: d.invocations > 0 ? Math.round(d.totalOutputSize / d.invocations) : 0,
    avgDurationMs: Math.round(arrayAvg(d.durations) ?? 0),
    truncatedCount: d.truncatedCount,
    emptyCount: d.emptyCount,
  }));
}

function computeEvalBreakdown(evaluations: EvaluationResult[]) {
  const evalByName: Record<string, { count: number; scores: number[] }> = {};
  for (const ev of evaluations) {
    const name = ev.evaluationName;
    if (!evalByName[name]) evalByName[name] = { count: 0, scores: [] };
    evalByName[name].count++;
    if (isValidScore(ev.scoreValue)) {
      evalByName[name].scores.push(ev.scoreValue);
    }
  }
  return Object.entries(evalByName).map(([name, d]) => {
    const sorted = d.scores.sort((a, b) => a - b);
    const avg = arrayAvg(sorted);
    return {
      name,
      count: d.count,
      avg: avg != null ? +avg.toFixed(3) : null,
      min: sorted.length > 0 ? +sorted[0].toFixed(3) : null,
      max: sorted.length > 0 ? +sorted[sorted.length - 1].toFixed(3) : null,
    };
  });
}

function computeSessionDetail(
  sessionId: string,
  spans: SessionSpan[],
  evaluations: EvaluationResult[],
) {
  const dataSources = computeDataSources(spans, evaluations);
  const timespan = computeTimespan(evaluations);
  const sessionInfo = computeSessionInfo(spans);
  const { tokenProgression, tokenTotals } = computeTokenMetrics(spans);
  const { toolUsage, mcpUsage } = computeUsageCounts(spans);
  const { spanBreakdown, hookLatency } = computeSpanLatency(spans);
  const errors = computeErrorSummary(spans);
  const agentActivity = computeAgentActivity(spans);
  const evaluationBreakdown = computeEvalBreakdown(evaluations);

  // File access (top 30)
  const fileCount: Record<string, number> = {};
  for (const s of spans) {
    const fp = spanAttr<string>(s, 'builtin.file_path');
    if (fp) fileCount[fp] = (fileCount[fp] ?? 0) + 1;
  }
  const fileAccess = Object.entries(fileCount)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  // Git commits
  const gitCommits = spans
    .filter(s => spanAttr<string>(s, 'hook.name') === HOOK_NAMES.POST_COMMIT_REVIEW)
    .map(s => {
      const raw = spanAttr<string>(s, 'git.command') ?? '';
      const filesMatch = raw.match(/git add (.+?)(?:\s+&&)/s);
      const files = filesMatch ? filesMatch[1].trim() : '';
      const msgMatch = raw.match(/<<'?EOF'?\n([\s\S]+?)\nCo-Authored/);
      const fullMessage = msgMatch ? msgMatch[1] : '';
      const subject = fullMessage ? fullMessage.split('\n')[0].trim() : raw.slice(0, 80);
      const body = fullMessage ? fullMessage.split('\n').slice(2).join('\n').trim() : '';
      return { subject, body, files };
    });

  // Alert summary
  const alertSpans = spans.filter(s => spanAttr<string>(s, 'hook.name') === HOOK_NAMES.ALERT_EVALUATION);
  const alertSummary = {
    totalFired: alertSpans.reduce((sum, s) => sum + (spanAttr<number>(s, 'alerts.triggered_count') ?? 0), 0),
    stopEvents: alertSpans.length,
  };

  // Code structure
  const codeStructure = spans
    .filter(s => spanAttr<string>(s, 'hook.name') === HOOK_NAMES.CODE_STRUCTURE)
    .map(s => ({
      file: spanAttr<string>(s, 'code.structure.file') ?? '',
      lines: spanAttr<number>(s, 'code.structure.lines') ?? 0,
      exports: spanAttr<number>(s, 'code.structure.exports') ?? 0,
      functions: spanAttr<number>(s, 'code.structure.functions') ?? 0,
      hasTypes: spanAttr<boolean>(s, 'code.structure.has_types') ?? false,
      score: spanAttr<number>(s, 'code.structure.score') ?? 0,
      tool: spanAttr<string>(s, 'code.structure.tool') ?? '',
    }));

  // Multi-agent evaluation
  const agentMapForEval = new Map<number, string>();
  spans.forEach((span, i) => {
    const agent = spanAttr<string>(span, 'agent.name');
    if (agent) agentMapForEval.set(i, agent);
  });
  const stepScores: StepScore[] = spans.map((span, i) => ({
    step: i,
    score: spanAttr<number>(span, 'evaluation.score')
      ?? (span.status?.code === 2 ? 0 : 1),
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

async function main(): Promise<void> {
  const backend = new MultiDirectoryBackend(undefined, true);
  if (WRITE_BUDGET < MIN_TRACE_BUDGET + 10) {
    console.warn(`[sync-to-kv] --budget=${WRITE_BUDGET} is below recommended minimum (${MIN_TRACE_BUDGET + 10}); high-priority entries may be skipped`);
  }

  const now = new Date();
  const entries: KVEntry[] = [];

  // Cache grouped evals per period for reuse in trend loop
  const groupedByPeriod = new Map<string, Map<string, EvaluationResult[]>>();

  // Dashboard summaries and role views per period
  for (const period of PERIODS) {
    const ms = PERIOD_MS[period];
    if (ms > MAX_DAYS_MS) continue;

    const start = new Date(now.getTime() - ms);
    const dates = { start: start.toISOString(), end: now.toISOString() };
    const evals = await backend.queryEvaluations({
      startDate: dates.start,
      endDate: dates.end,
      limit: QUERY_LIMIT,
    });
    if (evals.length === QUERY_LIMIT) {
      console.warn(`[sync-to-kv] Query returned ${QUERY_LIMIT} results for period ${period} — data may be truncated`);
    }

    const filtered = filterCanary(evals);

    const grouped = new Map<string, typeof filtered>();
    for (const ev of filtered) {
      const name = ev.evaluationName;
      pushToGroup(grouped, name, ev);
    }
    groupedByPeriod.set(period, grouped);

    const dashboard = computeDashboardSummary(grouped, undefined, dates);
    entries.push({ key: `dashboard:${period}`, value: JSON.stringify(dashboard) });

    for (const role of ROLES) {
      const view = computeRoleView(dashboard, role);
      entries.push({ key: `dashboard:${period}:${role}`, value: JSON.stringify(view) });
    }

    // Correlations
    const metricTimeSeries = new Map<string, number[]>();
    const corrMetricNames: string[] = [];
    for (const [name, metricEvals] of grouped) {
      metricTimeSeries.set(name, metricEvals.map(e => e.scoreValue).filter(isValidScore));
      corrMetricNames.push(name);
    }
    const correlations = computeCorrelationMatrix(metricTimeSeries);
    entries.push({
      key: `correlations:${period}`,
      value: JSON.stringify({ correlations, metrics: corrMetricNames }),
    });

    // Coverage (both inputKey variants)
    for (const inputKey of ['traceId', 'sessionId'] as const) {
      const heatmap = computeCoverageHeatmap(grouped, { inputKey });
      entries.push({
        key: `coverage:${period}:${inputKey}`,
        value: JSON.stringify({ period, ...heatmap }),
      });
    }

    // Pipeline
    const pipeline = computePipelineView(grouped, dashboard);
    entries.push({
      key: `pipeline:${period}`,
      value: JSON.stringify({ period, ...pipeline }),
    });
  }

  // Metric details (7d window)
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const metricNames = Object.keys(QUALITY_METRICS);

  for (const name of metricNames) {
    const config = getQualityMetric(name);
    if (!config) continue;
    const rawEvals = await backend.queryEvaluations({
      startDate: weekAgo.toISOString(),
      endDate: now.toISOString(),
      evaluationName: name,
      limit: QUERY_LIMIT,
    });
    const evals = filterCanary(rawEvals);
    if (evals.length === 0) continue;
    const detail = computeMetricDetail(evals, config as QualityMetricConfig, {
      topN: 5,
      bucketCount: 10,
    });
    entries.push({ key: `metric:${name}`, value: JSON.stringify(detail) });
  }

  // Collect trace IDs referenced by metric detail worstEvaluations
  const referencedTraceIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.key.startsWith('metric:')) continue;
    try {
      const detail = JSON.parse(entry.value) as {
        worstEvaluations?: Array<{ traceId?: string }>;
      };
      for (const w of detail.worstEvaluations ?? []) {
        if (w.traceId) referencedTraceIds.add(w.traceId);
      }
    } catch { /* skip malformed */ }
  }
  console.log(`Collected ${referencedTraceIds.size} trace IDs referenced by metric cards`);

  // Trend data per metric × period (10 buckets) — reuses cached grouped evals
  const TREND_BUCKETS = 10;
  for (const period of PERIODS) {
    const ms = PERIOD_MS[period];
    if (ms > MAX_DAYS_MS) continue;
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
        const ts = new Date(ev.timestamp).getTime();
        const idx = Math.min(Math.floor((ts - start.getTime()) / bucketMs), TREND_BUCKETS - 1);
        if (idx >= 0 && isValidScore(ev.scoreValue)) {
          timeBuckets[idx].scores.push(ev.scoreValue);
          timeBuckets[idx].evals.push(ev);
        }
      }

      const periodHours = ms / (TREND_BUCKETS * 3600000);
      let previousTrend: MetricTrend | undefined;
      const trendData = timeBuckets.map((bucket, idx) => {
        const { scores } = bucket;
        const percentiles = computePercentileDistribution(scores);
        const avg = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
        const previousValues = (idx > 0 && timeBuckets[idx - 1].scores.length > 0)
          ? computeAggregations(timeBuckets[idx - 1].scores, config.aggregations)
          : undefined;
        const detail = scores.length > 0
          ? computeMetricDetail(bucket.evals, config as QualityMetricConfig, { topN: 0, bucketCount: 0, previousValues })
          : undefined;
        let dynamics = undefined;
        if (detail?.trend) {
          dynamics = computeMetricDynamics(detail.trend, previousTrend, periodHours);
          previousTrend = detail.trend;
        }
        return {
          startTime: bucket.startTime,
          endTime: bucket.endTime,
          count: scores.length,
          avg: avg != null ? Math.round(avg * 10000) / 10000 : null,
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
        value: JSON.stringify({
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

  // Per-trace evaluations and spans
  const thirtyDaysAgo = new Date(now.getTime() - PERIOD_MS['30d']);
  const allEvals = await backend.queryEvaluations({
    startDate: thirtyDaysAgo.toISOString(),
    endDate: now.toISOString(),
    limit: QUERY_LIMIT,
  });
  const evalsByTrace = new Map<string, EvaluationResult[]>();
  for (const ev of allEvals) {
    if (!ev.traceId) continue;
    pushToGroup(evalsByTrace, ev.traceId, ev);
  }
  const traceIds = [...evalsByTrace.keys()];
  console.log(`Found ${traceIds.length} unique traces with evaluations`);

  // Query all spans once for the period and group by traceId
  const allSpans = await backend.queryTraces({
    startDate: thirtyDaysAgo.toISOString(),
    endDate: now.toISOString(),
    limit: 50000,
  });
  const spansByTrace = new Map<string, typeof allSpans>();
  for (const span of allSpans) {
    if (!span.traceId) continue;
    pushToGroup(spansByTrace, span.traceId, span);
  }

  const traceEntries: KVEntry[] = [];
  for (const traceId of traceIds) {
    const traceEvals = evalsByTrace.get(traceId) ?? [];
    const spans = spansByTrace.get(traceId) ?? [];
    traceEntries.push({
      key: `evaluations:trace:${traceId}`,
      value: JSON.stringify({ evaluations: traceEvals }),
    });
    traceEntries.push({
      key: `trace:${traceId}`,
      value: JSON.stringify({ traceId, spans, evaluations: traceEvals }),
    });
  }
  console.log(`Computed ${traceEntries.length} trace KV entries`);

  // ---- Pre-compute session detail data ----
  // Single pass: group spans by session and build traceId → sessionId mapping
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

  // Cross-session agent accumulator
  type AgentAccumulator = {
    totalInvocations: number; totalErrors: number; rateLimitEvents: number;
    totalOutputSize: number; weightedDurationSum: number; sessionDurations: number[];
    truncatedCount: number; emptyCount: number;
    sessions: Array<{
      sessionId: string; invocations: number; errors: number; hasRateLimit: boolean;
      avgDurationMs: number; date: string | null; project: string | null;
    }>;
  };
  const agentCrossSession = new Map<string, AgentAccumulator>();

  const sessionEntries: KVEntry[] = [];
  for (const [sessionId, sessionSpans] of spansBySession) {
    const evaluations = evalsBySession.get(sessionId) ?? [];
    const detail = computeSessionDetail(sessionId, sessionSpans, evaluations);
    sessionEntries.push({
      key: `session:${sessionId}`,
      value: JSON.stringify(detail),
    });

    // Accumulate agent cross-session stats from detail
    for (const ag of detail.agentActivity) {
      let acc = agentCrossSession.get(ag.agentName);
      if (!acc) {
        acc = {
          totalInvocations: 0, totalErrors: 0, rateLimitEvents: 0,
          totalOutputSize: 0, weightedDurationSum: 0, sessionDurations: [],
          truncatedCount: 0, emptyCount: 0, sessions: [],
        };
        agentCrossSession.set(ag.agentName, acc);
      }
      acc.totalInvocations += ag.invocations;
      acc.totalErrors += ag.errors;
      acc.rateLimitEvents += ag.rateLimitEvents;
      acc.totalOutputSize += ag.totalOutputSize;
      acc.truncatedCount += ag.truncatedCount;
      acc.emptyCount += ag.emptyCount;
      // One duration entry per session (weighted avg computed from sum + totalInvocations)
      if (ag.avgDurationMs > 0) {
        acc.weightedDurationSum += ag.avgDurationMs * ag.invocations;
        acc.sessionDurations.push(ag.avgDurationMs);
      }
      acc.sessions.push({
        sessionId,
        invocations: ag.invocations,
        errors: ag.errors,
        hasRateLimit: ag.hasRateLimit,
        avgDurationMs: ag.avgDurationMs,
        date: detail.timespan?.start ?? null,
        project: detail.sessionInfo?.projectName ?? null,
      });
    }
  }
  console.log(`Computed ${sessionEntries.length} session KV entries`);

  // Build agent KV entries
  const agentEntries: KVEntry[] = [];
  const agentSummaryList: Array<{
    agentName: string; totalSessions: number; totalInvocations: number;
    errorRate: number; lastSeen: string | null;
  }> = [];
  const computedAt = now.toISOString();

  for (const [agentName, acc] of agentCrossSession) {
    // Sort sessions by date descending, take last 20
    acc.sessions.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.localeCompare(a.date);
    });
    const lastSeen = acc.sessions[0]?.date ?? null;
    const totalSessions = acc.sessions.length;
    const sessions = acc.sessions.slice(0, 20);
    const sortedSessionDurations = acc.sessionDurations.sort((a, b) => a - b);

    const detail = {
      agentName,
      totalSessions,
      totalInvocations: acc.totalInvocations,
      totalErrors: acc.totalErrors,
      errorRate: acc.totalInvocations > 0 ? +(acc.totalErrors / acc.totalInvocations).toFixed(4) : 0,
      rateLimitEvents: acc.rateLimitEvents,
      avgOutputSize: acc.totalInvocations > 0 ? Math.round(acc.totalOutputSize / acc.totalInvocations) : 0,
      avgDurationMs: acc.totalInvocations > 0
        ? Math.round(acc.weightedDurationSum / acc.totalInvocations)
        : 0,
      p95DurationMs: sortedSessionDurations.length > 0 ? Math.round(percentile(sortedSessionDurations, 95)) : 0,
      truncatedRate: acc.totalInvocations > 0 ? +(acc.truncatedCount / acc.totalInvocations).toFixed(4) : 0,
      emptyOutputRate: acc.totalInvocations > 0 ? +(acc.emptyCount / acc.totalInvocations).toFixed(4) : 0,
      lastSeen,
      computedAt,
      sessions,
    };

    agentEntries.push({ key: `agent:${agentName}`, value: JSON.stringify(detail) });
    agentSummaryList.push({
      agentName,
      totalSessions,
      totalInvocations: acc.totalInvocations,
      errorRate: detail.errorRate,
      lastSeen,
    });
  }

  // Sort agent list by invocations descending
  agentSummaryList.sort((a, b) => b.totalInvocations - a.totalInvocations);
  agentEntries.push({ key: 'meta:agents', value: JSON.stringify(agentSummaryList) });
  console.log(`Computed ${agentEntries.length - 1} agent KV entries + meta:agents`);

  const allEntries = [...entries, ...sessionEntries, ...traceEntries, ...agentEntries];
  const totalComputed = allEntries.length;

  // ---- Delta sync: skip unchanged entries ----
  const prevState = loadSyncState();
  const changed = filterChanged(allEntries, prevState);
  console.log(`Computed ${totalComputed} total KV entries, ${changed.length} changed since last sync`);

  if (changed.length === 0) {
    // Still update lastSync timestamp
    const metaEntry: KVEntry = { key: 'meta:lastSync', value: JSON.stringify(now.toISOString()) };
    if (prevState['meta:lastSync'] !== hashValue(metaEntry.value)) {
      kvBulkPut([metaEntry]);
      prevState['meta:lastSync'] = hashValue(metaEntry.value);
      saveSyncState(prevState);
    }
    // L1: Refresh lastChecked in the local sidecar so it reflects this run even when nothing changed.
    // KV consumers can use meta:lastSync (written above) to see when sync last ran; updating
    // meta:syncCoverage in KV here would burn 1 write per no-op run without changing stable data.
    const prevCoverage = loadLastCoverage();
    if (prevCoverage) {
      saveLastCoverage({ ...prevCoverage, lastChecked: now.toISOString() });
    }
    console.log('No changes to sync');
    return;
  }

  // ---- Budget enforcement with trace reservation ----
  const isTraceKey = (e: KVEntry) =>
    e.key.startsWith('trace:') || e.key.startsWith('evaluations:trace:');
  const highPriority = changed.filter(e => !isTraceKey(e));
  const traceChanged = changed.filter(isTraceKey);
  const { highPriorityBudget, traceBudget } = computeBudgetAllocation(highPriority.length, WRITE_BUDGET);

  // Phase 3: prioritize traces by evaluation quality
  const prioritizedTraces = prioritizeTraces(traceChanged, evalsByTrace, referencedTraceIds);

  const toWrite: KVEntry[] = [
    ...highPriority.slice(0, highPriorityBudget),
    ...prioritizedTraces.slice(0, traceBudget),
    { key: 'meta:lastSync', value: JSON.stringify(now.toISOString()) },
  ];
  const deferred = changed.length - (toWrite.length - 1); // -1 excludes meta:lastSync

  const referencedInBatch = new Set(
    toWrite
      .map(e => extractTraceId(e.key))
      .filter((id): id is string => id != null && referencedTraceIds.has(id)),
  ).size;
  console.log(`Trace budget: ${traceBudget}/${traceChanged.length} changed traces`);
  console.log(`Referenced traces in this batch: ${referencedInBatch}/${referencedTraceIds.size}`);

  if (deferred > 0) {
    console.log(`Budget ${WRITE_BUDGET}: writing ${toWrite.length} entries, deferring ${deferred} to next run`);
  }

  const written = kvBulkPut(toWrite);

  // ---- Update state only for entries actually written ----
  const newState = { ...prevState };
  for (const e of toWrite.slice(0, written)) {
    newState[e.key] = hashValue(e.value);
  }
  // Prune keys from state that no longer exist in computed set
  const computedKeys = new Set(allEntries.map(e => e.key));
  computedKeys.add('meta:lastSync');
  computedKeys.add('meta:syncCoverage');
  for (const key of Object.keys(newState)) {
    if (!computedKeys.has(key)) delete newState[key];
  }
  saveSyncState(newState);

  // ---- Sync coverage metrics ----
  // syncedTraces reflects best-known state from the local state file, not a confirmed live KV scan.
  // It may over-count if a prior wrangler write failed silently.
  const syncedTraceKeys = Object.keys(newState).filter(k => k.startsWith('trace:'));
  const syncedReferencedCount = syncedTraceKeys
    .filter(k => referencedTraceIds.has(k.slice('trace:'.length))).length;
  const coverage = {
    totalTraces: traceIds.length,
    syncedTraces: syncedTraceKeys.length,
    coveragePercent: traceIds.length > 0
      ? Math.round(syncedTraceKeys.length / traceIds.length * 10000) / 100
      : 100,
    referencedCoverage: referencedTraceIds.size > 0
      ? Math.round(syncedReferencedCount / referencedTraceIds.size * 10000) / 100
      : 100,
    // runsRemaining: additional runs after this one needed to drain the trace backlog
    runsRemaining: traceBudget > 0
      ? Math.ceil(Math.max(0, traceChanged.length - traceBudget) / traceBudget)
      : (traceChanged.length > 0 ? null : 0),
    // timestamp: when stable coverage numbers were last computed/changed (not updated on no-op runs)
    timestamp: now.toISOString(),
    // lastChecked: when sync last ran regardless of whether data changed (refreshed even on no-op runs)
    lastChecked: now.toISOString(),
  };
  // N3: Exclude lastChecked (and timestamp) from the change-detection hash so a new timestamp alone
  // does not burn a KV write every run. Only the stable numeric fields gate whether we write.
  const { lastChecked: _lc, timestamp: _ts, ...stableCoverage } = coverage;
  const coverageHash = hashValue(JSON.stringify(stableCoverage));
  const coverageEntry: KVEntry = { key: 'meta:syncCoverage', value: JSON.stringify(coverage) };
  if (newState['meta:syncCoverage'] !== coverageHash) {
    const coverageWritten = kvBulkPut([coverageEntry]);
    if (coverageWritten > 0) {
      newState['meta:syncCoverage'] = coverageHash;
      saveSyncState(newState);
    }
  }
  // L1: Persist coverage data so the early-return path can refresh lastChecked without recomputing.
  saveLastCoverage(coverage);

  const limitDeferred = Math.max(0, toWrite.length - 1 - written); // -1 excludes meta:lastSync
  const actualDeferred = deferred + limitDeferred;
  console.log(`Sync complete: wrote ${written} entries (${actualDeferred} deferred, ${totalComputed} total computed)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
