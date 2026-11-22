import { Hono } from 'hono';
import { ERR_INVALID_TRACE_ID, ID_PATTERN } from '../../lib/query-schemas.js';
import { isValidParam, jsonSafe } from '../api-constants.js';
import { loadTracesByTraceId, loadEvaluationsByTraceId } from '../data-loader.js';
import { handleRouteError } from '../route-errors.js';
import { HttpStatus } from '../../lib/http-constants.js';

export const traceRoutes = new Hono();
traceRoutes.onError(handleRouteError);

/**
 * GET /api/traces/:traceId
 * Returns spans + evaluations for a trace.
 */
traceRoutes.get('/traces/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  if (!isValidParam(traceId, ID_PATTERN)) {
    return c.json({ error: ERR_INVALID_TRACE_ID }, HttpStatus.BadRequest);
  }

  const [spans, evaluations] = await Promise.all([
    loadTracesByTraceId(traceId),
    loadEvaluationsByTraceId(traceId),
  ]);

  return c.json(jsonSafe({ traceId, spans, evaluations }));
});
