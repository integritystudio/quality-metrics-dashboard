import { Hono } from 'hono';
import { computeMultiAgentEvaluation } from '../../../../dist/lib/quality-multi-agent.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadTracesBySessionId, loadEvaluationsByTraceIds } from '../data-loader.js';
import { queryTraces } from '../../../../dist/tools/query-traces.js';
import type { StepScore } from '../../../../dist/backends/index.js';
import { VALID_PERIODS, MAX_IDS, KNOWN_SOURCE_TYPES } from '../../lib/constants.js';

export const agentRoutes = new Hono();

agentRoutes.get('/agents', async (c) => {
  const periodParam = c.req.query('period') ?? '30d';
  const periodDays = VALID_PERIODS[periodParam];
  if (periodDays === undefined) {
    return c.json({ error: `Invalid period value. Must be one of: ${Object.keys(VALID_PERIODS).join(', ')}` }, 400);
  }
  const now = new Date();
  const endDate = now.toISOString().split('T')[0];
  const startDate = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const result = await queryTraces({
      attributeFilter: { 'hook.name': 'agent-post-tool' },
      startDate,
      endDate,
      limit: 1000,
    });

    // Build date bucket keys for the period (YYYY-MM-DD strings)
    const dateBuckets: string[] = [];
    for (let d = 0; d < periodDays; d++) {
      const day = new Date(now.getTime() - (periodDays - 1 - d) * 24 * 60 * 60 * 1000);
      dateBuckets.push(day.toISOString().split('T')[0]);
    }
    const bucketIndex = new Map(dateBuckets.map((b, i) => [b, i]));

    // Phase 1: aggregate agent stats from spans (prototype-safe accumulators)
    const acc: Record<string, {
      invocations: number;
      errors: number;
      rateLimitCount: number;
      totalOutputSize: number;
      sessions: Set<string>;
      traceIds: Set<string>;
      sourceTypes: Record<string, number>;
      dailyCounts: number[];
    }> = Object.create(null);

    // Build traceId -> agent names mapping for evaluation join
    const traceToAgents = new Map<string, Set<string>>();

    for (const span of result.traces) {
      const name = (span.attributes?.['gen_ai.agent.name'] as string | undefined) ?? 'unknown';
      if (!acc[name]) {
        acc[name] = { invocations: 0, errors: 0, rateLimitCount: 0, totalOutputSize: 0, sessions: new Set(), traceIds: new Set(), sourceTypes: Object.create(null), dailyCounts: new Array(periodDays).fill(0) };
      }
      acc[name].invocations++;
      // Bucket into daily counts
      if (span.startTimeUnixNano) {
        const dayKey = new Date(span.startTimeUnixNano / 1_000_000).toISOString().split('T')[0];
        const idx = bucketIndex.get(dayKey);
        if (idx !== undefined) acc[name].dailyCounts[idx]++;
      }
      if (span.attributes?.['agent.has_error']) acc[name].errors++;
      if (span.attributes?.['agent.has_rate_limit']) acc[name].rateLimitCount++;
      acc[name].totalOutputSize += (span.attributes?.['agent.output_size'] as number | undefined) ?? 0;
      const sid = span.attributes?.['session.id'] as string | undefined;
      if (sid) acc[name].sessions.add(sid);
      if (span.traceId) {
        acc[name].traceIds.add(span.traceId);
        if (!traceToAgents.has(span.traceId)) traceToAgents.set(span.traceId, new Set());
        traceToAgents.get(span.traceId)!.add(name);
      }
      const rawSrc = (span.attributes?.['agent.source_type'] as string | undefined) ?? 'unknown';
      const src = KNOWN_SOURCE_TYPES.has(rawSrc) ? rawSrc : 'other';
      acc[name].sourceTypes[src] = (acc[name].sourceTypes[src] ?? 0) + 1;
    }

    // Phase 2: load evaluations for all agent traceIds and join to agents
    const allTraceIds = [...traceToAgents.keys()];
    const evaluations = await loadEvaluationsByTraceIds(allTraceIds, startDate, endDate);

    // Accumulate per-agent evaluation scores by metric name (prototype-safe)
    const agentEvalAcc: Record<string, Record<string, number[]>> = Object.create(null);
    for (const ev of evaluations) {
      if (!ev.traceId || ev.scoreValue == null || !Number.isFinite(ev.scoreValue)) continue;
      const agentNames = traceToAgents.get(ev.traceId);
      if (!agentNames) continue;
      for (const agent of agentNames) {
        if (!agentEvalAcc[agent]) agentEvalAcc[agent] = Object.create(null);
        if (!agentEvalAcc[agent][ev.evaluationName]) agentEvalAcc[agent][ev.evaluationName] = [];
        agentEvalAcc[agent][ev.evaluationName].push(ev.scoreValue);
      }
    }

    const agents = Object.entries(acc).map(([agentName, d]) => {
      // Compute evaluation summary for this agent
      const evalMetrics = agentEvalAcc[agentName] ?? {};
      const evalSummary: Record<string, { avg: number; min: number; max: number; count: number }> = {};
      for (const [metric, scores] of Object.entries(evalMetrics)) {
        const sorted = [...scores].sort((a, b) => a - b);
        evalSummary[metric] = {
          avg: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(3),
          min: +sorted[0].toFixed(3),
          max: +sorted[sorted.length - 1].toFixed(3),
          count: sorted.length,
        };
      }

      const allSessionIds = [...d.sessions];
      const allTraceIdsList = [...d.traceIds];

      return {
        agentName,
        invocations: d.invocations,
        errors: d.errors,
        errorRate: d.invocations > 0 ? +(d.errors / d.invocations).toFixed(3) : 0,
        rateLimitCount: d.rateLimitCount,
        avgOutputSize: d.invocations > 0 ? Math.round(d.totalOutputSize / d.invocations) : 0,
        sessionCount: d.sessions.size,  // total unique sessions (invariant: >= sessionIds.length)
        sessionIds: allSessionIds.slice(0, MAX_IDS),
        sessionIdsTruncated: allSessionIds.length > MAX_IDS,
        traceIdsTotal: allTraceIdsList.length,
        traceIds: allTraceIdsList.slice(0, MAX_IDS),
        traceIdsTruncated: allTraceIdsList.length > MAX_IDS,
        sourceTypes: d.sourceTypes,
        dailyCounts: d.dailyCounts,
        evalSummary,
      };
    }).sort((a, b) => b.invocations - a.invocations);

    return c.json({ period: periodParam, startDate, endDate, agents });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});

