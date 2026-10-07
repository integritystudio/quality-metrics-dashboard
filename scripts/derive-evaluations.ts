#!/usr/bin/env tsx
/**
 * Derive rule-based evaluations from trace data and post them to ingest.
 *
 * Reads spans from obtool-api (`/v1/traces`, one query per `OBTOOL_API_KEY*`
 * account in the environment) or, with `--source=local`, from
 * `traces-*.jsonl`. Without `--date=`/`--days=`, the cloud source reads the
 * last `DERIVE_DEFAULT_DAYS`, as populate does, and the local source reads
 * every trace file. `--source=local` is kept for one release as the rollback
 * (cloud-read Phase 6); `derive-parity.ts` checks that the two sources agree.
 * A failed cloud read exits `DERIVE_EXIT_READ_FAILED` (9) before anything is
 * posted.
 *
 * Every record is POSTed straight to ingest (`post-evaluations.ts`) with an
 * `evaluationId` the worker dedups on, so re-posting is a no-op. An unscoped
 * run posts the last two days; an explicit `--date=`/`--days=` posts the whole
 * scope, which is how a backfill is done, unless `--post-days=N` narrows the
 * post to the last N days (populate passes 2). Records dated before
 * `DERIVE_NO_REPOST_BEFORE_MS` are never posted. Nothing is written to disk
 * except `.calibration-state.json`.
 *
 *   tsx scripts/derive-evaluations.ts --dry-run                    # what populate runs: 7 days read, 2 posted
 *   tsx scripts/derive-evaluations.ts --date=2026-10-01 --dry-run
 *   tsx scripts/derive-evaluations.ts --days=3
 *   tsx scripts/derive-evaluations.ts --source=local --days=3      # the rollback
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import {
  computeCalibrationDistributions,
  loadCalibrationState,
  saveCalibrationState,
  shouldRecalibrate,
  type CalibrationState,
} from '../../src/lib/quality/qfe-percentiles.js';
import { localTraceSpanSchema, type LocalTraceSpan, type EvaluatorType } from '../../src/lib/validation/dashboard-schemas.js';
export type { LocalTraceSpan as TraceSpan };
import { readJsonlWithValidationSync } from '../src/lib/dashboard-file-utils.js';
import { normalizeScore, EVAL_SCORE_PRECISION, TELEMETRY_DIR, CALIBRATION_STATE_DIR, SESSION_ID_PREVIEW_LEN, RULE_EVALUATOR_TYPE, SYNTHETIC_EVALUATOR_KIND as RULE_EVALUATOR_KIND, NORMAL_COHORT, TOOL_CORRECTNESS_CRITERIA, toOTelRecord, type EvalRecord } from './judge-evaluations.js';
import { toDateOnly, OTEL_STATUS_ERROR_CODE, HOOK_NAME, HOOK_SPAN_PREFIX } from '../src/api/api-constants.js';
import { canonicalizeAttributes } from '../../src/lib/observability/attribute-aliases.js';
import { ACCOUNT_INDEX_WINDOW_DAYS, buildAccountIndex, indexTraceFiles, type AccountRef } from './account-stamps.js';
import { emptyAccountIndex, formatPostSummary, postEvaluationRecords } from './post-evaluations.js';
import { loadCloudSpans, type LoadedSpans } from './cloud-trace-source.js';
import { DAYS_FLAG as DAYS_ARG, DERIVE_DEFAULT_DAYS, DERIVE_DEFAULT_SOURCE, DERIVE_EXIT_INPUT_DRIFT, DERIVE_EXIT_POST_FAILED, DERIVE_EXIT_READ_FAILED, DERIVE_POST_WINDOW_DAYS, DRY_RUN_FLAG, POST_DAYS_FLAG as POST_DAYS_ARG, SOURCE_FLAG as SOURCE_ARG, TRACE_SOURCES, type TraceSource } from './pipeline-stages.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import { CliArgError, parseCli, positiveIntArg, type CliSpec } from './cli-args.js';

// EvalRecord and toOTelRecord live in judge-evaluations.ts. Both scripts write
// the same wire format, and keeping two copies is how the empty-traceId bug
// ended up needing the same fix twice. Re-exported for existing importers.
export type { EvalRecord } from './judge-evaluations.js';

/** Span attributes are `unknown`-valued; render primitives, never objects. */
/**
 * Each span's account stamp by span id, set by `main` from the raw trace lines
 * (TKR8 Phase 1). The raw lines, because `localTraceSpanSchema` strips unknown
 * keys, so the stamp never reaches the parsed spans. Empty by default, which
 * leaves every record unstamped, as before.
 */
let spanAccounts: ReadonlyMap<string, AccountRef> = new Map();

export function setSpanAccounts(accounts: ReadonlyMap<string, AccountRef>): void {
  spanAccounts = accounts;
}

