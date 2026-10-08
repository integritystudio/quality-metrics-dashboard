/**
 * The session detail, built once for both the API route (`sessions.ts`) and the
 * KV sync script (`sync-to-kv.ts`). Each path once built its own copy, and the
 * two drifted (SESSION-DETAIL-DRIFT, see dashboard BACKLOG.md); callers now pass
 * in only what differs (logs, truncation flags, the multi-agent evaluator).
 *
 * Adding a field: add it to `computeSessionDetail`, and both paths carry it.
 */

import { ascending, mean, quantileSorted, rollup } from 'd3-array';
import {
  COMMIT_BODY_START_LINE_INDEX,
  COMMIT_SUBJECT_FALLBACK_MAX_CHARS,
  FILE_ACCESS_TOP_N,
  HOOK_NAME,
  LATENCY_DISPLAY_PRECISION,
  LATENCY_P50,
  LATENCY_P95,
  LOG_SUMMARY_MAX_ENTRIES,
  OTEL_STATUS_ERROR_CODE,
  PERCENT_BASE,
  gitRepositoryLabel,
  incrementCount,
  logSummaryFieldSchema,
  renamedAttr,
  spanAttr,
  timestampToMs,
  type SafeLogEntry,
} from './api-constants.js';
import { SCORE_DISPLAY_PRECISION, TIME_MS } from '../lib/constants.js';
import type { StepScore } from '../types.js';

/** Minimal shape required by the span-extraction helpers. */
export type ExtractableSpan = {
  name: string;
  status?: { code?: number | string };
  attributes?: Record<string, unknown>;
};

/**
 * Whether a span should count as an error.
 *
 * Accepts both the numeric OTel status code (`2`) and the string form
 * (`'ERROR'`) because cloud spans may carry either depending on the SDK
 * version that emitted them.
 */
export function isSpanError(span: ExtractableSpan): boolean {
  return (
    spanAttr(span, 'integritystudio.tool.has_error', 'boolean') === true ||
    spanAttr(span, 'integritystudio.agent.has_error', 'boolean') === true ||
    span.status?.code === OTEL_STATUS_ERROR_CODE ||
    span.status?.code === 'ERROR'
  );
}

export interface GitCommit {
  subject: string;
  body: string;
  files: string;
}

/** Parse a git commit from a post-commit-review span; returns `null` when no command is present. */
export function extractGitCommit(span: ExtractableSpan): GitCommit | null {
  const raw = spanAttr(span, 'integritystudio.git.command', 'string') ?? '';
  if (!raw) return null;
  const filesMatch = raw.match(/git add (.+?)(?:\s+&&)/s);
  const files = filesMatch ? (filesMatch[1] ?? '').trim() : '';
  const msgMatch = raw.match(/<<'?EOF'?\n([\s\S]+?)\nCo-Authored/);
  const fullMessage = msgMatch ? msgMatch[1] ?? '' : '';
  return {
    subject: fullMessage ? (fullMessage.split('\n')[0] ?? '').trim() : raw.slice(0, COMMIT_SUBJECT_FALLBACK_MAX_CHARS),
    body: fullMessage ? fullMessage.split('\n').slice(COMMIT_BODY_START_LINE_INDEX).join('\n').trim() : '',
    files,
  };
}

/** The span fields the session detail reads. */
export type SessionSpan = ExtractableSpan & { traceId?: string; durationMs?: number };

/** The evaluation fields the session detail reads; the rows are returned as given. */
export type SessionEvaluation = {
  evaluationName: string;
  scoreValue?: number | null;
  timestamp: Parameters<typeof timestampToMs>[0];
};

/** The log fields the session detail reads; the API reads logs, the KV sync has none. */
export type SessionLog = {
  timestamp: Parameters<typeof timestampToMs>[0];
  severity: string;
  traceId?: string;
};

/**
 * Scores a session's steps per agent. Injected because the parent's evaluator
 * reaches each caller by a different route: the API through its `parent/`
 * barrel, the sync script from the parent's source.
 */
export type MultiAgentEvaluator<M> = (stepScores: StepScore[], agentMap: Map<number, string>) => M;

export interface SessionDetailInput<E extends SessionEvaluation> {
  sessionId: string;
  spans: SessionSpan[];
  evaluations: E[];
  logs?: SessionLog[];
  /** The span read was cut short, so every span-derived field is partial. */
  spansTruncated?: boolean;
  /** The evaluation read was cut short, so every evaluation-derived field is partial. */
  evaluationsTruncated?: boolean;
}

