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
import { mean, rollup } from 'd3-array';
import pLimit from 'p-limit';
import { join } from 'path';
import {
  computeCalibrationDistributions,
  loadCalibrationState,
  saveCalibrationState,
  shouldRecalibrate,
  type CalibrationState,
} from '../../src/lib/quality/qfe-percentiles.js';
import { localTraceSpanSchema, type LocalTraceSpan } from '../../src/lib/validation/dashboard-schemas.js';
export type { LocalTraceSpan as TraceSpan };
import { readJsonlWithValidationSync } from '../src/lib/dashboard-file-utils.js';
import {
  normalizeScore,
  EVAL_SCORE_PRECISION,
  SESSION_ID_PREVIEW_LEN,
  RULE_EVALUATOR_TYPE,
  SYNTHETIC_EVALUATOR_KIND as RULE_EVALUATOR_KIND,
  NORMAL_COHORT,
  toOTelRecord,
  type EvalRecord,
} from './eval-record.js';
import { TELEMETRY_DIR, CALIBRATION_STATE_DIR } from './evaluation-constants.js';
import { TOOL_CORRECTNESS_CRITERIA } from './judge-criteria.js';
import { toDateOnly, OTEL_STATUS_ERROR_CODE, HOOK_NAME, HOOK_SPAN_PREFIX } from '../src/api/api-constants.js';
import { canonicalizeAttributes } from '../../src/lib/observability/attribute-aliases.js';
import { ACCOUNT_INDEX_WINDOW_DAYS, buildAccountIndex, indexTraceFiles, type AccountRef } from './account-stamps.js';
import { emptyAccountIndex, formatPostSummary, postEvaluationRecords } from './post-evaluations.js';
import { loadCloudSpans, type LoadedSpans } from './cloud-trace-source.js';
import { DAYS_FLAG as DAYS_ARG, DERIVE_DEFAULT_DAYS, DERIVE_DEFAULT_SOURCE, DERIVE_EXIT_INPUT_DRIFT, DERIVE_EXIT_POST_FAILED, DERIVE_EXIT_READ_FAILED, DERIVE_POST_WINDOW_DAYS, DRY_RUN_FLAG, POST_DAYS_FLAG as POST_DAYS_ARG, SOURCE_FLAG as SOURCE_ARG, TRACE_SOURCES, type TraceSource } from './pipeline-stages.js';
import { NANOSECONDS_PER_MILLISECOND, NANOSECONDS_PER_SECOND, TIME_MS } from '../../src/lib/core/units.js';
import { CliArgError, parseCli, positiveIntArg, runIfMain, type CliSpec } from './cli-args.js';
import { computeAgentHeuristicEvaluations } from '../../src/lib/agent-judge/agent-eval-metrics.js';
import { readMultiTurnInput, readSingleTurnInput } from './agent-heuristic-inputs.js';
import { resolveTranscriptPath, scanTranscriptDirs } from './judge-turns.js';
import { GENAI_AGENT_ATTRIBUTES, GENAI_CORE_ATTRIBUTES, GENAI_TOOL_ATTRIBUTES } from '../../src/lib/otel/genai-attributes.js';
import { SESSION_ATTRIBUTES } from '../../src/lib/otel/constants-otel.js';

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

/** What each rule metric decides; every other record field comes from `span`. */
type RuleScore = Pick<EvalRecord, 'evaluationName' | 'scoreValue' | 'explanation' | 'scoreUnit' | 'scoreLabel'>;

/** A rule record attached to `span`: its time, ids and account stamp. */
function ruleRecord(span: LocalTraceSpan, sessionId: string, score: RuleScore): EvalRecord {
  return {
    timestamp: hrtToISO(span.startTime),
    ...score,
    evaluator: RULE_EVALUATOR_TYPE,
    evaluatorType: RULE_EVALUATOR_TYPE,
    evaluatorKind: RULE_EVALUATOR_KIND,
    cohort: NORMAL_COHORT,
    traceId: span.traceId,
    spanId: span.spanId,
    ...spanAccountField(span),
    sessionId,
  };
}