/** The scored span's stamp as a record field; `{}` when the span carried none. */
function spanAccountField(span: LocalTraceSpan): Pick<EvalRecord, 'identityKeyRef'> {
  return spanAccounts.has(span.spanId) ? { identityKeyRef: spanAccounts.get(span.spanId)! } : {};
}

/**
 * A span's attributes under their canonical keys. The hooks renamed `builtin.*`
 * on 2026-09-18, so local trace files hold both spellings; reading the legacy
 * key off a post-rename span found nothing and scored every builtin tool call a
 * failure. Cloud spans arrive canonicalized already, and a bag with no legacy
 * key is returned as-is, so this is free on the cloud path.
 */
function attrsOf(span: LocalTraceSpan): Record<string, unknown> {
  return canonicalizeAttributes(span.attributes);
}

/**
 * MCP post-tool keys as `[canonical, legacy]`. The hooks moved `mcp.*` under
 * `integritystudio.` on 2026-09-29, and the alias table has no rows for them,
 * so `attrsOf` leaves an older span on the unprefixed key.
 */
const MCP_ATTR = {
  SUCCESS: ['integritystudio.mcp.success', 'mcp.success'],
  TOOL: ['integritystudio.mcp.tool', 'mcp.tool'],
  ERROR_TYPE: ['integritystudio.mcp.error_type', 'mcp.error_type'],
  SERVER: ['integritystudio.mcp.server', 'mcp.server'],
} as const satisfies Record<string, readonly [string, string]>;

/** A renamed attribute's value: the canonical key first, then the legacy one. */
function renamedValue(attrs: Record<string, unknown>, [canonical, legacy]: readonly [string, string]): unknown {
  return attrs[canonical] ?? attrs[legacy];
}

function attrString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

// Returns NaN rather than throwing on a malformed tuple, so the single caller's
// Number.isFinite guard (OBP15) is the one place a bad duration is handled. Spans read
// through localTraceSpanSchema cannot arrive malformed — zod rejects both NaN and a
// missing tuple — but deriveEvaluationLatency is exported and directly callable, and its
// contract is to return null on malformed input, never to throw.
function hrtToSeconds(hrt: [number, number]): number {
  if (!Array.isArray(hrt)) return NaN;
  return hrt[0] + hrt[1] / 1e9;
}

function hrtToISO(hrt: [number, number]): string {
  return new Date(hrt[0] * 1000 + hrt[1] / 1e6).toISOString();
}

// Used to be exported as MAX_RAW_SCORES_PER_METRIC from ../../src/lib/quality/quality-constants.ts,
// deleted there as a "dead export" (parent commit f518715) — the dashboard, a separate git repo,
// was the only consumer and wasn't swept by that change.
/** Maximum raw scores to persist per metric in calibration state (bounds file size) */
const MAX_RAW_SCORES_PER_METRIC = 500;

/**
 * The Agent tool's pre- and post-tool hook spans. Derive matched their old
 * names (`hook:agent-pre-tool` / `hook:agent-post-tool`) for six weeks after
 * the hooks renamed them, so agent completion, handoff_correctness and agent
 * hook latency produced nothing (AGENT-POST-TOOL-READERS-DEAD).
 */
const AGENT_PREPARE_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.AGENT_PREPARE}`;
const AGENT_FINALIZE_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.AGENT_FINALIZE}`;
const BUILTIN_POST_TOOL_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.BUILTIN_POST_TOOL}`;
const MCP_POST_TOOL_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.MCP_POST_TOOL}`;

function isToolSpan(span: LocalTraceSpan): boolean {
  return span.name === BUILTIN_POST_TOOL_SPAN || span.name === MCP_POST_TOOL_SPAN;
}

/** The success flag a tool span records, under the key its hook writes; not a boolean when absent. */
function toolSuccessOf(span: LocalTraceSpan, attrs: Record<string, unknown>): unknown {
  return span.name === BUILTIN_POST_TOOL_SPAN ? attrs['integritystudio.tool.success'] : renamedValue(attrs, MCP_ATTR.SUCCESS);
}

export function deriveToolCorrectness(span: LocalTraceSpan): EvalRecord | null {
  const attrs = attrsOf(span);
  if (!isToolSpan(span)) return null;
  const isBuiltin = span.name === BUILTIN_POST_TOOL_SPAN;
  const isMcp = !isBuiltin;

  const success = toolSuccessOf(span, attrs);
  const tool = attrString(isBuiltin ? attrs['gen_ai.tool.name'] : renamedValue(attrs, MCP_ATTR.TOOL), 'unknown');
  const errorType = attrString(isBuiltin ? attrs['integritystudio.tool.error_type'] : renamedValue(attrs, MCP_ATTR.ERROR_TYPE));
  const server = isMcp ? attrString(renamedValue(attrs, MCP_ATTR.SERVER)) : '';

  const score = success === true ? 1.0 : 0.0;
  const toolLabel = server ? `${server}/${tool}` : tool;

  let explanation: string;
  if (success) {
    explanation = `Tool ${toolLabel} completed successfully`;
  } else {
    explanation = `Tool ${toolLabel} failed${errorType ? `: ${errorType}` : ''}`;
  }

  return {
    timestamp: hrtToISO(span.startTime),
    evaluationName: TOOL_CORRECTNESS_CRITERIA.name,
    scoreValue: score,
    explanation,
    evaluator: RULE_EVALUATOR,
    evaluatorType: RULE_EVALUATOR_TYPE,
    evaluatorKind: RULE_EVALUATOR_KIND,
    cohort: NORMAL_COHORT,
    traceId: span.traceId,
    spanId: span.spanId,
    ...spanAccountField(span),
    sessionId: attrString(attrs['session.id']),
  };
}