export interface AgentActivityEntry {
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

// Max ms value safe for Date.toISOString() — ±100,000,000 days from epoch (ECMAScript spec).
const DATE_ISO_SAFE_MAX_MS = 8_640_000_000_000_000;

/**
 * {@link timestampToMs} plus a range guard: null for empty, missing, NaN, or out-of-range values that would
 * corrupt the timespan bounds or cause Date.toISOString() to throw.
 */
function parseTimestamp(value: Parameters<typeof timestampToMs>[0]): number | null {
  const ms = timestampToMs(value);
  return Number.isFinite(ms) && Math.abs(ms) <= DATE_ISO_SAFE_MAX_MS ? ms : null;
}

function isValidScore(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function hookSpans(spans: SessionSpan[], hookName: string): SessionSpan[] {
  return spans.filter(s => spanAttr(s, 'integritystudio.hook.name', 'string') === hookName);
}

/** `truncated` is written only when set, so a complete read keeps the shape older KV values have. */
function truncationFlag(truncated: boolean | undefined) {
  return truncated ? { truncated: true } : {};
}

function computeDataSources(
  spans: SessionSpan[],
  logs: SessionLog[],
  evaluations: SessionEvaluation[],
  spansTruncated?: boolean,
  evaluationsTruncated?: boolean,
) {
  const traceIds = new Set<string>();
  for (const s of spans) {
    if (s.traceId) traceIds.add(s.traceId);
  }
  return {
    traces: { count: spans.length, traceIds: traceIds.size, ...truncationFlag(spansTruncated) },
    logs: { count: logs.length },
    evaluations: { count: evaluations.length, ...truncationFlag(evaluationsTruncated) },
    total: spans.length + logs.length + evaluations.length,
  };
}

function computeTimespan(evaluations: SessionEvaluation[], logs: SessionLog[]) {
  let tsMin = Infinity;
  let tsMax = -Infinity;
  for (const row of [...evaluations, ...logs]) {
    const t = parseTimestamp(row.timestamp);
    if (t === null) continue;
    if (t < tsMin) tsMin = t;
    if (t > tsMax) tsMax = t;
  }
  return tsMin < Infinity ? {
    start: new Date(tsMin).toISOString(),
    end: new Date(tsMax).toISOString(),
    durationHours: +((tsMax - tsMin) / TIME_MS.HOUR).toFixed(LATENCY_DISPLAY_PRECISION),
  } : null;
}

function computeSessionInfo(spans: SessionSpan[]) {
  const sessionStarts = hookSpans(spans, HOOK_NAME.SESSION_START);
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
  const tokenProgression = hookSpans(spans, HOOK_NAME.TOKEN_METRICS)
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
    if (spanAttr(s, 'integritystudio.hook.trigger', 'string') !== 'PostToolUse') continue;
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
      p50: +(quantileSorted(sorted, LATENCY_P50 / PERCENT_BASE) ?? 0).toFixed(LATENCY_DISPLAY_PRECISION),
      p95: +(quantileSorted(sorted, LATENCY_P95 / PERCENT_BASE) ?? 0).toFixed(LATENCY_DISPLAY_PRECISION),
      max: +(sorted.at(-1) ?? 0).toFixed(LATENCY_DISPLAY_PRECISION),
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
    hookSpans(spans, HOOK_NAME.AGENT_FINALIZE),
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

function computeEvalBreakdown(evaluations: SessionEvaluation[]) {
  const evalByName = rollup(
    evaluations,
    group => ({ count: group.length, scores: group.map(ev => ev.scoreValue).filter(isValidScore) }),
    ev => ev.evaluationName,
  );
  return Array.from(evalByName, ([name, d]) => {
    const sorted = d.scores.sort(ascending);
    const avg = mean(sorted);
    return {
      name,
      count: d.count,
      avg: avg != null ? +avg.toFixed(SCORE_DISPLAY_PRECISION) : null,
      min: sorted.length > 0 ? +(sorted[0] ?? 0).toFixed(SCORE_DISPLAY_PRECISION) : null,
      max: sorted.length > 0 ? +(sorted.at(-1) ?? 0).toFixed(SCORE_DISPLAY_PRECISION) : null,
    };
  });
}

function computeFileAccess(spans: SessionSpan[]) {
  const fileCount: Record<string, number> = {};
  for (const s of spans) {
    const fp = spanAttr(s, 'file.path', 'string');
    if (fp) incrementCount(fileCount, fp);
  }
  return Object.entries(fileCount)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, FILE_ACCESS_TOP_N);
}

function computeAlertSummary(spans: SessionSpan[]) {
  const alertSpans = hookSpans(spans, HOOK_NAME.ALERT_EVALUATION);
  return {
    totalFired: alertSpans.reduce((sum, s) => sum + (renamedAttr(s, 'integritystudio.alerts.triggered_count', 'alerts.triggered_count', 'number') ?? 0), 0),
    stopEvents: alertSpans.length,
  };
}

function computeCodeStructure(spans: SessionSpan[]) {
  return hookSpans(spans, HOOK_NAME.CODE_STRUCTURE).map(s => ({
    file: spanAttr(s, 'integritystudio.code.structure.file', 'string') ?? '',
    lines: spanAttr(s, 'integritystudio.code.structure.lines', 'number') ?? 0,
    exports: spanAttr(s, 'integritystudio.code.structure.exports', 'number') ?? 0,
    functions: spanAttr(s, 'integritystudio.code.structure.functions', 'number') ?? 0,
    hasTypes: spanAttr(s, 'integritystudio.code.structure.has_types', 'boolean') ?? false,
    score: spanAttr(s, 'integritystudio.code.structure.score', 'number') ?? 0,
    tool: spanAttr(s, 'integritystudio.code.structure.tool', 'string') ?? '',
  }));
}

function computeLogSummary(logs: SessionLog[]) {
  const bySeverity: Record<string, number> = {};
  for (const l of logs) incrementCount(bySeverity, l.severity);
  return {
    bySeverity,
    logs: logs.slice(-LOG_SUMMARY_MAX_ENTRIES).map(l => {
      const entry: SafeLogEntry = {};
      for (const key of logSummaryFieldSchema.options) {
        const val = l[key];
        if (val !== undefined) (entry as Record<string, unknown>)[key] = val;
      }
      return entry;
    }),
  };
}

/** Each span's agent by span index; a span with no `gen_ai.agent.name` is left out. */
export function sessionAgentMap(spans: SessionSpan[]): Map<number, string> {
  const agentMap = new Map<number, string>();
  spans.forEach((span, i) => {
    // Hooks emit the semconv 'gen_ai.agent.name'. The pre-OBP7b 'agent.name' stopped
    // on 2026-07-12, older than every window a session is read over, so it is not read.
    const agent = spanAttr(span, 'gen_ai.agent.name', 'string');
    if (agent) agentMap.set(i, agent);
  });
  return agentMap;
}

/** One step per span: its `evaluation.score`, else 0 when the span errored and 1 when it did not. */
export function sessionStepScores(spans: SessionSpan[]): StepScore[] {
  return spans.map((span, i) => ({
    step: i,
    score: spanAttr(span, 'evaluation.score', 'number') ?? (isSpanError(span) ? 0 : 1),
    explanation: span.name,
  }));
}

export function computeSessionDetail<E extends SessionEvaluation, M>(
  { sessionId, spans, evaluations, logs = [], spansTruncated, evaluationsTruncated }: SessionDetailInput<E>,
  evaluateMultiAgent: MultiAgentEvaluator<M>,
) {
  const { tokenProgression, tokenTotals } = computeTokenMetrics(spans);
  const { toolUsage, mcpUsage } = computeUsageCounts(spans);
  const { spanBreakdown, hookLatency } = computeSpanLatency(spans);
  // Key order is part of the KV value: the sync's change hash covers it, so reordering rewrites every session key.
  return {
    sessionId,
    dataSources: computeDataSources(spans, logs, evaluations, spansTruncated, evaluationsTruncated),
    timespan: computeTimespan(evaluations, logs),
    sessionInfo: computeSessionInfo(spans),
    tokenTotals,
    tokenProgression,
    toolUsage,
    mcpUsage,
    spanBreakdown,
    hookLatency,
    errors: computeErrorSummary(spans),
    agentActivity: computeAgentActivity(spans),
    fileAccess: computeFileAccess(spans),
    gitCommits: hookSpans(spans, HOOK_NAME.POST_COMMIT_REVIEW).flatMap(s => {
      const commit = extractGitCommit(s);
      return commit ? [commit] : [];
    }),
    alertSummary: computeAlertSummary(spans),
    codeStructure: computeCodeStructure(spans),
    evaluationBreakdown: computeEvalBreakdown(evaluations),
    logSummary: computeLogSummary(logs),
    multiAgentEvaluation: evaluateMultiAgent(sessionStepScores(spans), sessionAgentMap(spans)),
    evaluations,
  };
}
