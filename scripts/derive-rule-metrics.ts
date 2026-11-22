/**
 * The rule metrics scored from spans alone: `tool_correctness`, `evaluation_latency`,
 * `task_completion` and `handoff_correctness`. Imports nothing Node-only, so a Worker
 * can bundle it; the CLI around it, calibration and the transcript heuristics are
 * `derive-evaluations.ts`.
 */

import { ascending, mean } from 'd3-array';
import type { LocalTraceSpan } from '../../src/lib/validation/dashboard-schemas.js';
import {
  normalizeScore,
  EVAL_SCORE_PRECISION,
  SESSION_ID_PREVIEW_LEN,
  RULE_EVALUATOR_TYPE,
  SYNTHETIC_EVALUATOR_KIND as RULE_EVALUATOR_KIND,
  NORMAL_COHORT,
  legacyEvaluatorTypeField,
  type EvalRecord,
} from './eval-record.js';
import { TOOL_CORRECTNESS_CRITERIA } from './judge-criteria.js';
import { toDateOnly, OTEL_STATUS_ERROR_CODE, HOOK_NAME, HOOK_SPAN_PREFIX } from '../src/api/api-constants.js';
import { DERIVE_POST_WINDOW_DAYS } from './pipeline-stages.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import type { AccountRef } from './account-index.js';
import type { LoadedSpans } from './cloud-trace-source.js';
import { hrtToISO, hrtToSeconds } from './hrt.js';
import { GENAI_AGENT_ATTRIBUTES, GENAI_TOOL_ATTRIBUTES } from '../../src/lib/otel/genai-attributes.js';
import { AGENT_ATTRIBUTES, MCP_ATTRIBUTES, TASK_ATTRIBUTES, TOOL_ATTRIBUTES } from '../src/lib/hook-attributes.js';
import { SESSION_ATTRIBUTES } from '../../src/lib/otel/constants-otel.js';

/**
 * Each span's account stamp by span id, set by `main` from the raw trace lines.
 * The raw lines, because `localTraceSpanSchema` strips unknown keys, so the
 * stamp never reaches the parsed spans. Empty by default, which leaves every
 * record unstamped.
 */
let spanAccounts: ReadonlyMap<string, AccountRef> = new Map();

export function setSpanAccounts(accounts: ReadonlyMap<string, AccountRef>): void {
  spanAccounts = accounts;
}

/** The scored span's stamp as a record field; `{}` when the span carried none. */
function spanAccountField(span: LocalTraceSpan): Pick<EvalRecord, 'identityKeyRef'> {
  const identityKeyRef = spanAccounts.get(span.spanId);
  return identityKeyRef === undefined ? {} : { identityKeyRef };
}

/** What each rule metric decides; every other record field comes from `span`. */
type RuleScore = Pick<EvalRecord, 'evaluationName' | 'scoreValue' | 'explanation' | 'scoreUnit' | 'scoreLabel'>;

/** A rule record attached to `span`: its time, ids and account stamp. */
export function ruleRecord(span: LocalTraceSpan, sessionId: string, score: RuleScore): EvalRecord {
  return {
    timestamp: hrtToISO(span.startTime),
    ...score,
    evaluator: RULE_EVALUATOR_TYPE,
    ...legacyEvaluatorTypeField(RULE_EVALUATOR_KIND),
    evaluatorKind: RULE_EVALUATOR_KIND,
    cohort: NORMAL_COHORT,
    traceId: span.traceId,
    spanId: span.spanId,
    ...spanAccountField(span),
    sessionId,
  };
}

/**
 * MCP post-tool keys as `[canonical, legacy]`. The hooks moved `mcp.*` under
 * `integritystudio.` on 2026-09-29 and no migration renamed the stored rows,
 * so an older span keeps the unprefixed key.
 */