export function deriveEvaluationLatency(span: LocalTraceSpan): EvalRecord | null {
  const measurable = [
    BUILTIN_POST_TOOL_SPAN,
    MCP_POST_TOOL_SPAN,
    AGENT_FINALIZE_SPAN,
    'hook:session-start',
    'hook:tsc-check',
  ];
  if (!measurable.includes(span.name)) return null;

  const durationSec = hrtToSeconds(span.duration);
  if (!Number.isFinite(durationSec)) return null;

  // Guard malformed startTime — a valid Unix timestamp has seconds > 1e9 (after 2001).
  // Spans with epoch-ish startTime (e.g. [2, 0]) are empty input spans, not hook runs.
  const [startSec] = span.startTime;
  if (startSec < 1_000_000_000) return null;

  const attrs = attrsOf(span);

  let hookType: string;
  if (span.name === BUILTIN_POST_TOOL_SPAN) hookType = `builtin/${attrString(attrs['gen_ai.tool.name'], 'unknown')}`;
  else if (span.name === MCP_POST_TOOL_SPAN) hookType = `mcp/${attrString(renamedValue(attrs, MCP_ATTR.TOOL), 'unknown')}`;
  else if (span.name === AGENT_FINALIZE_SPAN) hookType = `agent/${attrString(attrs['integritystudio.agent.type'], 'unknown')}`;
  else hookType = span.name.replace(HOOK_SPAN_PREFIX, '');

  return {
    timestamp: hrtToISO(span.startTime),
    evaluationName: 'evaluation_latency',
    scoreValue: durationSec,
    scoreUnit: 'seconds',
    explanation: `Hook ${hookType} executed in ${durationSec.toFixed(EVAL_SCORE_PRECISION)}s`,
    evaluator: RULE_EVALUATOR,
    evaluatorType: RULE_EVALUATOR_TYPE,
    evaluatorKind: RULE_EVALUATOR_KIND,
    cohort: NORMAL_COHORT,
    traceId: span.traceId,
    spanId: span.spanId,
    ...spanAccountField(span),
    sessionId: attrString(attrs['session.id']),
  };
}

interface TaskState {
  statuses: Set<string>;
  lastSpan: LocalTraceSpan;
}

interface SessionTaskData {
  tasks: Map<string, TaskState>;  // taskId -> state
  creates: number;   // fallback counters for old trace data
  updates: number;
  lastSpan: LocalTraceSpan | null;
}

const sessionTasks = new Map<string, SessionTaskData>();

export const RULE_EVALUATOR: EvaluatorType = 'rule';
export const TASK_COMPLETION_EVAL_NAME = 'task_completion';

export const STATUS_SCORES: { pending: number; in_progress: number; completed: number } = {
  pending: 0.0,
  in_progress: 0.5,
  completed: 1.0,
};

export { sessionTasks };

export function trackTaskActivity(span: LocalTraceSpan): void {
  if (span.name !== BUILTIN_POST_TOOL_SPAN) return;
  const attrs = attrsOf(span);
  const tool = attrs['gen_ai.tool.name'];
  if (tool !== 'TaskCreate' && tool !== 'TaskUpdate') return;

  const sessionId = attrString(attrs['session.id'], 'unknown');
  let entry = sessionTasks.get(sessionId);
  if (!entry) sessionTasks.set(sessionId, entry = { tasks: new Map(), creates: 0, updates: 0, lastSpan: null });
  entry.lastSpan = span;

  // Always track counts for fallback
  if (tool === 'TaskCreate') entry.creates++;
  if (tool === 'TaskUpdate') entry.updates++;

  const taskStatus = attrs['integritystudio.task.status'];
  const taskId = attrs['integritystudio.task.id'];

  if (typeof taskStatus === 'string' && taskStatus in STATUS_SCORES) {
    const id = typeof taskId === 'string' ? taskId : `anon-${span.spanId}`;
    let task = entry.tasks.get(id);
    if (!task) entry.tasks.set(id, task = { statuses: new Set(), lastSpan: span });
    task.statuses.add(taskStatus);
    task.lastSpan = span;
  }
}

