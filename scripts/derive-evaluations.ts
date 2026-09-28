#!/usr/bin/env tsx
/**
 * Derive evaluation JSONL files from local telemetry trace data.
 *
 * Reads traces-*.jsonl, extracts quality signals, writes
 * derived-evaluations-*.jsonl in the format expected by the
 * observability-toolkit backend.
 *
 * Each target derived-evaluations-<date>.jsonl is REPLACED, not appended to,
 * so scope the run and preview it before writing:
 *
 *   tsx scripts/derive-evaluations.ts --date=2026-07-27 --dry-run
 *   tsx scripts/derive-evaluations.ts --days=7
 *   tsx scripts/derive-evaluations.ts              # all dates
 *   tsx scripts/derive-evaluations.ts --source=cloud --days=7   # read /v1/traces instead
 *
 * `--source=cloud` reads spans from obtool-api, one query per `OBTOOL_API_KEY*`
 * account in the environment, and needs `--date=` or `--days=` (an unbounded
 * cloud read has no memory ceiling). Output is identical in shape; see
 * `derive-parity.ts` for the check that the two sources agree.
 *
 * The records get a file of their own (HDF5, 2026-09-27). Until then this
 * rewrote the hooks' `evaluations-<date>.jsonl`, keeping every line whose
 * `gen_ai.evaluation.evaluator` was not `rule` and prepending a fresh copy of
 * its own — but `toOTelRecord` had stopped writing that attribute when the
 * producer moved to `integritystudio.evaluation.producer`, so the filter kept
 * every previous run's rule lines too. Twice a day, for months: on 2026-09-22
 * the file held 57,156 lines for 4,641 distinct rule records, and the corpus
 * reached 1.1 GB against 100 MB of traces. Writing to a separate file removes
 * the preservation step, and with it the way it fails: this file is wholly
 * ours and is replaced, and nothing in `evaluations-<date>.jsonl` is ours.
 */

import { writeFileSync, readdirSync, readFileSync, existsSync } from 'fs';
import { basename, join } from 'path';
import {
  computeCalibrationDistributions,
  loadCalibrationState,
  saveCalibrationState,
  shouldRecalibrate,
} from '../../src/lib/quality/qfe-percentiles.js';
import { localTraceSpanSchema, type LocalTraceSpan, type EvaluatorType } from '../../src/lib/validation/dashboard-schemas.js';
export type { LocalTraceSpan as TraceSpan };
import { readJsonlWithValidationSync } from '../src/lib/dashboard-file-utils.js';
import { normalizeScore, EVAL_SCORE_PRECISION, TELEMETRY_DIR, SESSION_ID_PREVIEW_LEN, RULE_EVALUATOR_TYPE, SYNTHETIC_EVALUATOR_KIND as RULE_EVALUATOR_KIND, NORMAL_COHORT, TOOL_CORRECTNESS_CRITERIA, DERIVED_EVALUATIONS_FILE_PREFIX, datedJsonlName, toOTelRecord, type EvalRecord } from './judge-evaluations.js';
import { toDateOnly, OTEL_STATUS_ERROR_CODE } from '../src/api/api-constants.js';
import { indexTraceFiles, type AccountRef } from './account-stamps.js';
import { loadCloudSpans, type LoadedSpans } from './cloud-trace-source.js';

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

