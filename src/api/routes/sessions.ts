import { min, max, mean, quantileSorted } from 'd3-array';
import { Hono } from 'hono';
import { subMilliseconds, formatISO } from 'date-fns';
import { computeMultiAgentEvaluation } from '../../../../dist/lib/quality/quality-multi-agent.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { HttpStatus, PERIOD_MS, SCORE_DISPLAY_PRECISION, TIME_MS, ErrorMessage } from '../../lib/constants.js';
import {
  COMMIT_BODY_START_LINE_INDEX,
  COMMIT_SUBJECT_FALLBACK_MAX_CHARS,
  FILE_ACCESS_TOP_N,
  HOOK_NAME,
  incrementCount,
  LATENCY_P50,
  LATENCY_P95,
  logSummaryFieldSchema,
  LOG_SUMMARY_MAX_ENTRIES,
  type SafeLogEntry,
  OTEL_STATUS_ERROR_CODE,
  PARAM_ID_RE,
  isValidParam,
  PERCENT_BASE,
  LATENCY_DISPLAY_PRECISION,
  spanAttr,
} from '../api-constants.js';
import {
  loadEvaluationsBySessionId,
  loadLogsBySessionId,
} from '../data-loader.js';
import { queryTraces } from '../../../../dist/tools/query-traces.js';
import type { StepScore } from '../../../../dist/backends/index.js';

export const sessionRoutes = new Hono();

// Max ms value safe for Date.toISOString() — ±100,000,000 days from epoch (ECMAScript spec).
const DATE_ISO_SAFE_MAX_MS = 8_640_000_000_000_000;

/**
 * Parses a timestamp string to milliseconds since epoch.
 * Returns null for empty, missing, NaN, or out-of-range values that would
 * corrupt tsMin/tsMax comparisons or cause Date.toISOString() to throw.
 */
function parseTimestamp(value: string | undefined | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (isNaN(ms) || ms < -DATE_ISO_SAFE_MAX_MS || ms > DATE_ISO_SAFE_MAX_MS) return null;
  return ms;
}

type LatencyStats = { count: number; avg: number; p50: number; p95: number; max: number };

function computeLatencyStats(durations: number[]): LatencyStats {
  if (durations.length === 0) return { count: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    avg: +(mean(sorted) as number).toFixed(LATENCY_DISPLAY_PRECISION),
    p50: +(quantileSorted(sorted, LATENCY_P50 / PERCENT_BASE) as number).toFixed(LATENCY_DISPLAY_PRECISION),
    p95: +(quantileSorted(sorted, LATENCY_P95 / PERCENT_BASE) as number).toFixed(LATENCY_DISPLAY_PRECISION),
    max: +(max(sorted) as number).toFixed(LATENCY_DISPLAY_PRECISION),
  };
}

type ScoreStats = { avg: number | null; min: number | null; max: number | null };

function computeScoreStats(scores: number[]): ScoreStats {
  if (scores.length === 0) return { avg: null, min: null, max: null };
  return {
    avg: +(mean(scores) as number).toFixed(SCORE_DISPLAY_PRECISION),
    min: +(min(scores) as number).toFixed(SCORE_DISPLAY_PRECISION),
    max: +(max(scores) as number).toFixed(SCORE_DISPLAY_PRECISION),
  };
}

const LIMIT_SESSION_SPANS = 1000;

async function loadSessionSpans(sessionId: string, startDate?: string, endDate?: string) {
  const now = new Date();
  const end = endDate ?? formatISO(now, { representation: 'date' });
  const start = startDate ?? formatISO(subMilliseconds(now, PERIOD_MS['30d']), { representation: 'date' });
  const result = await queryTraces({
    attributeFilter: { 'session.id': sessionId },
    startDate: start,
    endDate: end,
    limit: LIMIT_SESSION_SPANS,
  });
  return result.traces;
}

