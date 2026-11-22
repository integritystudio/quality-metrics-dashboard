import type { MultiAgentEvaluation } from '../../types.js';
import type { WorkflowGraph } from '../../types/workflow-graph.js';
import { computeMultiAgentEvaluation } from '../parent/quality-multi-agent.js';
import { loadTracesBySessionId, loadEvaluationsByTraceIds, loadTracesByFilter } from '../data-loader.js';
import { ERR_INVALID_SESSION_ID } from '../../lib/query-schemas.js';
import { HOOK_NAME, jsonSafe } from '../api-constants.js';
import { buildWorkflowGraph } from '../../lib/workflow-graph.js';
import { sessionAgentMap, sessionStepScores } from '../session-detail.js';
import { WidePeriodQuery, createRouter, requireId, validQuery } from '../route-errors.js';
import { agentStatsWindow, computeAgentStats } from '../aggregates/agent-stats.js';
import { HOOK_ATTRIBUTES } from '../../lib/hook-attributes.js';

const LIMIT_AGENT_SPANS = 1000;

export const agentRoutes = createRouter();

/**
 * GET /api/agents
 * Dev-server route: a live query projected by `computeAgentStats`. Production
 * serves the `meta:agents:<period>` KV key the sync writes from the same function.
 */
agentRoutes.get('/agents', validQuery(WidePeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  const now = new Date();
  const { windowStart, startDate, endDate } = agentStatsWindow(period, now);

  // D1 holds canonical attribute keys only (migrations 0018, 0019, 0025), so a
  // single canonical-key query covers every row era.
  //
  // queryTraces types startDate/endDate as `string | bigint` but validates the
  // string arm as a full ISO *datetime*: a date-only 'YYYY-MM-DD' type-checks
  // and then fails Zod at runtime. Pass the datetimes; the date-only values
  // stay for the evaluations read.
  const agentSpans = await loadTracesByFilter(
    { [HOOK_ATTRIBUTES.NAME]: HOOK_NAME.AGENT_FINALIZE },
    windowStart.toISOString(),
    now.toISOString(),
    LIMIT_AGENT_SPANS,
  );

  const traceIds = [...new Set(agentSpans.flatMap(span => (span.traceId ? [span.traceId] : [])))];
  const evaluations = await loadEvaluationsByTraceIds(traceIds, startDate, endDate);

  return c.json(computeAgentStats(agentSpans, evaluations, period, now));
});

type SessionSpans = Awaited<ReturnType<typeof loadTracesBySessionId>>;

type SessionSpanIndex = { agentMap: Map<number, string>; traceIds: Set<string> };

type SessionWorkflow = { evaluation: MultiAgentEvaluation; graph: WorkflowGraph };

/** Maps each span index to its agent name, and collects the session's trace ids. */
function indexSessionSpans(spans: SessionSpans): SessionSpanIndex {
  const traceIds = new Set<string>();
  for (const span of spans) {
    if (span.traceId) traceIds.add(span.traceId);
  }
  return { agentMap: sessionAgentMap(spans), traceIds };
}

/**
 * The session's multi-agent evaluation, and the workflow graph built from it. Step scores
 * come from the session detail's rules, so this graph matches the one the KV sync precomputes.
 */
function deriveSessionWorkflow(spans: SessionSpans, agentMap: Map<number, string>): SessionWorkflow {
  const evaluation = computeMultiAgentEvaluation(sessionStepScores(spans), agentMap);
  return { evaluation, graph: buildWorkflowGraph(evaluation, spans) };
}

/**
 * GET /api/agents/:sessionId
 * Loads spans for a session, builds agentMap, computes multi-agent evaluation.
 */
agentRoutes.get('/agents/:sessionId', requireId('sessionId', ERR_INVALID_SESSION_ID), async (c) => {
  const sessionId = c.req.param('sessionId');

  const spans = await loadTracesBySessionId(sessionId);
  const { agentMap, traceIds } = indexSessionSpans(spans);

  const evalPromise = loadEvaluationsByTraceIds([...traceIds]);
  const { evaluation, graph } = deriveSessionWorkflow(spans, agentMap);
  const evaluations = await evalPromise;

  return c.json(jsonSafe({
    sessionId,
    spans,
    evaluation,
    evaluations,
    agentMap: Object.fromEntries(agentMap),
    graph,
  }));
});

/**
 * GET /api/agents/:sessionId/graph
 * The workflow view's payload: the graph, and the evaluation its timeline tab
 * reads. Skips the evaluations lookup and omits spans and agentMap.
 */
agentRoutes.get('/agents/:sessionId/graph', requireId('sessionId', ERR_INVALID_SESSION_ID), async (c) => {
  const sessionId = c.req.param('sessionId');

  const spans = await loadTracesBySessionId(sessionId);
  const { evaluation, graph } = deriveSessionWorkflow(spans, indexSessionSpans(spans).agentMap);
  return c.json(jsonSafe({ sessionId, evaluation, graph }));
});
