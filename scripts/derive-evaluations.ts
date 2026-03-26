#!/usr/bin/env tsx
/**
 * Derive evaluation JSONL files from local telemetry trace data.
 *
 * Reads traces-*.jsonl, extracts quality signals, writes evaluations-*.jsonl
 * in the format expected by the observability-toolkit backend.
 */

import { writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  computeCalibrationDistributions,
  loadCalibrationState,
  saveCalibrationState,
  shouldRecalibrate,
} from '../../src/lib/quality/quality-feature-engineering.js';
import { MAX_RAW_SCORES_PER_METRIC } from '../../src/lib/quality/quality-constants.js';
import { traceSpanSchema, otelEvaluationRecordSchema, type TraceSpan } from '../../src/lib/validation/dashboard-schemas.js';
import { readJsonlWithValidationSync } from '../../src/lib/dashboard-file-utils.js';

const TELEMETRY_DIR = join(process.env.HOME ?? '', '.claude', 'telemetry');
const SESSION_ID_PREVIEW_LEN = 8;
const EVAL_SCORE_PRECISION = 4;

export interface EvalRecord {
  timestamp: string;
  evaluationName: string;
  scoreValue: number;
  scoreUnit?: string;
  explanation: string;
  evaluator: string;
  evaluatorType: string;
  traceId: string;
  sessionId?: string;
}

/** Serialize to OTel flat evaluation format expected by the backend */
function toOTelRecord(ev: EvalRecord): object {
  const attrs: Record<string, unknown> = {
    'gen_ai.evaluation.name': ev.evaluationName,
    'gen_ai.evaluation.score.value': ev.scoreValue,
    'gen_ai.evaluation.explanation': ev.explanation,
    'gen_ai.evaluation.evaluator': ev.evaluator,
    'gen_ai.evaluation.evaluator.type': ev.evaluatorType,
  };
  if (ev.scoreUnit) attrs['gen_ai.evaluation.score.unit'] = ev.scoreUnit;
  if (ev.sessionId) attrs['session.id'] = ev.sessionId;
  return {
    timestamp: ev.timestamp,
    name: 'gen_ai.evaluation.result',
    attributes: attrs,
    traceId: ev.traceId,
  };
}

function hrtToSeconds(hrt: [number, number]): number {
  return hrt[0] + hrt[1] / 1e9;
}

function hrtToISO(hrt: [number, number]): string {
  return new Date(hrt[0] * 1000 + hrt[1] / 1e6).toISOString();
}

function deriveToolCorrectness(span: TraceSpan): EvalRecord | null {
  const attrs = span.attributes;
  const isBuiltin = span.name === 'hook:builtin-post-tool';
  const isMcp = span.name === 'hook:mcp-post-tool';
  if (!isBuiltin && !isMcp) return null;

  const success = isBuiltin ? attrs['builtin.success'] : attrs['mcp.success'];
  const tool = isBuiltin ? attrs['builtin.tool'] : attrs['mcp.tool'];
  const errorType = isBuiltin ? attrs['builtin.error_type'] : attrs['mcp.error_type'];
  const server = isMcp ? attrs['mcp.server'] : undefined;

  const score = success === true ? 1.0 : 0.0;
  const toolLabel = server ? `${server}/${tool}` : String(tool);

  let explanation: string;
  if (success) {
    explanation = `Tool ${toolLabel} completed successfully`;
  } else {
    explanation = `Tool ${toolLabel} failed${errorType ? `: ${errorType}` : ''}`;
  }

  return {
    timestamp: hrtToISO(span.startTime),
    evaluationName: 'tool_correctness',
    scoreValue: score,
    explanation,
    evaluator: 'telemetry-rule-engine',
    evaluatorType: 'rule',
    traceId: span.traceId,
    sessionId: String(attrs['session.id'] ?? ''),
  };
}

