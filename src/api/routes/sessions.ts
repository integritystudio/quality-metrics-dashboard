import { Hono } from 'hono';
import { computeMultiAgentEvaluation } from '../../../../dist/lib/quality-multi-agent.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import {
  loadEvaluationsBySessionId,
  loadLogsBySessionId,
} from '../data-loader.js';
import { queryTraces } from '../../../../dist/tools/query-traces.js';
import type { EvaluationResult, TraceSpan, StepScore } from '../../../../dist/backends/index.js';

export const sessionRoutes = new Hono();

function attr<T>(span: { attributes?: Record<string, unknown> }, key: string): T | undefined {
  return span.attributes?.[key] as T | undefined;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

/** Load spans for a session, defaulting to 30-day window. */
async function loadSessionSpans(sessionId: string, startDate?: string, endDate?: string) {
  const now = new Date();
  const end = endDate ?? now.toISOString().split('T')[0];
  const start = startDate ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const result = await queryTraces({
    attributeFilter: { 'session.id': sessionId },
    startDate: start,
    endDate: end,
    limit: 1000,
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
  if (!sessionId) return c.json({ error: 'sessionId required' }, 400);
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  try {
    // Query all 3 data sources in parallel
    const [spans, logs, evaluations] = await Promise.all([
      loadSessionSpans(sessionId, startDate, endDate),
      loadLogsBySessionId(sessionId, startDate, endDate),
      loadEvaluationsBySessionId(sessionId, startDate, endDate),
    ]);

    // ---- Data Sources Inventory ----
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

    // ---- Session Timespan (from evaluation timestamps — trace query strips time fields) ----
    let tsMin = Infinity;
    let tsMax = -Infinity;
    for (const ev of evaluations) {
      const t = new Date(ev.timestamp).getTime();
      if (t < tsMin) tsMin = t;
      if (t > tsMax) tsMax = t;
    }
    for (const l of logs) {
      const t = new Date((l as { timestamp?: string }).timestamp ?? '').getTime();
      if (!isNaN(t)) {
        if (t < tsMin) tsMin = t;
        if (t > tsMax) tsMax = t;
      }
    }
    const timespan = tsMin < Infinity ? {
      start: new Date(tsMin).toISOString(),
      end: new Date(tsMax).toISOString(),
      durationHours: +((tsMax - tsMin) / 3_600_000).toFixed(1),
    } : null;

    // ---- Session Info from session-start spans ----
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

    // ---- Token Progression ----
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

    // ---- Token Totals ----
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

    // ---- Tool Usage ----
    const toolUsage: Record<string, number> = {};
    for (const s of spans) {
      if (attr<string>(s, 'hook.type') === 'builtin' && attr<string>(s, 'hook.trigger') === 'PostToolUse') {
        const tool = attr<string>(s, 'builtin.tool') ?? 'unknown';
        toolUsage[tool] = (toolUsage[tool] ?? 0) + 1;
      }
    }

    // ---- MCP Usage ----
    const mcpUsage: Record<string, number> = {};
    for (const s of spans) {
      if (attr<string>(s, 'hook.type') === 'mcp' && attr<string>(s, 'hook.trigger') === 'PostToolUse') {
        const tool = attr<string>(s, 'mcp.tool') ?? 'unknown';
        mcpUsage[tool] = (mcpUsage[tool] ?? 0) + 1;
      }
    }

    // ---- Span Breakdown + Hook Latency ----
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
        avg: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1),
        p50: +percentile(sorted, 50).toFixed(1),
        p95: +percentile(sorted, 95).toFixed(1),
        max: +sorted[sorted.length - 1].toFixed(1),
      };
    }

    // ---- Error Categorization ----
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
        || s.status?.code === 2;
      if (!hasError) continue;
      const tool = attr<string>(s, 'builtin.tool') ?? attr<string>(s, 'agent.type') ?? 'unknown';
      const errType = attr<string>(s, 'builtin.error_type') ?? 'unknown';
      const key = `${tool} -> ${errType}`;
      errorsByCategory[key] = (errorsByCategory[key] ?? 0) + 1;
      errorDetails.push({
        spanName: s.name,
        tool,
        errorType: errType,
        filePath: attr<string>(s, 'builtin.file_path'),
      });
    }

    // ---- Agent Activity ----
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

    // ---- File Access ----
    const fileCount: Record<string, number> = {};
    for (const s of spans) {
      const fp = attr<string>(s, 'builtin.file_path');
      if (fp) fileCount[fp] = (fileCount[fp] ?? 0) + 1;
    }
    const fileAccess = Object.entries(fileCount)
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    // ---- Git Commits ----
    const gitCommits = spans
      .filter(s => attr<string>(s, 'hook.name') === 'post-commit-review')
      .map(s => {
        const raw = attr<string>(s, 'git.command') ?? '';
        const filesMatch = raw.match(/git add (.+?)(?:\s+&&)/s);
        const files = filesMatch ? filesMatch[1].trim() : '';
        const msgMatch = raw.match(/<<'?EOF'?\n([\s\S]+?)\nCo-Authored/);
        const fullMessage = msgMatch ? msgMatch[1] : '';
        const subject = fullMessage ? fullMessage.split('\n')[0].trim() : raw.slice(0, 80);
        const body = fullMessage ? fullMessage.split('\n').slice(2).join('\n').trim() : '';
        return { subject, body, files };
      });

    // ---- Alert Summary ----
    const alertSpans = spans.filter(s => attr<string>(s, 'hook.name') === 'telemetry-alert-evaluation');
    const alertSummary = {
      totalFired: alertSpans.reduce((sum, s) => sum + (attr<number>(s, 'alerts.triggered_count') ?? 0), 0),
      stopEvents: alertSpans.length,
    };

    // ---- Code Structure ----
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

    // ---- Evaluation Breakdown (from direct sessionId query) ----
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
      const sorted = d.scores.sort((a, b) => a - b);
      return {
        name,
        count: d.count,
        avg: sorted.length > 0 ? +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(3) : null,
        min: sorted.length > 0 ? +sorted[0].toFixed(3) : null,
        max: sorted.length > 0 ? +sorted[sorted.length - 1].toFixed(3) : null,
      };
    });

    // ---- Log Summary ----
    const logBySeverity: Record<string, number> = {};
    for (const l of logs) {
      const sev = (l as { severity?: string }).severity ?? 'UNKNOWN';
      logBySeverity[sev] = (logBySeverity[sev] ?? 0) + 1;
    }

    // ---- Multi-agent Evaluation ----
    const agentMapForEval = new Map<number, string>();
    spans.forEach((span, i) => {
      const agent = span.attributes?.['agent.name'] as string | undefined;
      if (agent) agentMapForEval.set(i, agent);
    });
    const stepScores: StepScore[] = spans.map((span, i) => ({
      step: i,
      score: typeof span.attributes?.['evaluation.score'] === 'number'
        ? span.attributes['evaluation.score'] as number
        : (span.status?.code === 2 ? 0 : 1),
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
      logSummary: { bySeverity: logBySeverity, logs },
      multiAgentEvaluation,
      evaluations,
    });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