/**
 * GET /api/agents/:sessionId
 * Loads spans for a session, builds agentMap, computes multi-agent evaluation.
 */
agentRoutes.get('/agents/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!sessionId) {
    return c.json({ error: 'sessionId is required' }, 400);
  }

  try {
    const spans = await loadTracesBySessionId(sessionId);

    // Build agentMap from span attributes
    const agentMap = new Map<number, string>();
    const traceIds = new Set<string>();
    spans.forEach((span, i) => {
      const agent = span.attributes?.['agent.name'] as string | undefined;
      if (agent) agentMap.set(i, agent);
      if (span.traceId) traceIds.add(span.traceId);
    });

    // Build step scores from spans
    const stepScores: StepScore[] = spans.map((span, i) => ({
      step: i,
      score: typeof span.attributes?.['evaluation.score'] === 'number'
        ? span.attributes['evaluation.score'] as number
        : (span.status?.code === 2 ? 0 : 1),
      explanation: span.name,
    }));

    // Compute multi-agent evaluation
    const evaluation = computeMultiAgentEvaluation(stepScores, agentMap);

    // Bulk-load evaluations for all traces in the session
    const evaluations = await loadEvaluationsByTraceIds([...traceIds]);

    return c.json({
      sessionId,
      spans,
      evaluation,
      evaluations,
      agentMap: Object.fromEntries(agentMap),
    });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
