import { Hono } from 'hono';
import { computeMultiAgentEvaluation } from '../../../../dist/lib/quality-multi-agent.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadTracesBySessionId, loadEvaluationsByTraceId } from '../data-loader.js';
import type { StepScore } from '../../../../dist/backends/index.js';

export const agentRoutes = new Hono();

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

    // Load evaluations from all traces in the session
    const evaluations = (
      await Promise.all([...traceIds].map(id => loadEvaluationsByTraceId(id)))
    ).flat();

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
