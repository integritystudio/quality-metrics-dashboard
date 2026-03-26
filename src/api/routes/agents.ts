import { Hono } from 'hono';
import { computeMultiAgentEvaluation } from '../../../../dist/lib/quality/quality-multi-agent.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { loadTracesBySessionId, loadEvaluationsByTraceIds } from '../data-loader.js';
import { queryTraces } from '../../../../dist/tools/query-traces.js';
import type { StepScore } from '../../../../dist/backends/index.js';
import { VALID_PERIODS, MAX_IDS, KNOWN_SOURCE_TYPES, HttpStatus, SCORE_DISPLAY_PRECISION, TIME_MS } from '../../lib/constants.js';
import { OTEL_STATUS_ERROR_CODE, PARAM_ID_RE, NANOS_TO_MS } from '../api-constants.js';
import { buildWorkflowGraph } from '../../lib/workflow-graph.js';

const LIMIT_AGENT_SPANS = 1000;

type SpanLike = { attributes?: Record<string, unknown> };

function attrStr(span: SpanLike, key: string, fallback = 'unknown'): string {
  const v = span.attributes?.[key];
  return typeof v === 'string' ? v : fallback;
}

function attrNum(span: SpanLike, key: string, fallback = 0): number {
  const v = span.attributes?.[key];
  return typeof v === 'number' ? v : fallback;
}

function toDateOnly(d: Date): string {
  return d.toISOString().split('T')[0];
}

type AgentAcc = {
  invocations: number;
  errors: number;
  rateLimitCount: number;
  totalOutputSize: number;
  sessions: Set<string>;
  traceIds: Set<string>;
  sourceTypes: Record<string, number>;
  dailyCounts: number[];
};

function computeEvalMetricSummary(scores: number[]): { avg: number; min: number; max: number; count: number } {
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    avg: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(SCORE_DISPLAY_PRECISION),
    min: +sorted[0].toFixed(SCORE_DISPLAY_PRECISION),
    max: +sorted[sorted.length - 1].toFixed(SCORE_DISPLAY_PRECISION),
    count: sorted.length,
  };
}

function createAgentAccumulator(periodDays: number): AgentAcc {
  return {
    invocations: 0,
    errors: 0,
    rateLimitCount: 0,
    totalOutputSize: 0,
    sessions: new Set(),
    traceIds: new Set(),
    sourceTypes: Object.create(null),
    dailyCounts: new Array(periodDays).fill(0),
  };
}

export const agentRoutes = new Hono();