const MCP_ATTR = {
  SUCCESS: [MCP_ATTRIBUTES.SUCCESS, 'mcp.success'],
  TOOL: [MCP_ATTRIBUTES.TOOL, 'mcp.tool'],
  ERROR_TYPE: [MCP_ATTRIBUTES.ERROR_TYPE, 'mcp.error_type'],
  SERVER: [MCP_ATTRIBUTES.SERVER, 'mcp.server'],
} as const satisfies Record<string, readonly [string, string]>;

/** A renamed attribute's value: the canonical key first, then the legacy one. */
function renamedValue(attrs: Record<string, unknown>, [canonical, legacy]: readonly [string, string]): unknown {
  return attrs[canonical] ?? attrs[legacy];
}

/** Span attributes are `unknown`-valued; render primitives, never objects. */
export function attrString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** Earliest start a real hook span can have: 2001-09-09, the first 10-digit Unix second. */
const MIN_PLAUSIBLE_EPOCH_SECONDS = 1_000_000_000;

/** The Agent tool's pre- and post-tool hook spans; agent completion, handoff_correctness and agent hook latency read them. */
export const AGENT_PREPARE_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.AGENT_PREPARE}`;
export const AGENT_FINALIZE_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.AGENT_FINALIZE}`;
const BUILTIN_POST_TOOL_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.BUILTIN_POST_TOOL}`;
const MCP_POST_TOOL_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.MCP_POST_TOOL}`;
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

export function isToolSpan(span: LocalTraceSpan): boolean {
  return span.name === BUILTIN_POST_TOOL_SPAN || span.name === MCP_POST_TOOL_SPAN;
}

/** The success flag a tool span records, under the key its hook writes; not a boolean when absent. */
export function toolSuccessOf(span: LocalTraceSpan, attrs: Record<string, unknown>): unknown {
  return span.name === BUILTIN_POST_TOOL_SPAN ? attrs[TOOL_ATTRIBUTES.SUCCESS] : renamedValue(attrs, MCP_ATTR.SUCCESS);
}

const EVALUATION_LATENCY_EVAL_NAME = 'evaluation_latency';

/** The metrics `deriveSpanRecords` scores, one span at a time; every other rule metric is scored per session. */
export const PER_SPAN_METRIC_NAMES: ReadonlySet<string> = new Set([TOOL_CORRECTNESS_CRITERIA.name, EVALUATION_LATENCY_EVAL_NAME]);

export function deriveToolCorrectness(span: LocalTraceSpan): EvalRecord | null {
  if (!isToolSpan(span)) return null;
  const attrs = span.attributes;
  const isBuiltin = span.name === BUILTIN_POST_TOOL_SPAN;
  const isMcp = !isBuiltin;

  const success = toolSuccessOf(span, attrs);
  const tool = attrString(isBuiltin ? attrs[GENAI_TOOL_ATTRIBUTES.TOOL_NAME] : renamedValue(attrs, MCP_ATTR.TOOL), 'unknown');
  const errorType = attrString(isBuiltin ? attrs[TOOL_ATTRIBUTES.ERROR_TYPE] : renamedValue(attrs, MCP_ATTR.ERROR_TYPE));
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

  const attrs = span.attributes;

  let hookType: string;
  if (span.name === BUILTIN_POST_TOOL_SPAN) hookType = `builtin/${attrString(attrs[GENAI_TOOL_ATTRIBUTES.TOOL_NAME], 'unknown')}`;
  else if (span.name === MCP_POST_TOOL_SPAN) hookType = `mcp/${attrString(renamedValue(attrs, MCP_ATTR.TOOL), 'unknown')}`;
  else if (span.name === AGENT_FINALIZE_SPAN) hookType = `agent/${attrString(attrs[AGENT_ATTRIBUTES.TYPE], 'unknown')}`;
  else hookType = span.name.replace(HOOK_SPAN_PREFIX, '');

  return ruleRecord(span, attrString(attrs[SESSION_ATTRIBUTES.ID]), {
    evaluationName: EVALUATION_LATENCY_EVAL_NAME,
    scoreValue: durationSec,
    scoreUnit: 'seconds',
    explanation: `Hook ${hookType} executed in ${durationSec.toFixed(EVAL_SCORE_PRECISION)}s`,
  });
}

