import { Hono } from 'hono';
import { computeMultiAgentEvaluation } from '../parent/quality-multi-agent.js';
import { loadTracesBySessionId, loadEvaluationsByTraceIds, loadTracesByFilter } from '../data-loader.js';
import { VALID_PERIODS, HttpStatus, ErrorMessage, type Period } from '../../lib/constants.js';
import { HOOK_NAME, PARAM_ID_RE, isValidParam, jsonSafe } from '../api-constants.js';
import { buildWorkflowGraph } from '../../lib/workflow-graph.js';
import { sessionAgentMap, sessionStepScores } from '../session-detail.js';
import { handleRouteError } from '../route-errors.js';
import { HOOK_NAME_ATTRIBUTE, agentStatsWindow, computeAgentStats } from '../aggregates/agent-stats.js';

const LIMIT_AGENT_SPANS = 1000;
const DEFAULT_AGENTS_PERIOD: Period = '30d';

export const agentRoutes = new Hono();
agentRoutes.onError(handleRouteError);

/**
 * GET /api/agents
 * Dev-server route: a live query projected by `computeAgentStats`. Production
 * serves the `meta:agents:<period>` KV key the sync writes from the same function.
 */
agentRoutes.get('/agents', async (c) => {
  const periodParam = c.req.query('period') ?? DEFAULT_AGENTS_PERIOD;
  if (VALID_PERIODS[periodParam] === undefined) {
    return c.json({ error: `Invalid period value. Must be one of: ${Object.keys(VALID_PERIODS).join(', ')}` }, HttpStatus.BadRequest);
  }
  const period = periodParam as Period;
  const now = new Date();
  const { windowStart, startDate, endDate } = agentStatsWindow(period, now);

  // OBP7b: CloudBackend canonicalizes attribute keys on read (legacy pre-cutover
  // D1 rows included) and applies non-sessionId attributeFilter entries
  // client-side, so a single canonical-key query covers every row era.
  //
  // queryTraces types startDate/endDate as `string | bigint` but validates the
  // string arm as a full ISO *datetime* — a date-only 'YYYY-MM-DD' type-checks
  // and then fails Zod at runtime, which made this route a guaranteed 500.
  // Pass the datetimes; the date-only values stay for the evaluations read.
  const agentSpans = await loadTracesByFilter(
    { [HOOK_NAME_ATTRIBUTE]: HOOK_NAME.AGENT_FINALIZE },
    windowStart.toISOString(),
    now.toISOString(),
    LIMIT_AGENT_SPANS,
  );

  const traceIds = [...new Set(agentSpans.flatMap(span => (span.traceId ? [span.traceId] : [])))];
  const evaluations = await loadEvaluationsByTraceIds(traceIds, startDate, endDate);

  return c.json(computeAgentStats(agentSpans, evaluations, period, now));
});

type SessionSpans = Awaited<ReturnType<typeof loadTracesBySessionId>>;

/** Maps each span index to its agent name, and collects the session's trace ids. */
function indexSessionSpans(spans: SessionSpans) {
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
function deriveSessionWorkflow(spans: SessionSpans, agentMap: Map<number, string>) {
  const evaluation = computeMultiAgentEvaluation(sessionStepScores(spans), agentMap);
  return { evaluation, graph: buildWorkflowGraph(evaluation, spans) };
}

/**
 * GET /api/agents/:sessionId
 * Loads spans for a session, builds agentMap, computes multi-agent evaluation.
 */
agentRoutes.get('/agents/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!isValidParam(sessionId, PARAM_ID_RE)) {
    return c.json({ error: ErrorMessage.InvalidSessionIdFormat }, HttpStatus.BadRequest);
  }

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
agentRoutes.get('/agents/:sessionId/graph', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!isValidParam(sessionId, PARAM_ID_RE)) {
    return c.json({ error: ErrorMessage.InvalidSessionIdFormat }, HttpStatus.BadRequest);
  }

  const spans = await loadTracesBySessionId(sessionId);
  const { evaluation, graph } = deriveSessionWorkflow(spans, indexSessionSpans(spans).agentMap);
  return c.json(jsonSafe({ sessionId, evaluation, graph }));
});