function deriveToolCorrectness(span: LocalTraceSpan): EvalRecord | null {
  const attrs = span.attributes;
  const isBuiltin = span.name === 'hook:builtin-post-tool';
  const isMcp = span.name === 'hook:mcp-post-tool';
  if (!isBuiltin && !isMcp) return null;

  const success = isBuiltin ? attrs['builtin.success'] : attrs['mcp.success'];
  const tool = attrString(isBuiltin ? attrs['builtin.tool'] : attrs['mcp.tool'], 'unknown');
  const errorType = attrString(isBuiltin ? attrs['builtin.error_type'] : attrs['mcp.error_type']);
  const server = isMcp ? attrString(attrs['mcp.server']) : '';

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
    'hook:builtin-post-tool',
    'hook:mcp-post-tool',
    'hook:agent-post-tool',
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

  const attrs = span.attributes;

  let hookType: string;
  if (span.name === 'hook:builtin-post-tool') hookType = `builtin/${attrString(attrs['builtin.tool'], 'unknown')}`;
  else if (span.name === 'hook:mcp-post-tool') hookType = `mcp/${attrString(attrs['mcp.tool'], 'unknown')}`;
  else if (span.name === 'hook:agent-post-tool') hookType = `agent/${attrString(attrs['integritystudio.agent.type'], 'unknown')}`;
  else hookType = span.name.replace('hook:', '');

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
  if (span.name !== 'hook:builtin-post-tool') return;
  const tool = span.attributes['builtin.tool'];
  if (tool !== 'TaskCreate' && tool !== 'TaskUpdate') return;

  const sessionId = attrString(span.attributes['session.id'], 'unknown');
  let entry = sessionTasks.get(sessionId);
  if (!entry) sessionTasks.set(sessionId, entry = { tasks: new Map(), creates: 0, updates: 0, lastSpan: null });
  entry.lastSpan = span;

  // Always track counts for fallback
  if (tool === 'TaskCreate') entry.creates++;
  if (tool === 'TaskUpdate') entry.updates++;

  const taskStatus = span.attributes['builtin.task_status'];
  const taskId = span.attributes['builtin.task_id'];

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
      // Fallback: old trace data without builtin.task_status attributes
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
  const isPre = span.name === 'hook:agent-pre-tool';
  const isPost = span.name === 'hook:agent-post-tool';
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
const DAYS_ARG = '--days=';
const DRY_RUN_ARG = '--dry-run';
const SOURCE_ARG = '--source=';

export const TRACE_SOURCES = ['local', 'cloud'] as const;
export type TraceSource = typeof TRACE_SOURCES[number];

/** `--source=local|cloud`; `local` when absent. Cloud needs a date scope. */
export function resolveSource(args: string[], dateScope: Set<string> | null): TraceSource {
  const arg = args.find(a => a.startsWith(SOURCE_ARG));
  const source = arg ? arg.slice(SOURCE_ARG.length) : 'local';
  if (!(TRACE_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`${SOURCE_ARG} must be one of ${TRACE_SOURCES.join('|')}, got "${source}"`);
  }
  if (source === 'cloud' && !dateScope) {
    throw new Error(`${SOURCE_ARG}cloud needs ${DATE_ARG} or ${DAYS_ARG}`);
  }
  return source as TraceSource;
}

/**
 * Restrict which date buckets are read and rewritten.
 * Returns null for "all dates" (no flag), preserving prior behavior.
 *
 * Scoping matters for safety, not just speed: the write loop below replaces
 * each `derived-evaluations-<date>.jsonl` wholesale, and any record the reader
 * fails to validate is dropped rather than preserved.
 */
export function resolveDateScope(args: string[], now: Date = new Date()): Set<string> | null {
  const dateArg = args.find(a => a.startsWith(DATE_ARG));
  if (dateArg) {
    const date = dateArg.slice(DATE_ARG.length);
    if (!ISO_DATE_ONLY_PATTERN.test(date)) {
      throw new Error(`${DATE_ARG} must be YYYY-MM-DD, got "${date}"`);
    }
    return new Set([date]);
  }

  const daysArg = args.find(a => a.startsWith(DAYS_ARG));
  if (daysArg) {
    const days = parseInt(daysArg.slice(DAYS_ARG.length), 10);
    if (!Number.isFinite(days) || days < 1) {
      throw new Error(`${DAYS_ARG} must be a positive integer, got "${daysArg.slice(DAYS_ARG.length)}"`);
    }
    const dates = new Set<string>();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      dates.add(toDateOnly(d));
    }
    return dates;
  }

  return null;
}

/** Where this script's records for `date` go: a file of their own, replaced wholesale. */
export function derivedEvaluationsPath(dir: string, date: string): string {
  return join(dir, datedJsonlName(DERIVED_EVALUATIONS_FILE_PREFIX, date));
}