agentRoutes.get('/agents', async (c) => {
  const periodParam = c.req.query('period') ?? '30d';
  const periodDays = VALID_PERIODS[periodParam];
  if (periodDays === undefined) {
    return c.json({ error: `Invalid period value. Must be one of: ${Object.keys(VALID_PERIODS).join(', ')}` }, HttpStatus.BadRequest);
  }
  const now = new Date();
  const endDate = toDateOnly(now);
  const startDate = toDateOnly(new Date(now.getTime() - periodDays * TIME_MS.DAY));

  try {
    const result = await queryTraces({
      attributeFilter: { 'hook.name': 'agent-post-tool' },
      startDate,
      endDate,
      limit: LIMIT_AGENT_SPANS,
    });

    // Build date bucket keys for the period (YYYY-MM-DD strings)
    const dateBuckets: string[] = [];
    for (let d = 0; d < periodDays; d++) {
      const day = new Date(now.getTime() - (periodDays - 1 - d) * TIME_MS.DAY);
      dateBuckets.push(toDateOnly(day));
    }
    const bucketIndex = new Map(dateBuckets.map((b, i) => [b, i]));

    // Phase 1: aggregate agent stats from spans (prototype-safe accumulators)
    const acc: Record<string, AgentAcc> = Object.create(null);

    // Build traceId -> agent names mapping for evaluation join
    const traceToAgents = new Map<string, Set<string>>();

    for (const span of result.traces) {
      const name = attrStr(span, 'gen_ai.agent.name');
      if (!acc[name]) {
        acc[name] = createAgentAccumulator(periodDays);
      }
      acc[name].invocations++;
      // Bucket into daily counts
      if (span.startTimeUnixNano) {
        const dayKey = toDateOnly(new Date(span.startTimeUnixNano / NANOS_TO_MS));
        const idx = bucketIndex.get(dayKey);
        if (idx !== undefined) acc[name].dailyCounts[idx]++;
      }
      if (span.attributes?.['agent.has_error']) acc[name].errors++;
      if (span.attributes?.['agent.has_rate_limit']) acc[name].rateLimitCount++;
      acc[name].totalOutputSize += attrNum(span, 'agent.output_size');
      const sid = attrStr(span, 'session.id', '');
      if (sid) acc[name].sessions.add(sid);
      if (span.traceId) {
        acc[name].traceIds.add(span.traceId);
        if (!traceToAgents.has(span.traceId)) traceToAgents.set(span.traceId, new Set());
        traceToAgents.get(span.traceId)!.add(name);
      }
      const rawSrc = attrStr(span, 'agent.source_type');
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
        evalSummary[metric] = computeEvalMetricSummary(scores);
      }

      const sessionIdList = [...d.sessions];
      const traceIdList = [...d.traceIds];

      return {
        agentName,
        invocations: d.invocations,
        errors: d.errors,
        errorRate: d.invocations > 0 ? +(d.errors / d.invocations).toFixed(SCORE_DISPLAY_PRECISION) : 0,
        rateLimitCount: d.rateLimitCount,
        avgOutputSize: d.invocations > 0 ? Math.round(d.totalOutputSize / d.invocations) : 0,
        sessionCount: d.sessions.size,  // total unique sessions (invariant: >= sessionIds.length)
        sessionIds: sessionIdList.slice(0, MAX_IDS),
        sessionIdsTruncated: sessionIdList.length > MAX_IDS,
        traceIdsTotal: traceIdList.length,
        traceIds: traceIdList.slice(0, MAX_IDS),
        traceIdsTruncated: traceIdList.length > MAX_IDS,
        sourceTypes: d.sourceTypes,
        dailyCounts: d.dailyCounts,
        evalSummary,
      };
    }).sort((a, b) => b.invocations - a.invocations);

    return c.json({ period: periodParam, startDate, endDate, agents });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});

/**
 * GET /api/agents/:sessionId
 * Loads spans for a session, builds agentMap, computes multi-agent evaluation.
 */
agentRoutes.get('/agents/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!sessionId || !PARAM_ID_RE.test(sessionId)) {
    return c.json({ error: 'Invalid sessionId format' }, HttpStatus.BadRequest);
  }

  try {
    const spans = await loadTracesBySessionId(sessionId);

    // Build agentMap from span attributes.
    // WG-C1: Real spans may carry the agent name under either 'agent.name' (hooks
    // context) or 'gen_ai.agent.name' (OTel GenAI semantic conventions). Both are
    // checked here so the agentMap is populated regardless of which attribute the
    // instrumentation emits. workflow-graph.ts uses 'gen_ai.agent.name' for node
    // scoring; the agentMap built here is used by computeMultiAgentEvaluation only.
    const agentMap = new Map<number, string>();
    const traceIds = new Set<string>();
    spans.forEach((span, i) => {
      const agent = attrStr(span, 'agent.name', '') || attrStr(span, 'gen_ai.agent.name', '') || undefined;
      if (agent) agentMap.set(i, agent);
      if (span.traceId) traceIds.add(span.traceId);
    });

    // Build step scores from spans
    const stepScores: StepScore[] = spans.map((span, i) => ({
      step: i,
      score: attrNum(span, 'evaluation.score', span.status?.code === OTEL_STATUS_ERROR_CODE ? 0 : 1),
      explanation: span.name,
    }));

    // Compute multi-agent evaluation
    const evaluation = computeMultiAgentEvaluation(stepScores, agentMap);

    // Bulk-load evaluations for all traces in the session
    const evaluations = await loadEvaluationsByTraceIds([...traceIds]);

    const serializedAgentMap = Object.fromEntries(agentMap);
    const graph = buildWorkflowGraph(evaluation, spans);

    return c.json({
      sessionId,
      spans,
      evaluation,
      evaluations,
      agentMap: serializedAgentMap,
      graph,
    });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