export function scoreTask(statuses: Set<string>): number {
  if (statuses.has('completed')) return STATUS_SCORES.completed;
  if (statuses.has('in_progress')) return STATUS_SCORES.in_progress;
  return STATUS_SCORES.pending;
}

export function deriveTaskCompletionPerSession(): EvalRecord[] {
  const evals: EvalRecord[] = [];

  for (const [sessionId, data] of sessionTasks) {
    if (data.creates === 0 && data.tasks.size === 0) continue;
    if (!data.lastSpan) continue;
    const lastSpan = data.lastSpan;
    const sessionPreview = sessionId.slice(0, SESSION_ID_PREVIEW_LEN);

    if (data.tasks.size > 0) {
      const scores = [...data.tasks.values()].map(t => scoreTask(t.statuses));
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const completed = scores.filter(s => s === STATUS_SCORES.completed).length;
      const inProgress = scores.filter(s => s === STATUS_SCORES.in_progress).length;
      const pending = scores.filter(s => s === STATUS_SCORES.pending).length;

      const parts: string[] = [];
      if (completed > 0) parts.push(`${completed} completed`);
      if (inProgress > 0) parts.push(`${inProgress} in_progress`);
      if (pending > 0) parts.push(`${pending} pending`);

      evals.push({
        timestamp: hrtToISO(lastSpan.startTime),
        evaluationName: TASK_COMPLETION_EVAL_NAME,
        scoreValue: normalizeScore(avg),
        explanation: `Session ${sessionPreview}: ${data.tasks.size} tasks (${parts.join(', ')})`,
        evaluator: RULE_EVALUATOR,
        evaluatorType: RULE_EVALUATOR_TYPE,
        evaluatorKind: RULE_EVALUATOR_KIND,
        cohort: NORMAL_COHORT,
        traceId: lastSpan.traceId,
        spanId: lastSpan.spanId,
        ...spanAccountField(lastSpan),
        sessionId,
      });
    } else {
      // Fallback: old trace data without a task status attribute
      if (data.creates === 0) continue;
      const completionRatio = Math.min(data.updates / (data.creates * 2), 1.0);

      evals.push({
        timestamp: hrtToISO(lastSpan.startTime),
        evaluationName: TASK_COMPLETION_EVAL_NAME,
        scoreValue: normalizeScore(completionRatio),
        explanation: `Session ${sessionPreview}: ${data.creates} tasks, ${data.updates} updates (ratio fallback)`,
        evaluator: RULE_EVALUATOR,
        evaluatorType: RULE_EVALUATOR_TYPE,
        evaluatorKind: RULE_EVALUATOR_KIND,
        cohort: NORMAL_COHORT,
        traceId: lastSpan.traceId,
        spanId: lastSpan.spanId,
        ...spanAccountField(lastSpan),
        sessionId,
      });
    }
  }

  return evals;
}

interface AgentSessionData {
  pre: number;
  post: number;
  spans: LocalTraceSpan[];
  /** Ordered agent names per post-tool span, used for handoff detection */
  agentSequence: { agentName: string; score: number; span: LocalTraceSpan }[];
}
const sessionAgents = new Map<string, AgentSessionData>();

function trackAgentActivity(span: LocalTraceSpan): void {
  const isPre = span.name === AGENT_PREPARE_SPAN;
  const isPost = span.name === AGENT_FINALIZE_SPAN;
  if (!isPre && !isPost) return;

  const sessionId = attrString(span.attributes['session.id'], 'unknown');
  let entry = sessionAgents.get(sessionId);
  if (!entry) sessionAgents.set(sessionId, entry = { pre: 0, post: 0, spans: [], agentSequence: [] });
  if (isPre) entry.pre++;
  if (isPost) {
    entry.post++;
    const agentName = attrString(span.attributes['gen_ai.agent.name'], 'unknown');
    const score = span.status?.code === OTEL_STATUS_ERROR_CODE ? 0 : 1;
    entry.agentSequence.push({ agentName, score, span });
  }
  entry.spans.push(span);
}

function deriveAgentCompletionPerSession(): EvalRecord[] {
  const evals: EvalRecord[] = [];

  for (const [sessionId, data] of sessionAgents) {
    if (data.pre === 0) continue;
    const rate = Math.min(data.post / data.pre, 1.0);
    const lastSpan = data.spans[data.spans.length - 1];
    if (!lastSpan) continue;
    const sessionPreview = sessionId.slice(0, SESSION_ID_PREVIEW_LEN);

    evals.push({
      timestamp: hrtToISO(lastSpan.startTime),
      evaluationName: TASK_COMPLETION_EVAL_NAME,
      scoreValue: normalizeScore(rate),
      explanation: `Agent completion: ${data.post}/${data.pre} agents finished in session ${sessionPreview}`,
      evaluator: RULE_EVALUATOR,
      evaluatorType: RULE_EVALUATOR_TYPE,
      evaluatorKind: RULE_EVALUATOR_KIND,
      cohort: NORMAL_COHORT,
      traceId: lastSpan.traceId,
      spanId: lastSpan.spanId,
      ...spanAccountField(lastSpan),
      sessionId,
    });
  }

  return evals;
}