export interface DerivedWrite {
  file: string;
  lines: number;
  /** Lines the file held before this write; counted only on a dry run. */
  existing: number;
}

/**
 * Replace `derived-evaluations-<date>.jsonl` with `lines`. Nothing is read
 * back or preserved: every line in that file came from this script, so the
 * fresh set is the whole truth for the date. The hooks' `evaluations-<date>.jsonl`
 * is never opened.
 */
export function writeDerivedEvaluations(dir: string, date: string, lines: readonly string[], dryRun: boolean): DerivedWrite {
  const outFile = derivedEvaluationsPath(dir, date);
  const existing = dryRun && existsSync(outFile)
    ? readFileSync(outFile, 'utf8').split('\n').filter(l => l.trim()).length
    : 0;
  if (!dryRun) writeFileSync(outFile, lines.join('\n') + '\n');
  return { file: basename(outFile), lines: lines.length, existing };
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
 * Every rule record for `spans`, in the order `main` has always produced them.
 * Clears the per-session accumulators first, so two sources can be derived in
 * one process (`derive-parity.ts`).
 */
export function deriveAll(loaded: LoadedSpans): EvalRecord[] {
  sessionTasks.clear();
  sessionAgents.clear();
  setSpanAccounts(loaded.accounts);
  const allEvals: EvalRecord[] = [];

  for (const span of loaded.spans) {
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dateScope = resolveDateScope(argv);
  const source = resolveSource(argv, dateScope);
  const dryRun = argv.includes(DRY_RUN_ARG);

  const loaded = source === 'cloud' && dateScope
    ? await loadCloudSpans(dateScope)
    : loadLocalSpans(TELEMETRY_DIR, dateScope);
  const allEvals = deriveAll(loaded);

  const byDate = new Map<string, EvalRecord[]>();
  for (const ev of allEvals) {
    const date = toDateOnly(ev.timestamp);
    let group = byDate.get(date);
    if (!group) byDate.set(date, group = []);
    group.push(ev);
  }

  let filesToWrite = 0;
  for (const [date, evals] of byDate) {
    // A span in an in-scope trace file can carry an out-of-scope timestamp;
    // never rewrite a date the caller did not ask for.
    if (dateScope && !dateScope.has(date)) continue;

    const ruleLines = evals.map(e => JSON.stringify(toOTelRecord(e)));
    const written = writeDerivedEvaluations(TELEMETRY_DIR, date, ruleLines, dryRun);
    if (dryRun) {
      const net = written.lines - written.existing;
      console.log(
        `[dry-run] ${written.file}: ${written.lines} rule lines`
        + ` (currently ${written.existing}, net ${net >= 0 ? '+' : ''}${net})`,
      );
    }
    filesToWrite++;
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
    const previousState = loadCalibrationState(TELEMETRY_DIR);
    const { shouldWrite, psiValues } = shouldRecalibrate(previousState, scoresByMetric);
    // psiValues reflects PSI at the time of last write (when shouldWrite: true),
    // not from every check — stable runs don't update the file.
    if (shouldWrite && dryRun) {
      console.log('[dry-run] would update .calibration-state.json');
    } else if (shouldWrite) {
      saveCalibrationState(TELEMETRY_DIR, {
        lastCalibrated: new Date().toISOString(),
        distributions: newDistributions,
        psiValues,
        rawScores: Object.fromEntries(
          Object.entries(scoresByMetric).map(([k, v]) => [k, v.slice(-MAX_RAW_SCORES_PER_METRIC)])
        ),
      });
    }
  }

  if (dryRun) {
    console.log(`[dry-run] ${filesToWrite} file(s) would be written; nothing changed on disk.`);
  }

  const byCat = new Map<string, number>();
  for (const ev of allEvals) {
    byCat.set(ev.evaluationName, (byCat.get(ev.evaluationName) ?? 0) + 1);
  }
  for (const [_name, _count] of byCat) { /* logged externally */ }
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