type TaskState = {
  statuses: Set<string>;
  lastSpan: LocalTraceSpan;
}

type SessionTaskData = {
  tasks: Map<string, TaskState>;  // taskId -> state
  creates: number;   // fallback counters for old trace data
  updates: number;
  lastSpan: LocalTraceSpan | null;
}

const sessionTasks = new Map<string, SessionTaskData>();

const TASK_COMPLETION_EVAL_NAME = 'task_completion';

/** The old fallback assumes each task gets a status update and a completion update. */
const EXPECTED_UPDATES_PER_TASK = 2;

const STATUS_SCORES: { pending: number; in_progress: number; completed: number } = {
  pending: 0.0,
  in_progress: 0.5,
  completed: 1.0,
};

function trackTaskActivity(span: LocalTraceSpan): void {
  if (span.name !== BUILTIN_POST_TOOL_SPAN) return;
  const attrs = span.attributes;
  const tool = attrs[GENAI_TOOL_ATTRIBUTES.TOOL_NAME];
  if (tool !== 'TaskCreate' && tool !== 'TaskUpdate') return;

  const sessionId = attrString(attrs[SESSION_ATTRIBUTES.ID], 'unknown');
  let entry = sessionTasks.get(sessionId);
  if (!entry) sessionTasks.set(sessionId, entry = { tasks: new Map(), creates: 0, updates: 0, lastSpan: null });
  entry.lastSpan = span;

  // Always track counts for fallback
  if (tool === 'TaskCreate') entry.creates++;
  if (tool === 'TaskUpdate') entry.updates++;

  const taskStatus = attrs[TASK_ATTRIBUTES.STATUS];
  const taskId = attrs[TASK_ATTRIBUTES.ID];

  if (typeof taskStatus === 'string' && taskStatus in STATUS_SCORES) {
    const id = typeof taskId === 'string' ? taskId : `anon-${span.spanId}`;
    let task = entry.tasks.get(id);
    if (!task) entry.tasks.set(id, task = { statuses: new Set(), lastSpan: span });
    task.statuses.add(taskStatus);
    task.lastSpan = span;
  }
}

function scoreTask(statuses: Set<string>): number {
  if (statuses.has('completed')) return STATUS_SCORES.completed;
  if (statuses.has('in_progress')) return STATUS_SCORES.in_progress;
  return STATUS_SCORES.pending;
}

