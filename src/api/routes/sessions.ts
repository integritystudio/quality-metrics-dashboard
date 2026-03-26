import { Hono } from 'hono';
import { subMilliseconds, formatISO } from 'date-fns';
import { computeMultiAgentEvaluation } from '../../../../dist/lib/quality/quality-multi-agent.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { HttpStatus, PERIOD_MS, SCORE_DISPLAY_PRECISION, TIME_MS } from '../../lib/constants.js';
import {
  COMMIT_BODY_START_LINE_INDEX,
  COMMIT_SUBJECT_FALLBACK_MAX_CHARS,
  FILE_ACCESS_TOP_N,
  LATENCY_P50,
  LATENCY_P95,
  LOG_SUMMARY_FIELDS,
  LOG_SUMMARY_MAX_ENTRIES,
  type SafeLogEntry,
  OTEL_STATUS_ERROR_CODE,
  PARAM_ID_RE,
  PERCENT_BASE,
  LATENCY_DISPLAY_PRECISION,
} from '../api-constants.js';
import {
  loadEvaluationsBySessionId,
  loadLogsBySessionId,
} from '../data-loader.js';
import { queryTraces } from '../../../../dist/tools/query-traces.js';
import type { StepScore } from '../../../../dist/backends/index.js';

export const sessionRoutes = new Hono();

function attr<T>(span: { attributes?: Record<string, unknown> }, key: string): T | undefined {
  return span.attributes?.[key] as T | undefined;
}

/**
 * Parses a timestamp string to milliseconds since epoch.
 * Returns null for empty, missing, or invalid strings that would produce NaN
 * and corrupt tsMin/tsMax comparisons (CR-ERR-1).
 */
function parseTimestamp(value: string | undefined | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return isNaN(ms) ? null : ms;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p / PERCENT_BASE) - 1;
  return sorted[Math.max(0, idx)];
}

function incrementCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

type LatencyStats = { count: number; avg: number; p50: number; p95: number; max: number };

function computeLatencyStats(durations: number[]): LatencyStats {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    avg: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(LATENCY_DISPLAY_PRECISION),
    p50: +percentile(sorted, LATENCY_P50).toFixed(LATENCY_DISPLAY_PRECISION),
    p95: +percentile(sorted, LATENCY_P95).toFixed(LATENCY_DISPLAY_PRECISION),
    max: +sorted[sorted.length - 1].toFixed(LATENCY_DISPLAY_PRECISION),
  };
}

type ScoreStats = { avg: number | null; min: number | null; max: number | null };

function computeScoreStats(scores: number[]): ScoreStats {
  if (scores.length === 0) return { avg: null, min: null, max: null };
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    avg: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(SCORE_DISPLAY_PRECISION),
    min: +sorted[0].toFixed(SCORE_DISPLAY_PRECISION),
    max: +sorted[sorted.length - 1].toFixed(SCORE_DISPLAY_PRECISION),
  };
}

const LIMIT_SESSION_SPANS = 1000;

/** Load spans for a session, defaulting to 30-day window. */
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

/**
 * GET /api/sessions/:sessionId
 *
 * Returns structured session data from all available telemetry sources:
 * traces, logs, and evaluations — queried in parallel by sessionId.
 */