function deriveEvaluationLatency(span: TraceSpan): EvalRecord | null {
  // Only measure tool execution hooks (the meaningful ones)
  const measurable = [
    'hook:builtin-post-tool',
    'hook:mcp-post-tool',
    'hook:agent-post-tool',
    'hook:session-start',
    'hook:tsc-check',
  ];
  if (!measurable.includes(span.name)) return null;

  const durationSec = hrtToSeconds(span.duration);
  const attrs = span.attributes;

  let hookType: string;
  if (span.name === 'hook:builtin-post-tool') hookType = `builtin/${attrs['builtin.tool']}`;
  else if (span.name === 'hook:mcp-post-tool') hookType = `mcp/${attrs['mcp.tool']}`;
  else if (span.name === 'hook:agent-post-tool') hookType = `agent/${attrs['agent.type']}`;
  else hookType = span.name.replace('hook:', '');

  return {
    timestamp: hrtToISO(span.startTime),
    evaluationName: 'evaluation_latency',
    scoreValue: durationSec,
    scoreUnit: 'seconds',
    explanation: `Hook ${hookType} executed in ${durationSec.toFixed(EVAL_SCORE_PRECISION)}s`,
    evaluator: 'telemetry-rule-engine',
    evaluatorType: 'rule',
    traceId: span.traceId,
    sessionId: String(attrs['session.id'] ?? ''),
  };
}

// Track per-session task status transitions for task_completion scoring
// Graduated: pending=0.0, in_progress=0.5, completed=1.0
interface TaskState {
  statuses: Set<string>;
  lastSpan: TraceSpan;
}

interface SessionTaskData {
  tasks: Map<string, TaskState>;  // taskId -> state
  creates: number;   // fallback counters for old trace data
  updates: number;
  lastSpan: TraceSpan | null;
}

const sessionTasks = new Map<string, SessionTaskData>();

export const STATUS_SCORES: Record<string, number> = {
  pending: 0.0,
  in_progress: 0.5,
  completed: 1.0,
};

export { sessionTasks };

export function trackTaskActivity(span: TraceSpan): void {
  if (span.name !== 'hook:builtin-post-tool') return;
  const tool = span.attributes['builtin.tool'];
  if (tool !== 'TaskCreate' && tool !== 'TaskUpdate') return;

  const sessionId = String(span.attributes['session.id'] ?? 'unknown');
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
  // Highest status reached determines score
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

    if (data.tasks.size > 0) {
      const scores = [...data.tasks.values()].map(t => scoreTask(t.statuses));
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const completed = scores.filter(s => s === 1.0).length;
      const inProgress = scores.filter(s => s === 0.5).length;
      const pending = scores.filter(s => s === 0.0).length;

      const parts: string[] = [];
      if (completed > 0) parts.push(`${completed} completed`);
      if (inProgress > 0) parts.push(`${inProgress} in_progress`);
      if (pending > 0) parts.push(`${pending} pending`);

      evals.push({
        timestamp: hrtToISO(lastSpan.startTime),
        evaluationName: 'task_completion',
        scoreValue: parseFloat(avg.toFixed(EVAL_SCORE_PRECISION)),
        explanation: `Session ${sessionId.slice(0, SESSION_ID_PREVIEW_LEN)}: ${data.tasks.size} tasks (${parts.join(', ')})`,
        evaluator: 'telemetry-rule-engine',
        evaluatorType: 'rule',
        traceId: lastSpan.traceId,
        sessionId,
      });
    } else {
      // Fallback: old trace data without builtin.task_status attributes
      if (data.creates === 0) continue;
      const completionRatio = Math.min(data.updates / (data.creates * 2), 1.0);

      evals.push({
        timestamp: hrtToISO(lastSpan.startTime),
        evaluationName: 'task_completion',
        scoreValue: parseFloat(completionRatio.toFixed(EVAL_SCORE_PRECISION)),
        explanation: `Session ${sessionId.slice(0, SESSION_ID_PREVIEW_LEN)}: ${data.creates} tasks, ${data.updates} updates (ratio fallback)`,
        evaluator: 'telemetry-rule-engine',
        evaluatorType: 'rule',
        traceId: lastSpan.traceId,
        sessionId,
      });
    }
  }

  return evals;
}

