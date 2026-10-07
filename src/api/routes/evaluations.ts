import { Hono } from 'hono';
import { HttpStatus, ErrorMessage } from '../../lib/constants.js';
import { PARAM_ID_RE, isValidParam, jsonSafe } from '../api-constants.js';
import { loadEvaluationsByTraceId } from '../data-loader.js';
import { handleRouteError } from '../route-errors.js';

export const evaluationRoutes = new Hono();
evaluationRoutes.onError(handleRouteError);

evaluationRoutes.get('/evaluations/trace/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  if (!isValidParam(traceId, PARAM_ID_RE)) {
    return c.json({ error: ErrorMessage.InvalidTraceId }, HttpStatus.BadRequest);
  }

  const evaluations = await loadEvaluationsByTraceId(traceId);
  return c.json(jsonSafe({ evaluations }));
});