sessionRoutes.get('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!isValidParam(sessionId, PARAM_ID_RE)) {
    return c.json({ error: ErrorMessage.InvalidSessionIdFormat }, HttpStatus.BadRequest);
  }
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  try {
    const [spans, logs, evaluations] = await Promise.all([
      loadSessionSpans(sessionId, startDate, endDate),
      loadLogsBySessionId(sessionId, startDate, endDate),
      loadEvaluationsBySessionId(sessionId, startDate, endDate),
    ]);

    const traceIds = new Set<string>();
    let firstSessionStart: (typeof spans)[0] | undefined;
    let lastSessionStart: (typeof spans)[0] | undefined;
    let sessionStartCount = 0;
    const tokenProgressionRaw: Array<{ messages: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number; model: string }> = [];
    const toolUsage: Record<string, number> = {};
    const mcpUsage: Record<string, number> = {};
    const spanBreakdown: Record<string, number> = {};
    const hookDurations: Record<string, number[]> = {};
    const errorsByCategory: Record<string, number> = {};
    const errorDetails: Array<{ spanName: string; tool?: string; errorType?: string; filePath?: string }> = [];
    const agentAcc = Object.create(null) as Record<string, { invocations: number; errors: number; hasRateLimit: boolean; totalOutputSize: number }>;
    const fileCount: Record<string, number> = {};
    const gitCommits: Array<{ subject: string; body: string; files: string }> = [];
    let alertTotalFired = 0;
    let alertStopEvents = 0;
    const codeStructure: Array<{ file: string; lines: number; exports: number; functions: number; hasTypes: boolean; score: number; tool: string }> = [];
    // Check both 'agent.name' (hooks context) and 'gen_ai.agent.name' (OTel GenAI).
    const agentMapForEval = new Map<number, string>();
    const stepScores: StepScore[] = [];

    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      const hookName = spanAttr(s, 'hook.name', 'string');
      const hookType = spanAttr(s, 'hook.type', 'string');
      const hookTrigger = spanAttr(s, 'hook.trigger', 'string');

      if (s.traceId) traceIds.add(s.traceId);

      if (hookName === HOOK_NAME.SESSION_START) {
        if (!firstSessionStart) firstSessionStart = s;
        lastSessionStart = s;
        sessionStartCount++;
      }

      if (hookName === HOOK_NAME.TOKEN_METRICS) {
        tokenProgressionRaw.push({
          messages: spanAttr(s, 'tokens.messages', 'number') ?? 0,
          inputTokens: spanAttr(s, 'tokens.input', 'number') ?? 0,
          outputTokens: spanAttr(s, 'tokens.output', 'number') ?? 0,
          cacheRead: spanAttr(s, 'tokens.cache_read', 'number') ?? 0,
          cacheCreation: spanAttr(s, 'tokens.cache_creation', 'number') ?? 0,
          model: spanAttr(s, 'tokens.model', 'string') ?? '',
        });
      }

      if (hookTrigger === 'PostToolUse') {
        if (hookType === 'builtin') incrementCount(toolUsage, spanAttr(s, 'builtin.tool', 'string') ?? 'unknown');
        else if (hookType === 'mcp') incrementCount(mcpUsage, spanAttr(s, 'mcp.tool', 'string') ?? 'unknown');
      }

      incrementCount(spanBreakdown, s.name);
      const ms = s.durationMs ?? 0;
      if (ms > 0) {
        (hookDurations[s.name] ??= []).push(ms);
      }

      const hasError = spanAttr(s, 'builtin.has_error', 'boolean') === true
        || spanAttr(s, 'agent.has_error', 'boolean') === true
        || s.status?.code === OTEL_STATUS_ERROR_CODE;
      if (hasError) {
        const tool = spanAttr(s, 'builtin.tool', 'string') ?? spanAttr(s, 'agent.type', 'string') ?? 'unknown';
        const errType = spanAttr(s, 'builtin.error_type', 'string') ?? 'unknown';
        incrementCount(errorsByCategory, `${tool} -> ${errType}`);
        errorDetails.push({ spanName: s.name, tool, errorType: errType, filePath: spanAttr(s, 'builtin.file_path', 'string') });
      }

      if (hookName === HOOK_NAME.AGENT_POST_TOOL) {
        const name = spanAttr(s, 'gen_ai.agent.name', 'string') ?? 'unknown';
        const agentEntry = (agentAcc[name] ??= { invocations: 0, errors: 0, hasRateLimit: false, totalOutputSize: 0 });
        agentEntry.invocations++;
        if (spanAttr(s, 'agent.has_error', 'boolean')) agentEntry.errors++;
        if (spanAttr(s, 'agent.has_rate_limit', 'boolean')) agentEntry.hasRateLimit = true;
        agentEntry.totalOutputSize += spanAttr(s, 'agent.output_size', 'number') ?? 0;
      }

      const fp = spanAttr(s, 'builtin.file_path', 'string');
      if (fp) incrementCount(fileCount, fp);

      if (hookName === HOOK_NAME.POST_COMMIT_REVIEW) {
        const raw = spanAttr(s, 'git.command', 'string') ?? '';
        const filesMatch = raw.match(/git add (.+?)(?:\s+&&)/s);
        const files = filesMatch ? filesMatch[1].trim() : '';
        const msgMatch = raw.match(/<<'?EOF'?\n([\s\S]+?)\nCo-Authored/);
        const fullMessage = msgMatch ? msgMatch[1] : '';
        gitCommits.push({
          subject: fullMessage ? fullMessage.split('\n')[0].trim() : raw.slice(0, COMMIT_SUBJECT_FALLBACK_MAX_CHARS),
          body: fullMessage ? fullMessage.split('\n').slice(COMMIT_BODY_START_LINE_INDEX).join('\n').trim() : '',
          files,
        });
      }

      if (hookName === HOOK_NAME.ALERT_EVALUATION) {
        alertTotalFired += spanAttr(s, 'alerts.triggered_count', 'number') ?? 0;
        alertStopEvents++;
      }

      if (hookName === HOOK_NAME.CODE_STRUCTURE) {
        codeStructure.push({
          file: spanAttr(s, 'code.structure.file', 'string') ?? '',
          lines: spanAttr(s, 'code.structure.lines', 'number') ?? 0,
          exports: spanAttr(s, 'code.structure.exports', 'number') ?? 0,
          functions: spanAttr(s, 'code.structure.functions', 'number') ?? 0,
          hasTypes: spanAttr(s, 'code.structure.has_types', 'boolean') ?? false,
          score: spanAttr(s, 'code.structure.score', 'number') ?? 0,
          tool: spanAttr(s, 'code.structure.tool', 'string') ?? '',
        });
      }

      const agent = spanAttr(s, 'agent.name', 'string') ?? spanAttr(s, 'gen_ai.agent.name', 'string');
      if (agent) agentMapForEval.set(i, agent);
      stepScores.push({
        step: i,
        score: spanAttr(s, 'evaluation.score', 'number') ?? (s.status?.code === OTEL_STATUS_ERROR_CODE ? 0 : 1),
        explanation: s.name,
      });
    }

    const dataSources = {
      traces: { count: spans.length, traceIds: traceIds.size },
      logs: { count: logs.length },
      evaluations: { count: evaluations.length },
      total: spans.length + logs.length + evaluations.length,
    };

    const tsMin = Infinity;
    const tsMax = -Infinity;
    const evalByName = Object.create(null) as Record<string, { count: number; scores: number[] }>;
    for (const ev of evaluations) {
      const t = parseTimestamp(ev.timestamp);
      if (t !== null) {
        if (t < tsMin) tsMin = t;
        if (t > tsMax) tsMax = t;
      }
      const entry = (evalByName[ev.evaluationName] ??= { count: 0, scores: [] });
      entry.count++;
      if (ev.scoreValue != null && Number.isFinite(ev.scoreValue)) {
        entry.scores.push(ev.scoreValue);
      }
    }
    const logBySeverity = Object.create(null) as Record<string, number>;
    for (const l of logs) {
      const t = parseTimestamp(l.timestamp);
      if (t !== null) {
        if (t < tsMin) tsMin = t;
        if (t > tsMax) tsMax = t;
      }
      incrementCount(logBySeverity, l.severity);
    }
    const timespan = tsMin < Infinity ? {
      start: new Date(tsMin).toISOString(),
      end: new Date(tsMax).toISOString(),
      durationHours: +((tsMax - tsMin) / TIME_MS.HOUR).toFixed(LATENCY_DISPLAY_PRECISION),
    } : null;

    const sessionInfo = firstSessionStart ? {
      projectName: spanAttr(firstSessionStart, 'project.name', 'string') ?? 'unknown',
      workingDirectory: spanAttr(firstSessionStart, 'working.directory', 'string') ?? '',
      gitRepository: spanAttr(firstSessionStart, 'git.repository', 'string') ?? '',
      gitBranch: spanAttr(firstSessionStart, 'git.branch', 'string') ?? '',
      nodeVersion: spanAttr(firstSessionStart, 'node.version', 'string') ?? '',
      resumeCount: sessionStartCount,
      initialMessageCount: spanAttr(firstSessionStart, 'context.message_count', 'number') ?? 0,
      initialContextTokens: spanAttr(firstSessionStart, 'context.estimated_tokens', 'number') ?? 0,
      finalMessageCount: spanAttr(lastSessionStart ?? firstSessionStart, 'context.message_count', 'number') ?? 0,
      taskCount: spanAttr(firstSessionStart, 'tasks.active', 'number') ?? 0,
      uncommittedAtStart: spanAttr(firstSessionStart, 'git.uncommitted', 'number') ?? 0,
    } : null;

    const tokenProgression = tokenProgressionRaw.slice().sort((a, b) => a.messages - b.messages);
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

    const hookLatency: Record<string, { count: number; avg: number; p50: number; p95: number; max: number }> = {};
    for (const [name, durations] of Object.entries(hookDurations)) {
      hookLatency[name] = computeLatencyStats(durations);
    }

    const agentActivity = Object.entries(agentAcc).map(([agentName, d]) => ({
      agentName,
      invocations: d.invocations,
      errors: d.errors,
      hasRateLimit: d.hasRateLimit,
      avgOutputSize: d.invocations > 0 ? Math.round(d.totalOutputSize / d.invocations) : 0,
    }));

    const fileAccess = Object.entries(fileCount)
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, FILE_ACCESS_TOP_N);

    const alertSummary = { totalFired: alertTotalFired, stopEvents: alertStopEvents };

    const evaluationBreakdown = Object.entries(evalByName).map(([name, d]) => {
      const { avg, min, max } = computeScoreStats(d.scores);
      return { name, count: d.count, avg, min, max };
    });

    const multiAgentEvaluation = computeMultiAgentEvaluation(stepScores, agentMapForEval);

    return c.json({
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
      errors: { byCategory: errorsByCategory, details: errorDetails },
      agentActivity,
      fileAccess,
      gitCommits,
      alertSummary,
      codeStructure,
      evaluationBreakdown,
      logSummary: {
        bySeverity: logBySeverity,
        logs: logs.slice(-LOG_SUMMARY_MAX_ENTRIES).map(l => {
          const entry: SafeLogEntry = {};
          for (const key of logSummaryFieldSchema.options) {
            const val = l[key];
            if (val !== undefined) (entry as Record<string, unknown>)[key] = val;
          }
          return entry;
        }),
      },
      multiAgentEvaluation,
      evaluations,
    });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