sessionRoutes.get('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!sessionId || !PARAM_ID_RE.test(sessionId)) {
    return c.json({ error: 'Invalid sessionId format' }, HttpStatus.BadRequest);
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
    for (const s of spans) {
      if (s.traceId) traceIds.add(s.traceId);
    }
    const dataSources = {
      traces: { count: spans.length, traceIds: traceIds.size },
      logs: { count: logs.length },
      evaluations: { count: evaluations.length },
      total: spans.length + logs.length + evaluations.length,
    };

    let tsMin = Infinity;
    let tsMax = -Infinity;
    for (const ev of evaluations) {
      const t = parseTimestamp(ev.timestamp);
      if (t !== null) {
        if (t < tsMin) tsMin = t;
        if (t > tsMax) tsMax = t;
      }
    }
    for (const l of logs) {
      const t = parseTimestamp((l as { timestamp?: string }).timestamp);
      if (t !== null) {
        if (t < tsMin) tsMin = t;
        if (t > tsMax) tsMax = t;
      }
    }
    const timespan = tsMin < Infinity ? {
      start: new Date(tsMin).toISOString(),
      end: new Date(tsMax).toISOString(),
      durationHours: +((tsMax - tsMin) / TIME_MS.HOUR).toFixed(LATENCY_DISPLAY_PRECISION),
    } : null;

    const sessionStarts = spans.filter(s => attr<string>(s, 'hook.name') === 'session-start');
    const first = sessionStarts[0];
    const last = sessionStarts[sessionStarts.length - 1] ?? first;
    const sessionInfo = first ? {
      projectName: attr<string>(first, 'project.name') ?? 'unknown',
      workingDirectory: attr<string>(first, 'working.directory') ?? '',
      gitRepository: attr<string>(first, 'git.repository') ?? '',
      gitBranch: attr<string>(first, 'git.branch') ?? '',
      nodeVersion: attr<string>(first, 'node.version') ?? '',
      resumeCount: sessionStarts.length,
      initialMessageCount: attr<number>(first, 'context.message_count') ?? 0,
      initialContextTokens: attr<number>(first, 'context.estimated_tokens') ?? 0,
      finalMessageCount: attr<number>(last, 'context.message_count') ?? 0,
      taskCount: attr<number>(first, 'tasks.active') ?? 0,
      uncommittedAtStart: attr<number>(first, 'git.uncommitted') ?? 0,
    } : null;

    const tokenProgression = spans
      .filter(s => attr<string>(s, 'hook.name') === 'token-metrics-extraction')
      .map(s => ({
        messages: attr<number>(s, 'tokens.messages') ?? 0,
        inputTokens: attr<number>(s, 'tokens.input') ?? 0,
        outputTokens: attr<number>(s, 'tokens.output') ?? 0,
        cacheRead: attr<number>(s, 'tokens.cache_read') ?? 0,
        cacheCreation: attr<number>(s, 'tokens.cache_creation') ?? 0,
        model: attr<string>(s, 'tokens.model') ?? '',
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

    const toolUsage: Record<string, number> = {};
    const mcpUsage: Record<string, number> = {};
    const spanBreakdown: Record<string, number> = {};
    const hookDurations: Record<string, number[]> = {};
    for (const s of spans) {
      const hookType = attr<string>(s, 'hook.type');
      const hookTrigger = attr<string>(s, 'hook.trigger');
      if (hookTrigger === 'PostToolUse') {
        if (hookType === 'builtin') incrementCount(toolUsage, attr<string>(s, 'builtin.tool') ?? 'unknown');
        else if (hookType === 'mcp') incrementCount(mcpUsage, attr<string>(s, 'mcp.tool') ?? 'unknown');
      }
      incrementCount(spanBreakdown, s.name);
      const ms = s.durationMs ?? 0;
      if (ms > 0) {
        if (!hookDurations[s.name]) hookDurations[s.name] = [];
        hookDurations[s.name].push(ms);
      }
    }
    const hookLatency: Record<string, { count: number; avg: number; p50: number; p95: number; max: number }> = {};
    for (const [name, durations] of Object.entries(hookDurations)) {
      hookLatency[name] = computeLatencyStats(durations);
    }

    const errorsByCategory: Record<string, number> = {};
    const errorDetails: Array<{
      spanName: string;
      tool?: string;
      errorType?: string;
      filePath?: string;
    }> = [];
    for (const s of spans) {
      const hasError = attr<boolean>(s, 'builtin.has_error') === true
        || attr<boolean>(s, 'agent.has_error') === true
        || s.status?.code === OTEL_STATUS_ERROR_CODE;
      if (!hasError) continue;
      const tool = attr<string>(s, 'builtin.tool') ?? attr<string>(s, 'agent.type') ?? 'unknown';
      const errType = attr<string>(s, 'builtin.error_type') ?? 'unknown';
      const key = `${tool} -> ${errType}`;
      incrementCount(errorsByCategory, key);
      errorDetails.push({
        spanName: s.name,
        tool,
        errorType: errType,
        filePath: attr<string>(s, 'builtin.file_path'),
      });
    }

    const agentAcc: Record<string, { invocations: number; errors: number; hasRateLimit: boolean; totalOutputSize: number }> = {};
    for (const s of spans) {
      if (attr<string>(s, 'hook.name') === 'agent-post-tool') {
        const name = attr<string>(s, 'gen_ai.agent.name') ?? 'unknown';
        if (!agentAcc[name]) agentAcc[name] = { invocations: 0, errors: 0, hasRateLimit: false, totalOutputSize: 0 };
        agentAcc[name].invocations++;
        if (attr<boolean>(s, 'agent.has_error')) agentAcc[name].errors++;
        if (attr<boolean>(s, 'agent.has_rate_limit')) agentAcc[name].hasRateLimit = true;
        agentAcc[name].totalOutputSize += attr<number>(s, 'agent.output_size') ?? 0;
      }
    }
    const agentActivity = Object.entries(agentAcc).map(([agentName, d]) => ({
      agentName,
      invocations: d.invocations,
      errors: d.errors,
      hasRateLimit: d.hasRateLimit,
      avgOutputSize: d.invocations > 0 ? Math.round(d.totalOutputSize / d.invocations) : 0,
    }));

    const fileCount: Record<string, number> = {};
    for (const s of spans) {
      const fp = attr<string>(s, 'builtin.file_path');
      if (fp) incrementCount(fileCount, fp);
    }
    const fileAccess = Object.entries(fileCount)
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, FILE_ACCESS_TOP_N);

    const gitCommits = spans
      .filter(s => attr<string>(s, 'hook.name') === 'post-commit-review')
      .map(s => {
        const raw = attr<string>(s, 'git.command') ?? '';
        const filesMatch = raw.match(/git add (.+?)(?:\s+&&)/s);
        const files = filesMatch ? filesMatch[1].trim() : '';
        const msgMatch = raw.match(/<<'?EOF'?\n([\s\S]+?)\nCo-Authored/);
        const fullMessage = msgMatch ? msgMatch[1] : '';
        const subject = fullMessage ? fullMessage.split('\n')[0].trim() : raw.slice(0, COMMIT_SUBJECT_FALLBACK_MAX_CHARS);
        const body = fullMessage ? fullMessage.split('\n').slice(COMMIT_BODY_START_LINE_INDEX).join('\n').trim() : '';
        return { subject, body, files };
      });

    const alertSpans = spans.filter(s => attr<string>(s, 'hook.name') === 'telemetry-alert-evaluation');
    const alertSummary = {
      totalFired: alertSpans.reduce((sum, s) => sum + (attr<number>(s, 'alerts.triggered_count') ?? 0), 0),
      stopEvents: alertSpans.length,
    };

    const codeStructure = spans
      .filter(s => attr<string>(s, 'hook.name') === 'code-structure')
      .map(s => ({
        file: attr<string>(s, 'code.structure.file') ?? '',
        lines: attr<number>(s, 'code.structure.lines') ?? 0,
        exports: attr<number>(s, 'code.structure.exports') ?? 0,
        functions: attr<number>(s, 'code.structure.functions') ?? 0,
        hasTypes: attr<boolean>(s, 'code.structure.has_types') ?? false,
        score: attr<number>(s, 'code.structure.score') ?? 0,
        tool: attr<string>(s, 'code.structure.tool') ?? '',
      }));

    const evalByName: Record<string, { count: number; scores: number[] }> = {};
    for (const ev of evaluations) {
      const name = ev.evaluationName;
      if (!evalByName[name]) evalByName[name] = { count: 0, scores: [] };
      evalByName[name].count++;
      if (ev.scoreValue != null && Number.isFinite(ev.scoreValue)) {
        evalByName[name].scores.push(ev.scoreValue);
      }
    }
    const evaluationBreakdown = Object.entries(evalByName).map(([name, d]) => {
      const { avg, min, max } = computeScoreStats(d.scores);
      return { name, count: d.count, avg, min, max };
    });

    const logBySeverity: Record<string, number> = {};
    for (const l of logs) {
      const sev = (l as { severity?: string }).severity ?? 'UNKNOWN';
      incrementCount(logBySeverity, sev);
    }

    // WG-C1: check both 'agent.name' (hooks context) and 'gen_ai.agent.name' (OTel GenAI).
    const agentMapForEval = new Map<number, string>();
    spans.forEach((span, i) => {
      const agent = attr<string>(span, 'agent.name') ?? attr<string>(span, 'gen_ai.agent.name');
      if (agent) agentMapForEval.set(i, agent);
    });
    const stepScores: StepScore[] = spans.map((span, i) => ({
      step: i,
      score: attr<number>(span, 'evaluation.score') ?? (span.status?.code === OTEL_STATUS_ERROR_CODE ? 0 : 1),
      explanation: span.name,
    }));
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
          for (const key of LOG_SUMMARY_FIELDS) {
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