interface AgentSessionData {
  pre: number;
  post: number;
  spans: TraceSpan[];
  /** Ordered agent names per post-tool span, used for handoff detection */
  agentSequence: { agentName: string; score: number; span: TraceSpan }[];
}
const sessionAgents = new Map<string, AgentSessionData>();

function trackAgentActivity(span: TraceSpan): void {
  const isPre = span.name === 'hook:agent-pre-tool';
  const isPost = span.name === 'hook:agent-post-tool';
  if (!isPre && !isPost) return;

  const sessionId = String(span.attributes['session.id'] ?? 'unknown');
  let entry = sessionAgents.get(sessionId);
  if (!entry) sessionAgents.set(sessionId, entry = { pre: 0, post: 0, spans: [], agentSequence: [] });;
  if (isPre) entry.pre++;
  if (isPost) {
    entry.post++;
    const agentName = String(span.attributes['gen_ai.agent.name'] ?? 'unknown');
    const score = span.status?.code === 2 ? 0 : 1; // status 2 = ERROR in OTel
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

    evals.push({
      timestamp: hrtToISO(lastSpan.startTime),
      evaluationName: 'task_completion',
      scoreValue: parseFloat(rate.toFixed(EVAL_SCORE_PRECISION)),
      explanation: `Agent completion: ${data.post}/${data.pre} agents finished in session ${sessionId.slice(0, SESSION_ID_PREVIEW_LEN)}`,
      evaluator: 'telemetry-rule-engine',
      evaluatorType: 'rule',
      traceId: lastSpan.traceId,
      sessionId,
    });
  }

  return evals;
}

/** Minimum distinct agents required to detect handoffs */
const MIN_HANDOFF_AGENTS = 2;
/** Minimum score for handoff target correctness (step score >= threshold) */
const HANDOFF_CORRECT_THRESHOLD = 0.5;
/** Minimum score for context preservation (step score >= threshold) */
const HANDOFF_CONTEXT_THRESHOLD = 0.7;

function deriveHandoffCorrectnessPerSession(): EvalRecord[] {
  const evals: EvalRecord[] = [];

  for (const [sessionId, data] of sessionAgents) {
    if (data.agentSequence.length < MIN_HANDOFF_AGENTS) continue;

    const distinctAgents = new Set(data.agentSequence.map(a => a.agentName));
    if (distinctAgents.size < MIN_HANDOFF_AGENTS) continue;

    const handoffScores: number[] = [];
    for (let i = 1; i < data.agentSequence.length; i++) {
      const prev = data.agentSequence[i - 1];
      const curr = data.agentSequence[i];
      if (curr.agentName !== prev.agentName) {
        handoffScores.push(curr.score);
      }
    }

    if (handoffScores.length === 0) continue;

    const avgScore = handoffScores.reduce((a, b) => a + b, 0) / handoffScores.length;
    const correct = handoffScores.filter(s => s >= HANDOFF_CORRECT_THRESHOLD).length;
    const preserved = handoffScores.filter(s => s >= HANDOFF_CONTEXT_THRESHOLD).length;
    const lastSpan = data.agentSequence[data.agentSequence.length - 1].span;

    evals.push({
      timestamp: hrtToISO(lastSpan.startTime),
      evaluationName: 'handoff_correctness',
      scoreValue: parseFloat(avgScore.toFixed(EVAL_SCORE_PRECISION)),
      scoreUnit: 'ratio_0_1',
      explanation: `Session ${sessionId.slice(0, SESSION_ID_PREVIEW_LEN)}: ${handoffScores.length} handoffs across ${distinctAgents.size} agents (${correct}/${handoffScores.length} correct target, ${preserved}/${handoffScores.length} context preserved)`,
      evaluator: 'telemetry-rule-engine',
      evaluatorType: 'rule',
      traceId: lastSpan.traceId,
      sessionId,
    });
  }

  return evals;
}

