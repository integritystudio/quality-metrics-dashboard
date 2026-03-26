import { Hono } from 'hono';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { HttpStatus, ErrorMessage } from '../../lib/constants.js';
import { PARAM_ID_RE, isValidParam } from '../api-constants.js';
import { loadTracesByTraceId, loadEvaluationsByTraceId } from '../data-loader.js';

export const traceRoutes = new Hono();

/**
 * GET /api/traces/:traceId
 * Returns spans + evaluations for a trace.
 */
traceRoutes.get('/traces/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  if (!isValidParam(traceId, PARAM_ID_RE)) {
    return c.json({ error: ErrorMessage.InvalidTraceId }, HttpStatus.BadRequest);
  }

  try {
    const [spans, evaluations] = await Promise.all([
      loadTracesByTraceId(traceId),
      loadEvaluationsByTraceId(traceId),
    ]);

    return c.json({ traceId, spans, evaluations });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