const MIN_HANDOFF_AGENTS = 2;
const HANDOFF_CORRECT_THRESHOLD = 0.5;
const HANDOFF_CONTEXT_THRESHOLD = 0.7;

function deriveHandoffCorrectnessPerSession(): EvalRecord[] {
  const evals: EvalRecord[] = [];

  for (const [sessionId, data] of sessionAgents) {
    if (data.agentSequence.length < MIN_HANDOFF_AGENTS) continue;

    const distinctAgentCount = new Set(data.agentSequence.map(a => a.agentName)).size;
    if (distinctAgentCount < MIN_HANDOFF_AGENTS) continue;

    let sum = 0;
    let count = 0;
    let correct = 0;
    let preserved = 0;
    for (let i = 1; i < data.agentSequence.length; i++) {
      const prev = data.agentSequence[i - 1];
      const curr = data.agentSequence[i];
      if (!curr || !prev) continue;
      if (curr.agentName !== prev.agentName) {
        sum += curr.score;
        count++;
        if (curr.score >= HANDOFF_CORRECT_THRESHOLD) correct++;
        if (curr.score >= HANDOFF_CONTEXT_THRESHOLD) preserved++;
      }
    }

    if (count === 0) continue;

    const avgScore = sum / count;
    const lastSequenceEntry = data.agentSequence[data.agentSequence.length - 1];
    if (!lastSequenceEntry) continue;
    const lastSpan = lastSequenceEntry.span;
    const sessionPreview = sessionId.slice(0, SESSION_ID_PREVIEW_LEN);

    evals.push({
      timestamp: hrtToISO(lastSpan.startTime),
      evaluationName: 'handoff_correctness',
      scoreValue: normalizeScore(avgScore),
      scoreUnit: 'ratio_0_1',
      explanation: `Session ${sessionPreview}: ${count} handoffs across ${distinctAgentCount} agents (${correct}/${count} correct target, ${preserved}/${count} context preserved)`,
      evaluator: RULE_EVALUATOR,
      evaluatorType: RULE_EVALUATOR_TYPE,
      evaluatorKind: RULE_EVALUATOR_KIND,
      cohort: NORMAL_COHORT,
      traceId: lastSpan.traceId,
      spanId: lastSpan.spanId,
      ...spanAccountField(lastSpan),
      sessionId,
    });
  }

  return evals;
}

/** `traces-YYYY-MM-DD.jsonl` */
const TRACE_FILE_PREFIX = 'traces-';
const DATE_ONLY_LEN = 10; // YYYY-MM-DD
const ISO_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ARG = '--date=';
/** Every flag derive reads; judge-evaluations and the parity scripts reuse the readers below. */
const DERIVE_CLI: CliSpec = { values: [SOURCE_ARG, DATE_ARG, DAYS_ARG, POST_DAYS_ARG], switches: [DRY_RUN_FLAG] };

/**
 * `--source=local|cloud`, else `defaultSource`: `cloud` for derive and the
 * judge since cloud-read Phase 6. `local` is kept for one release as the rollback.
 */
export function resolveSource(args: string[], defaultSource: TraceSource = DERIVE_DEFAULT_SOURCE): TraceSource {
  const source = parseCli(args, DERIVE_CLI).value(SOURCE_ARG) ?? defaultSource;
  if (!(TRACE_SOURCES as readonly string[]).includes(source)) {
    throw new CliArgError(`${SOURCE_ARG} must be one of ${TRACE_SOURCES.join('|')}, got "${source}"`);
  }
  return source as TraceSource;
}

/** The last `days` UTC dates, today included. */
export function lastUtcDays(days: number, now: Date = new Date()): Set<string> {
  const dates = new Set<string>();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.add(toDateOnly(d));
  }
  return dates;
}

/**
 * The dates a run reads: the caller's `--date=`/`--days=`, else, for the cloud
 * source, the last `defaultDays`. The cloud needs a bound because an unbounded
 * read has no memory ceiling; an unscoped local run still reads every trace file.
 */
export function readScope(
  source: TraceSource,
  dateScope: Set<string> | null,
  defaultDays: number,
  now: Date = new Date(),
): Set<string> | null {
  return source === 'cloud' && !dateScope ? lastUtcDays(defaultDays, now) : dateScope;
}

/**
 * The dates the caller asked for with `--date=` or `--days=`, or null when
 * neither was given. Null is not "all dates" for the cloud source: see
 * `readScope`. It also leaves the post window to `DERIVE_POST_WINDOW_DAYS`.
 */
