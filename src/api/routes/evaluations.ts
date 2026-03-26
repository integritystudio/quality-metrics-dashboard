import { Hono } from 'hono';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { HttpStatus, ErrorMessage } from '../../lib/constants.js';
import { PARAM_ID_RE, isValidParam } from '../api-constants.js';
import { loadEvaluationsByTraceId } from '../data-loader.js';

export const evaluationRoutes = new Hono();

evaluationRoutes.get('/evaluations/trace/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  if (!isValidParam(traceId, PARAM_ID_RE)) {
    return c.json({ error: ErrorMessage.InvalidTraceId }, HttpStatus.BadRequest);
  }

  try {
    const evaluations = await loadEvaluationsByTraceId(traceId);
    return c.json({ evaluations });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