function deriveTaskCompletionPerSession(): EvalRecord[] {
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

type AgentSessionData = {
  pre: number;
  lastSpan: LocalTraceSpan;
  /** Ordered agent names per post-tool span, used for handoff detection */
  agentSequence: Array<{ agentName: string; score: number; span: LocalTraceSpan }>;
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
    const attrs = span.attributes;
    // Score on the agent's own error flag (set from Agent tool `is_error`); fall
    // back to span status so a hook crash is also counted as a failure.
    const hasError = attrs[AGENT_ATTRIBUTES.HAS_ERROR] === true || span.status?.code === OTEL_STATUS_ERROR_CODE;
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

/**
 * Ascending by start time, span id breaking ties: the order `loadCloudSpans`
 * returns. The session-level records attach to the session's last span, so a
 * fixed order keeps their evaluation ids stable when spans overlap (two agents
 * finishing in parallel).
 */
export function byStartThenSpanId(a: LocalTraceSpan, b: LocalTraceSpan): number {
  return a.startTime[0] - b.startTime[0]
    || a.startTime[1] - b.startTime[1]
    || ascending(a.spanId, b.spanId);
}

/** The spans `deriveSessionRecords` reads: task tool calls and the Agent tool's hook spans. */
export function isSessionEvidence(span: LocalTraceSpan): boolean {
  if (span.name === AGENT_PREPARE_SPAN || span.name === AGENT_FINALIZE_SPAN) return true;
  const tool = span.attributes[GENAI_TOOL_ATTRIBUTES.TOOL_NAME];
  return span.name === BUILTIN_POST_TOOL_SPAN && (tool === 'TaskCreate' || tool === 'TaskUpdate');
}

/** Everything `deriveSessionRecords` reads off a span's attributes. */
const SESSION_EVIDENCE_ATTRIBUTES: readonly string[] = [
  SESSION_ATTRIBUTES.ID,
  GENAI_TOOL_ATTRIBUTES.TOOL_NAME,
  TASK_ATTRIBUTES.STATUS,
  TASK_ATTRIBUTES.ID,
  GENAI_AGENT_ATTRIBUTES.AGENT_NAME,
  AGENT_ATTRIBUTES.HAS_ERROR,
];

/**
 * The session evidence among `spans`, each cut down to the attributes the
 * session scorers read: small enough to carry between the steps of a
 * partitioned read, and scored to the same records as the full spans.
 */
export function sessionEvidence(spans: readonly LocalTraceSpan[]): LocalTraceSpan[] {
  return spans.filter(span => isSessionEvidence(span)).map(span => ({
    ...span,
    attributes: Object.fromEntries(SESSION_EVIDENCE_ATTRIBUTES.flatMap(key => (key in span.attributes ? [[key, span.attributes[key]]] : []))),
  }));
}

/**
 * `tool_correctness` and `evaluation_latency`, one span at a time and in start
 * order, so any split of the spans yields the same records.
 */
export function deriveSpanRecords(loaded: LoadedSpans): EvalRecord[] {
  setSpanAccounts(loaded.accounts);
  return loaded.spans.toSorted(byStartThenSpanId).flatMap(span => {
    const toolCorrectness = deriveToolCorrectness(span);
    const latency = deriveEvaluationLatency(span);
    return [...(toolCorrectness ? [toolCorrectness] : []), ...(latency ? [latency] : [])];
  });
}

/**
 * `task_completion` and `handoff_correctness`, one record per session on its
 * last evidence span. A session is scored over every span given, so `loaded`
 * must hold each session's `isSessionEvidence` spans from the whole read
 * window; other spans are ignored. Clears the per-session accumulators first,
 * so repeated calls in one process start clean.
 */
export function deriveSessionRecords(loaded: LoadedSpans): EvalRecord[] {
  sessionTasks.clear();
  sessionAgents.clear();
  setSpanAccounts(loaded.accounts);
  for (const span of loaded.spans.toSorted(byStartThenSpanId)) {
    trackTaskActivity(span);
    trackAgentActivity(span);
  }
  return [
    ...deriveTaskCompletionPerSession(),
    ...deriveAgentCompletionPerSession(),
    ...deriveHandoffCorrectnessPerSession(),
  ];
}

/** Every rule record for `spans`, taken in start order whatever order they arrive in. */
export function deriveAll(loaded: LoadedSpans): EvalRecord[] {
  return [...deriveSpanRecords(loaded), ...deriveSessionRecords(loaded)];
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
 * Derive never posts a record dated before this instant, however it is scoped:
 * D1's derive rows before it were shipped without an `evaluation_id` (before
 * migration 0015), so ingest cannot drop a re-post and would duplicate them.
 * Every derive row from this date on has an id (counted 2026-10-04).
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
 * `records` narrowed to what a run posts: dated inside `scope` (a span can carry
 * a timestamp outside the dates read, and a run never posts a date it did not
 * read), at or after `floorMs`, and not before `DERIVE_NO_REPOST_BEFORE_MS`.
 */
export function recordsToPost(
  records: readonly EvalRecord[],
  scope: ReadonlySet<string>,
  floorMs: number,
): { inScope: EvalRecord[]; toPost: EvalRecord[]; heldBack: EvalRecord[] } {
  const inScope = records.filter(record => scope.has(toDateOnly(record.timestamp)));
  return { inScope, ...splitAtRepostFloor(inScope.filter(record => Date.parse(record.timestamp) >= floorMs)) };
}