export function resolveDateScope(args: string[], now: Date = new Date()): Set<string> | null {
  const cli = parseCli(args, DERIVE_CLI);
  const date = cli.value(DATE_ARG);
  if (date !== undefined) {
    if (!ISO_DATE_ONLY_PATTERN.test(date)) {
      throw new CliArgError(`${DATE_ARG} must be YYYY-MM-DD, got "${date}"`);
    }
    return new Set([date]);
  }

  const days = positiveIntArg(DAYS_ARG, cli.value(DAYS_ARG));
  return days === undefined ? null : lastUtcDays(days, now);
}

/** Every span in the in-scope `traces-<date>.jsonl` files, in file then line order. */
export function loadLocalSpans(dir: string, dateScope: Set<string> | null): LoadedSpans {
  const traceFiles = readdirSync(dir)
    .filter(f => f.startsWith(TRACE_FILE_PREFIX) && f.endsWith('.jsonl'))
    .filter(f => !dateScope
      || dateScope.has(f.slice(TRACE_FILE_PREFIX.length, TRACE_FILE_PREFIX.length + DATE_ONLY_LEN)))
    .sort();
  const accounts = indexTraceFiles(dir, traceFiles).bySpan;
  const spans = traceFiles.flatMap(file => readJsonlWithValidationSync(join(dir, file), localTraceSpanSchema));
  return { spans, accounts };
}

/**
 * Ascending by start time, span id breaking ties: the order `loadCloudSpans`
 * returns. Local files are in write order, which differs when spans overlap
 * (two agents finishing in parallel), and the session-level records attach
 * to the session's last span, so without one order the two sources named
 * different spans, and so different evaluation ids, for the same record.
 */
function byStartThenSpanId(a: LocalTraceSpan, b: LocalTraceSpan): number {
  return a.startTime[0] - b.startTime[0]
    || a.startTime[1] - b.startTime[1]
    || a.spanId.localeCompare(b.spanId);
}

/**
 * Every rule record for `spans`, taken in start order whatever order they
 * arrive in. Clears the per-session accumulators first, so two sources can be
 * derived in one process (`derive-parity.ts`).
 */
export function deriveAll(loaded: LoadedSpans): EvalRecord[] {
  sessionTasks.clear();
  sessionAgents.clear();
  setSpanAccounts(loaded.accounts);
  const allEvals: EvalRecord[] = [];

  for (const span of [...loaded.spans].sort(byStartThenSpanId)) {
    const toolCorr = deriveToolCorrectness(span);
    if (toolCorr) allEvals.push(toolCorr);

    const latency = deriveEvaluationLatency(span);
    if (latency) allEvals.push(latency);

    trackTaskActivity(span);
    trackAgentActivity(span);
  }

  allEvals.push(...deriveTaskCompletionPerSession());
  allEvals.push(...deriveAgentCompletionPerSession());
  allEvals.push(...deriveHandoffCorrectnessPerSession());
  return allEvals;
}


/** `--post-days=N` as a day count; `null` when absent. */
export function resolvePostDays(args: string[]): number | null {
  return positiveIntArg(POST_DAYS_ARG, parseCli(args, DERIVE_CLI).value(POST_DAYS_ARG)) ?? null;
}

/**
 * Earliest event time a run posts. Every run re-derives its whole read scope,
 * so without a floor each run would re-post all of it — dropped by ingest, but
 * sent. `--post-days=` sets the floor outright; otherwise an unscoped run gets
 * `DERIVE_POST_WINDOW_DAYS`, and an explicit `--date=`/`--days=` posts its
 * whole scope, which is how a backfill is done. `DERIVE_NO_REPOST_BEFORE_MS`
 * applies on top, whatever the floor.
 */
export function postFloorMs(dateScope: Set<string> | null, nowMs: number, postDays: number | null = null): number {
  if (postDays !== null) return nowMs - postDays * TIME_MS.DAY;
  return dateScope ? Number.NEGATIVE_INFINITY : nowMs - DERIVE_POST_WINDOW_DAYS * TIME_MS.DAY;
}

/**
 * `gen_ai.operation.name` of the synthetic `invoke_agent <agent>` span each agent
 * invocation emits, whatever the hook spans are named. Since 2026-09-29 that span is
 * the only one carrying it (the prepare/finalize hook spans and the code-survival
 * seed stopped claiming the operation), so this counts one span per invocation.
 */
const INVOKE_AGENT_OPERATION = 'invoke_agent';
/** Fewer tool spans than this in a day cannot tell a renamed attribute from a few hooks that failed before recording one. */
const DRIFT_MIN_TOOL_SPANS = 20;
/** A day's tool spans may lack a success flag up to this share; past it the flag has most likely been renamed. */
const DRIFT_MAX_MISSING_SUCCESS_SHARE = 0.5;

interface DayInput {
  agentEvidence: number;
  agentMatched: number;
  toolSpans: number;
  toolMissingSuccess: number;
}

