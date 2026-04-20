import { Hono } from 'hono';
import { computeMultiAgentEvaluation } from '../../../../dist/lib/quality/quality-multi-agent.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { loadTracesBySessionId, loadEvaluationsByTraceIds } from '../data-loader.js';
import { queryTraces } from '../../../../dist/tools/query-traces.js';
import type { StepScore } from '../../../../dist/backends/index.js';
import { VALID_PERIODS, MAX_IDS, KNOWN_SOURCE_TYPES, HttpStatus, SCORE_DISPLAY_PRECISION, TIME_MS, ErrorMessage } from '../../lib/constants.js';
import { HOOK_NAME, incrementCount, OTEL_STATUS_ERROR_CODE, PARAM_ID_RE, NANOS_TO_MS, attrStr, attrNum, spanAttr, toDateOnly, isValidParam } from '../api-constants.js';
import { buildWorkflowGraph } from '../../lib/workflow-graph.js';
import { mean } from 'd3-array';

const LIMIT_AGENT_SPANS = 1000;

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
    avg: +(mean(sorted) ?? 0).toFixed(SCORE_DISPLAY_PRECISION),
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
    sourceTypes: Object.create(null) as Record<string, number>,
    dailyCounts: new Array<number>(periodDays).fill(0),
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
      attributeFilter: { 'hook.name': HOOK_NAME.AGENT_POST_TOOL },
      startDate,
      endDate,
      limit: LIMIT_AGENT_SPANS,
    });

    const dateBuckets: string[] = [];
    const bucketIndex = new Map<string, number>();
    for (let d = 0; d < periodDays; d++) {
      const day = toDateOnly(new Date(now.getTime() - (periodDays - 1 - d) * TIME_MS.DAY));
      dateBuckets.push(day);
      bucketIndex.set(day, d);
    }

    const acc = Object.create(null) as Record<string, AgentAcc>;

    const traceToAgents = new Map<string, Set<string>>();

    for (const span of result.traces) {
      const name = attrStr(span, 'gen_ai.agent.name');
      const entry = (acc[name] ??= createAgentAccumulator(periodDays));
      entry.invocations++;
      if (span.startTimeUnixNano) {
        const dayKey = toDateOnly(new Date(span.startTimeUnixNano / NANOS_TO_MS));
        const idx = bucketIndex.get(dayKey);
        if (idx !== undefined) entry.dailyCounts[idx]++;
      }
      if (spanAttr(span, 'agent.has_error', 'boolean')) entry.errors++;
      if (spanAttr(span, 'agent.has_rate_limit', 'boolean')) entry.rateLimitCount++;
      entry.totalOutputSize += attrNum(span, 'agent.output_size');
      const sid = attrStr(span, 'session.id', '');
      if (sid) entry.sessions.add(sid);
      if (span.traceId) {
        entry.traceIds.add(span.traceId);
        let agentSet = traceToAgents.get(span.traceId);
        if (!agentSet) traceToAgents.set(span.traceId, agentSet = new Set());
        agentSet.add(name);
      }
      const rawSrc = attrStr(span, 'agent.source_type');
      const src = KNOWN_SOURCE_TYPES.has(rawSrc) ? rawSrc : 'other';
      incrementCount(entry.sourceTypes, src);
    }

    const allTraceIds = [...traceToAgents.keys()];
    const evaluations = await loadEvaluationsByTraceIds(allTraceIds, startDate, endDate);

    const agentEvalAcc = Object.create(null) as Record<string, Record<string, number[]>>;
    for (const ev of evaluations) {
      if (!ev.traceId || ev.scoreValue == null || !Number.isFinite(ev.scoreValue)) continue;
      const agentNames = traceToAgents.get(ev.traceId);
      if (!agentNames) continue;
      for (const agent of agentNames) {
        const metrics = (agentEvalAcc[agent] ??= Object.create(null));
        (metrics[ev.evaluationName] ??= []).push(ev.scoreValue);
      }
    }

    const agents = Object.entries(acc).map(([agentName, d]) => {
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
  if (!isValidParam(sessionId, PARAM_ID_RE)) {
    return c.json({ error: ErrorMessage.InvalidSessionIdFormat }, HttpStatus.BadRequest);
  }

  try {
    const spans = await loadTracesBySessionId(sessionId);

    // Real spans may carry the agent name under either 'agent.name' (hooks
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

    const stepScores: StepScore[] = spans.map((span, i) => ({
      step: i,
      score: attrNum(span, 'evaluation.score', span.status?.code === OTEL_STATUS_ERROR_CODE ? 0 : 1),
      explanation: span.name,
    }));

    const evalPromise = loadEvaluationsByTraceIds([...traceIds]);
    const evaluation = computeMultiAgentEvaluation(stepScores, agentMap);
    const evaluations = await evalPromise;

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