/**
 * A span's attributes under their canonical keys. The hooks renamed `builtin.*`
 * on 2026-09-18, so local trace files hold both spellings; reading the legacy
 * key off a post-rename span found nothing and scored every builtin tool call a
 * failure. Cloud spans arrive canonicalized already, and a bag with no legacy
 * key is returned as-is, so this is free on the cloud path. Memoized per
 * attribute bag: the derivations and the drift check each read every span, so
 * a legacy-keyed bag was otherwise rebuilt up to five times. Assumes attribute
 * bags are never mutated after load; mutating one would serve a stale result.
 */
const canonicalAttrs = new WeakMap<LocalTraceSpan['attributes'], Record<string, unknown>>();

function attrsOf(span: LocalTraceSpan): Record<string, unknown> {
  let attrs = canonicalAttrs.get(span.attributes);
  if (!attrs) canonicalAttrs.set(span.attributes, attrs = canonicalizeAttributes(span.attributes));
  return attrs;
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

/** Agent hook attribute keys, canonical; `attrsOf` maps the pre-rename `agent.*` spellings onto them. */
const AGENT_ATTR = {
  TYPE: 'integritystudio.agent.type',
  HAS_ERROR: 'integritystudio.agent.has_error',
  TRANSCRIPT_PATH: 'integritystudio.agent.transcript_path',
} as const;

/** A renamed attribute's value: the canonical key first, then the legacy one. */
function renamedValue(attrs: Record<string, unknown>, [canonical, legacy]: readonly [string, string]): unknown {
  return attrs[canonical] ?? attrs[legacy];
}

/** Span attributes are `unknown`-valued; render primitives, never objects. */
function attrString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** Earliest start a real hook span can have: 2001-09-09, the first 10-digit Unix second. */
const MIN_PLAUSIBLE_EPOCH_SECONDS = 1_000_000_000;

// Returns NaN rather than throwing on a malformed tuple, so the single caller's
// Number.isFinite guard (OBP15) is the one place a bad duration is handled. Spans read
// through localTraceSpanSchema cannot arrive malformed — zod rejects both NaN and a
// missing tuple — but deriveEvaluationLatency is exported and directly callable, and its
// contract is to return null on malformed input, never to throw.
function hrtToSeconds(hrt: [number, number]): number {
  if (!Array.isArray(hrt)) return NaN;
  return hrt[0] + hrt[1] / NANOSECONDS_PER_SECOND;
}

function hrtToISO(hrt: [number, number]): string {
  return new Date(hrt[0] * TIME_MS.SECOND + hrt[1] / NANOSECONDS_PER_MILLISECOND).toISOString();
}

/** Maximum raw scores to persist per metric in calibration state (bounds file size) */
const MAX_RAW_SCORES_PER_METRIC = 500;

/** Transcripts parsed at once by `deriveAgentHeuristics`. */
const TRANSCRIPT_READ_CONCURRENCY = 8;

/**
 * Sessions whose last span started within this window are likely still in
 * progress. Scoring them now anchors on a transient last-span, so consecutive
 * derive runs produce different `evaluationId` hashes and D1 accumulates one
 * duplicate row per run (AGENT-HEURISTIC-INPROGRESS-DUPLICATES). Skip them;
 * the next scheduled run will score the completed session on a stable span.
 */
const MIN_SESSION_COMPLETION_AGE_MS = 12 * TIME_MS.HOUR;

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
const SUBAGENT_STOP_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.SUBAGENT_STOP}`;
/** `tsc-check` has no `HOOK_NAME` entry. */
const TSC_CHECK_SPAN = `${HOOK_SPAN_PREFIX}tsc-check`;

/** Hook spans whose duration `deriveEvaluationLatency` records. */
const LATENCY_MEASURED_SPANS: ReadonlySet<string> = new Set([
  BUILTIN_POST_TOOL_SPAN,
  MCP_POST_TOOL_SPAN,
  AGENT_FINALIZE_SPAN,
  `${HOOK_SPAN_PREFIX}${HOOK_NAME.SESSION_START}`,
  TSC_CHECK_SPAN,
]);

function isToolSpan(span: LocalTraceSpan): boolean {
  return span.name === BUILTIN_POST_TOOL_SPAN || span.name === MCP_POST_TOOL_SPAN;
}

/** The success flag a tool span records, under the key its hook writes; not a boolean when absent. */
function toolSuccessOf(span: LocalTraceSpan, attrs: Record<string, unknown>): unknown {
  return span.name === BUILTIN_POST_TOOL_SPAN ? attrs['integritystudio.tool.success'] : renamedValue(attrs, MCP_ATTR.SUCCESS);
}

export function deriveToolCorrectness(span: LocalTraceSpan): EvalRecord | null {
  if (!isToolSpan(span)) return null;
  const attrs = attrsOf(span);
  const isBuiltin = span.name === BUILTIN_POST_TOOL_SPAN;
  const isMcp = !isBuiltin;

  const success = toolSuccessOf(span, attrs);
  const tool = attrString(isBuiltin ? attrs[GENAI_TOOL_ATTRIBUTES.TOOL_NAME] : renamedValue(attrs, MCP_ATTR.TOOL), 'unknown');
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

  return ruleRecord(span, attrString(attrs[SESSION_ATTRIBUTES.ID]), {
    evaluationName: TOOL_CORRECTNESS_CRITERIA.name,
    scoreValue: score,
    explanation,
  });
}

export function deriveEvaluationLatency(span: LocalTraceSpan): EvalRecord | null {
  if (!LATENCY_MEASURED_SPANS.has(span.name)) return null;

  const durationSec = hrtToSeconds(span.duration);
  if (!Number.isFinite(durationSec)) return null;

  // Guard malformed startTime — a valid Unix timestamp has seconds > 1e9 (after 2001).
  // Spans with epoch-ish startTime (e.g. [2, 0]) are empty input spans, not hook runs.
  const [startSec] = span.startTime;
  if (startSec < MIN_PLAUSIBLE_EPOCH_SECONDS) return null;

  const attrs = attrsOf(span);

  let hookType: string;
  if (span.name === BUILTIN_POST_TOOL_SPAN) hookType = `builtin/${attrString(attrs[GENAI_TOOL_ATTRIBUTES.TOOL_NAME], 'unknown')}`;
  else if (span.name === MCP_POST_TOOL_SPAN) hookType = `mcp/${attrString(renamedValue(attrs, MCP_ATTR.TOOL), 'unknown')}`;
  else if (span.name === AGENT_FINALIZE_SPAN) hookType = `agent/${attrString(attrs[AGENT_ATTR.TYPE], 'unknown')}`;
  else hookType = span.name.replace(HOOK_SPAN_PREFIX, '');

  return ruleRecord(span, attrString(attrs[SESSION_ATTRIBUTES.ID]), {
    evaluationName: 'evaluation_latency',
    scoreValue: durationSec,
    scoreUnit: 'seconds',
    explanation: `Hook ${hookType} executed in ${durationSec.toFixed(EVAL_SCORE_PRECISION)}s`,
  });
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

export const sessionTasks = new Map<string, SessionTaskData>();

const TASK_COMPLETION_EVAL_NAME = 'task_completion';

/** The old fallback assumes each task gets a status update and a completion update. */
const EXPECTED_UPDATES_PER_TASK = 2;

export const STATUS_SCORES: { pending: number; in_progress: number; completed: number } = {
  pending: 0.0,
  in_progress: 0.5,
  completed: 1.0,
};

export function trackTaskActivity(span: LocalTraceSpan): void {
  if (span.name !== BUILTIN_POST_TOOL_SPAN) return;
  const attrs = attrsOf(span);
  const tool = attrs[GENAI_TOOL_ATTRIBUTES.TOOL_NAME];
  if (tool !== 'TaskCreate' && tool !== 'TaskUpdate') return;

  const sessionId = attrString(attrs[SESSION_ATTRIBUTES.ID], 'unknown');
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
      const avg = mean(scores);
      // invariant: tasks.size > 0 and scoreTask returns a finite STATUS_SCORES value
      if (avg === undefined) throw new Error(`invariant: session ${sessionId} has tasks but no finite task scores`);
      const completed = scores.filter(s => s === STATUS_SCORES.completed).length;
      const inProgress = scores.filter(s => s === STATUS_SCORES.in_progress).length;
      const pending = scores.filter(s => s === STATUS_SCORES.pending).length;

      const parts: string[] = [];
      if (completed > 0) parts.push(`${completed} completed`);
      if (inProgress > 0) parts.push(`${inProgress} in_progress`);
      if (pending > 0) parts.push(`${pending} pending`);

      evals.push(ruleRecord(lastSpan, sessionId, {
        evaluationName: TASK_COMPLETION_EVAL_NAME,
        scoreValue: normalizeScore(avg),
        explanation: `Session ${sessionPreview}: ${data.tasks.size} tasks (${parts.join(', ')})`,
      }));
    } else {
      // Fallback: old trace data without a task status attribute
      const completionRatio = Math.min(data.updates / (data.creates * EXPECTED_UPDATES_PER_TASK), 1.0);

      evals.push(ruleRecord(lastSpan, sessionId, {
        evaluationName: TASK_COMPLETION_EVAL_NAME,
        scoreValue: normalizeScore(completionRatio),
        explanation: `Session ${sessionPreview}: ${data.creates} tasks, ${data.updates} updates (ratio fallback)`,
      }));
    }
  }

  return evals;
}

interface AgentSessionData {
  pre: number;
  lastSpan: LocalTraceSpan;
  /** Ordered agent names per post-tool span, used for handoff detection */
  agentSequence: { agentName: string; score: number; span: LocalTraceSpan }[];
}
const sessionAgents = new Map<string, AgentSessionData>();

function trackAgentActivity(span: LocalTraceSpan): void {
  const isPre = span.name === AGENT_PREPARE_SPAN;
  const isPost = span.name === AGENT_FINALIZE_SPAN;
  if (!isPre && !isPost) return;

  const sessionId = attrString(span.attributes[SESSION_ATTRIBUTES.ID], 'unknown');
  let entry = sessionAgents.get(sessionId);
  if (!entry) sessionAgents.set(sessionId, entry = { pre: 0, lastSpan: span, agentSequence: [] });
  entry.lastSpan = span;
  if (isPre) entry.pre++;
  if (isPost) {
    const agentName = attrString(span.attributes[GENAI_AGENT_ATTRIBUTES.AGENT_NAME], 'unknown');
    const attrs = attrsOf(span);
    // Score on the agent's own error flag (set from Agent tool `is_error`); fall
    // back to span status so a hook crash is also counted as a failure.
    const hasError = attrs[AGENT_ATTR.HAS_ERROR] === true || span.status?.code === OTEL_STATUS_ERROR_CODE;
    const score = hasError ? 0 : 1;
    entry.agentSequence.push({ agentName, score, span });
  }
}

function deriveAgentCompletionPerSession(): EvalRecord[] {
  const evals: EvalRecord[] = [];

  for (const [sessionId, data] of sessionAgents) {
    if (data.pre === 0) continue;
    const post = data.agentSequence.length;
    const rate = Math.min(post / data.pre, 1.0);
    const sessionPreview = sessionId.slice(0, SESSION_ID_PREVIEW_LEN);

    evals.push(ruleRecord(data.lastSpan, sessionId, {
      evaluationName: TASK_COMPLETION_EVAL_NAME,
      scoreValue: normalizeScore(rate),
      explanation: `Agent completion: ${post}/${data.pre} agents finished in session ${sessionPreview}`,
    }));
  }

  return evals;
}

const MIN_HANDOFF_AGENTS = 2;
const HANDOFF_CORRECT_THRESHOLD = 0.5;
const HANDOFF_CONTEXT_THRESHOLD = 0.7;

function deriveHandoffCorrectnessPerSession(): EvalRecord[] {
  const evals: EvalRecord[] = [];

  for (const [sessionId, data] of sessionAgents) {
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

    const avgScore = sum / count;
    const lastSequenceEntry = data.agentSequence[data.agentSequence.length - 1];
    if (!lastSequenceEntry) continue;
    const lastSpan = lastSequenceEntry.span;
    const sessionPreview = sessionId.slice(0, SESSION_ID_PREVIEW_LEN);

    evals.push(ruleRecord(lastSpan, sessionId, {
      evaluationName: 'handoff_correctness',
      scoreValue: normalizeScore(avgScore),
      scoreUnit: 'ratio_0_1',
      explanation: `Session ${sessionPreview}: ${count} handoffs across ${distinctAgentCount} agents (${correct}/${count} correct target, ${preserved}/${count} context preserved)`,
    }));
  }

  return evals;
}

/** The heuristics' scored results as rule records on `span`, keeping the label only some scorers assign. */
function heuristicRecords(
  span: LocalTraceSpan,
  sessionId: string,
  input: Parameters<typeof computeAgentHeuristicEvaluations>[0],
  fallbackExplanation: string,
): EvalRecord[] {
  return computeAgentHeuristicEvaluations(input).flatMap(ev => ev.scoreValue === undefined ? [] : [
    ruleRecord(span, sessionId, {
      evaluationName: ev.evaluationName,
      scoreValue: normalizeScore(ev.scoreValue),
      scoreUnit: ev.scoreUnit,
      explanation: ev.explanation ?? fallbackExplanation,
      ...(ev.scoreLabel && { scoreLabel: ev.scoreLabel }),
    }),
  ]);
}

/**
 * The agent heuristics only `agent-eval-metrics` computes (AGENT-EVAL-METRICS-UNUSED):
 * `argument_correctness` and `agent_overall` per subagent run, from the transcript its
 * `subagent-stop` span names, and `conversation_completeness`, `turn_relevancy` and
 * `conversation_overall` per session, from `sessionTranscripts`, on the session's last span.
 *
 * Spans hold neither replies nor tool arguments, so a run or session whose transcript is
 * not on this machine is skipped rather than scored on placeholders. Spans that start
 * before `sinceMs` are not read, so a run opens only the transcripts it can post.
 */
export async function deriveAgentHeuristics(
  spans: readonly LocalTraceSpan[],
  sinceMs: number,
  sessionTranscripts: ReadonlyMap<string, string>,
  nowMs: number = Date.now(),
): Promise<EvalRecord[]> {
  const limit = pLimit(TRANSCRIPT_READ_CONCURRENCY);
  const jobs: Promise<EvalRecord[]>[] = [];
  const lastSpanBySession = new Map<string, LocalTraceSpan>();

  for (const span of spans) {
    if (hrtToSeconds(span.startTime) * TIME_MS.SECOND < sinceMs) continue;
    const attrs = attrsOf(span);
    const sessionId = attrString(attrs[SESSION_ATTRIBUTES.ID]);
    if (!sessionId) continue;
    const last = lastSpanBySession.get(sessionId);
    if (!last || byStartThenSpanId(last, span) < 0) lastSpanBySession.set(sessionId, span);

    if (span.name !== SUBAGENT_STOP_SPAN) continue;
    const recordedPath = attrs[AGENT_ATTR.TRANSCRIPT_PATH];
    const path = typeof recordedPath === 'string' ? resolveTranscriptPath(recordedPath) : null;
    if (!path) continue;
    const agentType = attrString(attrs[AGENT_ATTR.TYPE], 'unknown');
    jobs.push(limit(async () => {
      const input = await readSingleTurnInput(path);
      return input
        ? heuristicRecords(span, sessionId, input, `${agentType} agent: ${input.toolCalls.length} tool calls`)
        : [];
    }));
  }

  for (const [sessionId, span] of lastSpanBySession) {
    // Skip sessions that may still be in progress: their last-span changes on the
    // next derive run, producing a different evaluationId and a duplicate D1 row.
    if (hrtToSeconds(span.startTime) * TIME_MS.SECOND > nowMs - MIN_SESSION_COMPLETION_AGE_MS) continue;
    const path = sessionTranscripts.get(sessionId);
    if (!path) continue;
    jobs.push(limit(async () => {
      const input = await readMultiTurnInput(path);
      return input
        ? heuristicRecords(span, sessionId, input, `Session ${sessionId.slice(0, SESSION_ID_PREVIEW_LEN)}: ${input.turns.length} turns`)
            .map(r => ({ ...r, stableEvaluationKey: `session:${r.sessionId}:${r.evaluationName}` }))
        : [];
    }));
  }

  return (await Promise.all(jobs)).flat();
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
function lastUtcDays(days: number, now: Date = new Date()): Set<string> {
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
 * A hooks-side rename can empty a metric while every stage exits 0 (twice so
 * far: docs/data-pipeline.md § Historical incidents). Each check
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
    if (attrs[GENAI_CORE_ATTRIBUTES.OPERATION_NAME] === INVOKE_AGENT_OPERATION) day.agentEvidence++;
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

/**
 * Compute per-metric percentile distributions from `allEvals` and persist them
 * to `.calibration-state.json`, which sync-to-kv serves as `meta:calibration`.
 * Rewritten only when the distribution drifts (PSI); a dry run says so instead.
 */
function updateCalibration(allEvals: readonly EvalRecord[], dryRun: boolean): void {
  const scoresByMetric: Record<string, number[]> = Object.fromEntries(rollup(
    allEvals,
    evs => evs.map(ev => ev.scoreValue).filter(Number.isFinite),
    ev => ev.evaluationName,
  ));

  const newDistributions = computeCalibrationDistributions(scoresByMetric);
  if (Object.keys(newDistributions).length === 0) return;

  const previousState = loadCalibrationState(CALIBRATION_STATE_DIR);
  const { shouldWrite, psiValues } = shouldRecalibrate(previousState, scoresByMetric);
  // psiValues reflects PSI at the time of last write (when shouldWrite: true),
  // not from every check — stable runs don't update the file.
  if (!shouldWrite) return;
  if (dryRun) {
    console.log('[dry-run] would update .calibration-state.json');
    return;
  }

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
  // The window comes from the caller's scope, not the defaulted read, so an
  // unscoped run posts the last DERIVE_POST_WINDOW_DAYS of its 7-day read.
  const floorMs = postFloorMs(dateScope, Date.now(), postDays);
  allEvals.push(...await deriveAgentHeuristics(
    loaded.spans,
    Math.max(floorMs, DERIVE_NO_REPOST_BEFORE_MS),
    new Map(scanTranscriptDirs().map(t => [t.sessionId, t.path])),
  ));
  // A span in an in-scope trace file can carry an out-of-scope timestamp;
  // never post a date the run did not read.
  const inScope = scope ? allEvals.filter(ev => scope.has(toDateOnly(ev.timestamp))) : allEvals;

  // Unstamped records fall back to the local account join only when the spans
  // were local; every cloud span is stamped with the org that shipped it.
  const accounts = source === 'local'
    ? buildAccountIndex(TELEMETRY_DIR, ACCOUNT_INDEX_WINDOW_DAYS, Date.now())
    : emptyAccountIndex();
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

  updateCalibration(allEvals, dryRun);

  const byName = rollup(inScope, evs => evs.length, ev => ev.evaluationName);
  const counts = [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, n]) => `${name}=${n}`);
  console.log(`[derive] records: ${counts.join(' ') || 'none'}`);

  const drift = detectInputDrift(loaded.spans, scope);
  for (const warning of drift) console.error(`[derive] input drift on ${warning}`);
  // A failed post is the more urgent code; drift persists and shows on the next run.
  if (drift.length > 0 && process.exitCode === undefined) process.exitCode = DERIVE_EXIT_INPUT_DRIFT;
}

runIfMain(import.meta.url, main, '[derive]');
