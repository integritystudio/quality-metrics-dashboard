import { Hono } from 'hono';
import { ERR_INVALID_TRACE_ID, ID_PATTERN } from '../../lib/query-schemas.js';
import { isValidParam, jsonSafe } from '../api-constants.js';
import { loadEvaluationsByTraceId } from '../data-loader.js';
import { handleRouteError } from '../route-errors.js';
import { HttpStatus } from '../../lib/http-constants.js';

export const evaluationRoutes = new Hono();
evaluationRoutes.onError(handleRouteError);

evaluationRoutes.get('/evaluations/trace/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  if (!isValidParam(traceId, ID_PATTERN)) {
    return c.json({ error: ERR_INVALID_TRACE_ID }, HttpStatus.BadRequest);
  }

  const evaluations = await loadEvaluationsByTraceId(traceId);
  return c.json(jsonSafe({ evaluations }));
});