/**
 * Days whose input the derivations can no longer read (HOOK-RENAME-SILENT).
 * Twice a hooks-side rename emptied a metric while every stage exited 0: the
 * agent spans on 2026-08-13, silent for six weeks, and the `builtin.*` keys on
 * 2026-09-18, which scored every tool call a failure for nine days. Each check
 * compares a day's spans with themselves, never with a previous run, so it
 * fires on the first run after a rename rather than once the old names have
 * aged out of the read window, and a quiet day cannot trip it:
 * - spans record an agent invocation, but none has a name derive matches;
 * - most tool spans carry no success flag under the key derive reads.
 */
export function detectInputDrift(spans: readonly LocalTraceSpan[], dateScope: ReadonlySet<string> | null): string[] {
  const days = new Map<string, DayInput>();
  for (const span of spans) {
    const date = toDateOnly(hrtToISO(span.startTime));
    if (dateScope && !dateScope.has(date)) continue;
    let day = days.get(date);
    if (!day) days.set(date, day = { agentEvidence: 0, agentMatched: 0, toolSpans: 0, toolMissingSuccess: 0 });
    const attrs = attrsOf(span);
    if (attrs['gen_ai.operation.name'] === INVOKE_AGENT_OPERATION) day.agentEvidence++;
    if (span.name === AGENT_PREPARE_SPAN || span.name === AGENT_FINALIZE_SPAN) day.agentMatched++;
    if (isToolSpan(span)) {
      day.toolSpans++;
      if (typeof toolSuccessOf(span, attrs) !== 'boolean') day.toolMissingSuccess++;
    }
  }

  const warnings: string[] = [];
  for (const [date, day] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    if (day.agentEvidence > 0 && day.agentMatched === 0) {
      warnings.push(`${date}: ${day.agentEvidence} spans record agent invocations, but none is named ${AGENT_PREPARE_SPAN} or ${AGENT_FINALIZE_SPAN}, so the agent metrics are empty. Were the hook spans renamed?`);
    }
    if (day.toolSpans >= DRIFT_MIN_TOOL_SPANS && day.toolMissingSuccess / day.toolSpans > DRIFT_MAX_MISSING_SUCCESS_SHARE) {
      warnings.push(`${date}: ${day.toolMissingSuccess} of ${day.toolSpans} tool spans carry no success flag, so tool_correctness scores them as failures. Was the attribute renamed?`);
    }
  }
  return warnings;
}

/**
 * Derive never posts a record dated before this instant, however it is scoped.
 * D1 holds 45,887 derive rows (`evaluator = 'rule'`) dated 2026-09-16 to
 * 2026-09-27 with no `evaluation_id`: upload shipped them before migration 0015
 * added the column. Ingest drops a re-post only when the earlier copy carries
 * the id, so posting any of those days again would duplicate them. Every derive
 * row from 2026-09-28 on has an id (counted 2026-10-04 with
 * `CLOUDFLARE_D1_READ_TOKEN`).
 *
 * The same instant was the Phase 3 cutover `DERIVE_DIRECT_POST_SINCE_MS`, which
 * also sent earlier records to a file for upload. The file went in Phase 6;
 * this is the half of the cutover that still guards something.
 */
export const DERIVE_NO_REPOST_BEFORE_MS = Date.parse('2026-09-28T00:00:00.000Z');

/** The records derive may post, and those dated before `DERIVE_NO_REPOST_BEFORE_MS`. */
export function splitAtRepostFloor(records: readonly EvalRecord[]): { toPost: EvalRecord[]; heldBack: EvalRecord[] } {
  const toPost: EvalRecord[] = [];
  const heldBack: EvalRecord[] = [];
  for (const r of records) (Date.parse(r.timestamp) >= DERIVE_NO_REPOST_BEFORE_MS ? toPost : heldBack).push(r);
  return { toPost, heldBack };
}

/**
 * Keep a metric's previous calibration when this run could not recompute it. A metric under
 * `MIN_QUANTILE_SAMPLE_SIZE` samples gets no distribution, and derive calibrates over its 7-day
 * read, so a sparse metric (task_completion, handoff_correctness) would otherwise drop out of
 * `meta:calibration` at every rewrite. A carried entry keeps its own windowStart/windowEnd, so its
 * age stays visible; a freshly computed one always replaces it.
 */