function main(): void {
  const traceFiles = readdirSync(TELEMETRY_DIR)
    .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))
    .sort();

  const allEvals: EvalRecord[] = [];
  let _spanCount = 0;

  for (const file of traceFiles) {
    const filePath = join(TELEMETRY_DIR, file);
    const spans = readJsonlWithValidationSync(filePath, traceSpanSchema);

    for (const span of spans) {
      _spanCount++;

      const toolCorr = deriveToolCorrectness(span);
      if (toolCorr) allEvals.push(toolCorr);

      const latency = deriveEvaluationLatency(span);
      if (latency) allEvals.push(latency);

      trackTaskActivity(span);
      trackAgentActivity(span);
    }
  }

  allEvals.push(...deriveTaskCompletionPerSession());
  allEvals.push(...deriveAgentCompletionPerSession());
  allEvals.push(...deriveHandoffCorrectnessPerSession());

  const byDate = new Map<string, EvalRecord[]>();
  for (const ev of allEvals) {
    const date = ev.timestamp.slice(0, 10); // YYYY-MM-DD
    let group = byDate.get(date);
    if (!group) byDate.set(date, group = []);
    group.push(ev);
  }

  const RULE_EVALUATOR = 'telemetry-rule-engine';
  let _totalWritten = 0;
  let preservedCount = 0;
  for (const [date, evals] of byDate) {
    const outFile = join(TELEMETRY_DIR, `evaluations-${date}.jsonl`);

    // Read existing evaluations and keep any that weren't produced by derive (e.g. LLM judge)
    const preserved: string[] = [];
    if (existsSync(outFile)) {
      const existingRecs = readJsonlWithValidationSync(outFile, otelEvaluationRecordSchema);
      for (const rec of existingRecs) {
        const evaluator = rec.attributes?.['gen_ai.evaluation.evaluator'];
        if (evaluator && evaluator !== RULE_EVALUATOR) {
          preserved.push(JSON.stringify(rec));
        }
      }
    }

    const ruleLines = evals.map(e => JSON.stringify(toOTelRecord(e)));
    const content = [...ruleLines, ...preserved].join('\n') + '\n';
    writeFileSync(outFile, content);
    _totalWritten += evals.length + preserved.length;
    preservedCount += preserved.length;
  }

  // Calibration step (FE-R1): compute per-metric percentile distributions
  // and persist to .calibration-state.json for the dashboard API to consume.
  const scoresByMetric: Record<string, number[]> = {};
  for (const ev of allEvals) {
    if (!scoresByMetric[ev.evaluationName]) scoresByMetric[ev.evaluationName] = [];
    if (Number.isFinite(ev.scoreValue)) scoresByMetric[ev.evaluationName].push(ev.scoreValue);
  }

  const newDistributions = computeCalibrationDistributions(scoresByMetric);
  if (Object.keys(newDistributions).length > 0) {
    const previousState = loadCalibrationState(TELEMETRY_DIR);
    const { shouldWrite, psiValues } = shouldRecalibrate(previousState, scoresByMetric);
    // psiValues reflects PSI at the time of last write (when shouldWrite: true),
    // not from every check — stable runs don't update the file.
    if (shouldWrite) {
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

  const byCat = new Map<string, number>();
  for (const ev of allEvals) {
    byCat.set(ev.evaluationName, (byCat.get(ev.evaluationName) ?? 0) + 1);
  }
  if (preservedCount > 0) { /* logged externally */ }
  for (const [_name, _count] of byCat) { /* logged externally */ }
}

// Only run when executed directly (not imported as module for testing)
const isDirectRun = process.argv[1]?.endsWith('derive-evaluations.ts') ||
  process.argv[1]?.endsWith('derive-evaluations.js');
if (isDirectRun) {
  main();
}
