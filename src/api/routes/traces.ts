import { Hono } from 'hono';
import { HttpStatus, ErrorMessage } from '../../lib/constants.js';
import { PARAM_ID_RE, isValidParam, jsonSafe } from '../api-constants.js';
import { loadTracesByTraceId, loadEvaluationsByTraceId } from '../data-loader.js';
import { handleRouteError } from '../route-errors.js';

export const traceRoutes = new Hono();
traceRoutes.onError(handleRouteError);

/**
 * GET /api/traces/:traceId
 * Returns spans + evaluations for a trace.
 */
traceRoutes.get('/traces/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  if (!isValidParam(traceId, PARAM_ID_RE)) {
    return c.json({ error: ErrorMessage.InvalidTraceId }, HttpStatus.BadRequest);
  }

  const [spans, evaluations] = await Promise.all([
    loadTracesByTraceId(traceId),
    loadEvaluationsByTraceId(traceId),
  ]);

  return c.json(jsonSafe({ traceId, spans, evaluations }));
});