export function carryForwardDistributions(
  previous: CalibrationState['distributions'] | undefined,
  fresh: CalibrationState['distributions'],
): CalibrationState['distributions'] {
  return { ...previous, ...fresh };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dateScope = resolveDateScope(argv);
  const source = resolveSource(argv);
  const scope = readScope(source, dateScope, DERIVE_DEFAULT_DAYS);
  const postDays = resolvePostDays(argv);
  const dryRun = parseCli(argv, DERIVE_CLI).has(DRY_RUN_FLAG);

  let loaded: LoadedSpans;
  if (source === 'cloud' && scope) {
    try {
      loaded = await loadCloudSpans(scope);
    } catch (err) {
      // Nothing is derived or posted yet, so populate carries on
      // without derive. The whole error, cause included, goes to stderr so
      // populate can tell a network failure (retried) from anything else.
      console.error('[derive] cloud read failed:', err);
      process.exitCode = DERIVE_EXIT_READ_FAILED;
      return;
    }
  } else {
    loaded = loadLocalSpans(TELEMETRY_DIR, scope);
  }
  const allEvals = deriveAll(loaded);
  // A span in an in-scope trace file can carry an out-of-scope timestamp;
  // never post a date the run did not read.
  const inScope = scope ? allEvals.filter(ev => scope.has(toDateOnly(ev.timestamp))) : allEvals;

  // Unstamped records fall back to the local account join only when the spans
  // were local; every cloud span is stamped with the org that shipped it.
  const accounts = source === 'local'
    ? buildAccountIndex(TELEMETRY_DIR, ACCOUNT_INDEX_WINDOW_DAYS, Date.now())
    : emptyAccountIndex();
  // The window comes from the caller's scope, not the defaulted read, so an
  // unscoped run posts the last DERIVE_POST_WINDOW_DAYS of its 7-day read.
  const floorMs = postFloorMs(dateScope, Date.now(), postDays);
  const { toPost, heldBack } = splitAtRepostFloor(inScope.filter(ev => Date.parse(ev.timestamp) >= floorMs));
  if (heldBack.length > 0) {
    console.log(`[derive] held back ${heldBack.length} records dated before ${new Date(DERIVE_NO_REPOST_BEFORE_MS).toISOString()}: D1 holds copies without an evaluationId, so a re-post would duplicate them`);
  }
  const posted = await postEvaluationRecords(toPost.map(toOTelRecord), { dryRun, accounts });
  console.log(`[derive]${dryRun ? ' dry-run:' : ''} posted ${formatPostSummary(posted)}`);
  if (posted.failure) {
    // stderr, so populate can tell a network failure (retried) from a rejection.
    console.error(`[derive] post failed: ${posted.failure}`);
    process.exitCode = DERIVE_EXIT_POST_FAILED;
  }

  // Calibration step: compute per-metric percentile distributions
  // and persist to .calibration-state.json for the dashboard API to consume.
  const scoresByMetric: Record<string, number[]> = {};
  for (const ev of allEvals) {
    const metricScores = scoresByMetric[ev.evaluationName] ??= [];
    if (Number.isFinite(ev.scoreValue)) metricScores.push(ev.scoreValue);
  }

  const newDistributions = computeCalibrationDistributions(scoresByMetric);
  if (Object.keys(newDistributions).length > 0) {
    const previousState = loadCalibrationState(CALIBRATION_STATE_DIR);
    const { shouldWrite, psiValues } = shouldRecalibrate(previousState, scoresByMetric);
    // psiValues reflects PSI at the time of last write (when shouldWrite: true),
    // not from every check — stable runs don't update the file.
    if (shouldWrite && dryRun) {
      console.log('[dry-run] would update .calibration-state.json');
    } else if (shouldWrite) {
      const distributions = carryForwardDistributions(previousState?.distributions, newDistributions);
      const carried = Object.keys(distributions).filter(metric => !(metric in newDistributions));
      if (carried.length > 0) {
        console.log(`[derive] calibration: kept the previous distribution for ${carried.join(', ')} (too few samples this run)`);
      }
      saveCalibrationState(CALIBRATION_STATE_DIR, {
        lastCalibrated: new Date().toISOString(),
        distributions,
        psiValues,
        rawScores: Object.fromEntries(
          Object.entries(scoresByMetric).map(([k, v]) => [k, v.slice(-MAX_RAW_SCORES_PER_METRIC)])
        ),
      });
    }
  }

  const byName = new Map<string, number>();
  for (const ev of inScope) {
    byName.set(ev.evaluationName, (byName.get(ev.evaluationName) ?? 0) + 1);
  }
  const counts = [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, n]) => `${name}=${n}`);
  console.log(`[derive] records: ${counts.join(' ') || 'none'}`);

  const drift = detectInputDrift(loaded.spans, scope);
  for (const warning of drift) console.error(`[derive] input drift on ${warning}`);
  // A failed post is the more urgent code; drift persists and shows on the next run.
  if (drift.length > 0 && process.exitCode === undefined) process.exitCode = DERIVE_EXIT_INPUT_DRIFT;
}

// Only run when executed directly (not imported as module for testing)
const isDirectRun = process.argv[1]?.endsWith('derive-evaluations.ts') ||
  process.argv[1]?.endsWith('derive-evaluations.js');
if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('[derive] fatal:', err);
    process.exitCode = 1;
  });
}
