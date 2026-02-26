import { Hono } from 'hono';
import { computeMultiAgentEvaluation } from '../../../../dist/lib/quality-multi-agent.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsByTraceId } from '../data-loader.js';
import { queryTraces } from '../../../../dist/tools/query-traces.js';
import type { StepScore } from '../../../../dist/backends/index.js';

export const sessionRoutes = new Hono();

function attr<T>(span: { attributes?: Record<string, unknown> }, key: string): T | undefined {
  return span.attributes?.[key] as T | undefined;
}

/** Load spans for a session over a 90-day window (avoids today-only default). */
async function loadSessionSpans(sessionId: string) {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const result = await queryTraces({
    attributeFilter: { 'session.id': sessionId },
    startDate: ninetyDaysAgo.toISOString().split('T')[0],
    endDate: now.toISOString().split('T')[0],
    limit: 1000,
  });
  return result.traces;
}

/**
 * GET /api/sessions/:sessionId
 * Full session detail: tool usage, token progression, commits, alerts, code quality, evaluations.
 */
sessionRoutes.get('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!sessionId) return c.json({ error: 'sessionId required' }, 400);

  try {
    const spans = await loadSessionSpans(sessionId);

    // Session info from session-start spans
    const sessionStarts = spans.filter(s => attr<string>(s, 'hook.name') === 'session-start');
    const first = sessionStarts[0];
    const last = sessionStarts[sessionStarts.length - 1] ?? first;
    const sessionInfo = {
      projectName: attr<string>(first, 'project.name') ?? 'unknown',
      workingDirectory: attr<string>(first, 'working.directory') ?? '',
      gitRepository: attr<string>(first, 'git.repository') ?? '',
      gitBranch: attr<string>(first, 'git.branch') ?? '',
      nodeVersion: attr<string>(first, 'node.version') ?? '',
      resumeCount: sessionStarts.length,
      initialMessageCount: (attr<number>(first, 'context.message_count') ?? 0),
      initialContextTokens: (attr<number>(first, 'context.estimated_tokens') ?? 0),
      finalMessageCount: (attr<number>(last, 'context.message_count') ?? 0),
      taskCount: attr<number>(first, 'tasks.active') ?? 0,
      uncommittedAtStart: attr<number>(first, 'git.uncommitted') ?? 0,
    };

    // Token progression from stop-event token-metrics-extraction spans
    const tokenSpans = spans
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

    // Tool usage from builtin-post-tool spans
    const toolUsage: Record<string, number> = {};
    for (const s of spans) {
      if (attr<string>(s, 'hook.type') === 'builtin' && attr<string>(s, 'hook.trigger') === 'PostToolUse') {
        const tool = attr<string>(s, 'builtin.tool') ?? 'unknown';
        toolUsage[tool] = (toolUsage[tool] ?? 0) + 1;
      }
    }

    // MCP usage from mcp-post-tool spans
    const mcpUsage: Record<string, number> = {};
    for (const s of spans) {
      if (attr<string>(s, 'hook.type') === 'mcp' && attr<string>(s, 'hook.trigger') === 'PostToolUse') {
        const tool = attr<string>(s, 'mcp.tool') ?? 'unknown';
        mcpUsage[tool] = (mcpUsage[tool] ?? 0) + 1;
      }
    }

    // Agent activity from agent-post-tool spans
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

    // File access from builtin file_path attribute
    const fileCount: Record<string, number> = {};
    for (const s of spans) {
      const fp = attr<string>(s, 'builtin.file_path');
      if (fp) fileCount[fp] = (fileCount[fp] ?? 0) + 1;
    }
    const fileAccess = Object.entries(fileCount)
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    // Git commits from post-commit-review spans
    const gitCommits = spans
      .filter(s => attr<string>(s, 'hook.name') === 'post-commit-review')
      .map(s => {
        const raw = attr<string>(s, 'git.command') ?? '';
        const filesMatch = raw.match(/git add (.+?)(?:\s+&&)/s);
        const files = filesMatch ? filesMatch[1].trim() : '';
        // Extract heredoc commit message
        const msgMatch = raw.match(/<<'?EOF'?\n([\s\S]+?)\nCo-Authored/);
        const fullMessage = msgMatch ? msgMatch[1] : '';
        const subject = fullMessage ? fullMessage.split('\n')[0].trim() : raw.slice(0, 80);
        const body = fullMessage ? fullMessage.split('\n').slice(2).join('\n').trim() : '';
        return { subject, body, files, raw };
      });

    // Alert summary from telemetry-alert-evaluation spans
    const alertSpans = spans.filter(s => attr<string>(s, 'hook.name') === 'telemetry-alert-evaluation');
    const alertSummary = {
      totalFired: alertSpans.reduce((sum, s) => sum + (attr<number>(s, 'alerts.triggered_count') ?? 0), 0),
      stopEvents: alertSpans.length,
    };

    // Code structure from code-structure spans
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

    // Span breakdown by name
    const spanBreakdown: Record<string, number> = {};
    for (const s of spans) {
      spanBreakdown[s.name] = (spanBreakdown[s.name] ?? 0) + 1;
    }

    // Error spans
    const errors = spans
      .filter(s =>
        s.status?.code === 2 ||
        attr<boolean>(s, 'builtin.has_error') === true ||
        attr<boolean>(s, 'agent.has_error') === true
      )
      .map(s => ({
        spanName: s.name,
        tool: attr<string>(s, 'builtin.tool') ?? attr<string>(s, 'agent.type'),
        filePath: attr<string>(s, 'builtin.file_path'),
        statusMessage: s.status?.message,
      }));

    // Multi-agent evaluation
    const agentMapForEval = new Map<number, string>();
    const traceIds = new Set<string>();
    spans.forEach((span, i) => {
      const agent = span.attributes?.['agent.name'] as string | undefined;
      if (agent) agentMapForEval.set(i, agent);
      if (span.traceId) traceIds.add(span.traceId);
    });
    const stepScores: StepScore[] = spans.map((span, i) => ({
      step: i,
      score: typeof span.attributes?.['evaluation.score'] === 'number'
        ? span.attributes['evaluation.score'] as number
        : (span.status?.code === 2 ? 0 : 1),
      explanation: span.name,
    }));
    const evaluation = computeMultiAgentEvaluation(stepScores, agentMapForEval);

    const evalBatches: Awaited<ReturnType<typeof loadEvaluationsByTraceId>>[] = [];
    for (const id of traceIds) {
      evalBatches.push(await loadEvaluationsByTraceId(id));
    }
    const evaluations = evalBatches.flat();

    return c.json({
      sessionId,
      sessionInfo,
      spans,
      toolUsage,
      mcpUsage,
      agentActivity,
      fileAccess,
      gitCommits,
      tokenProgression: tokenSpans,
      spanBreakdown,
      alertSummary,
      codeStructure,
      errors,
      evaluation,
      evaluations,
    });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
