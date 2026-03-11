import { Hono } from 'hono';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { HttpStatus } from '../../lib/constants.js';
import { PARAM_ID_RE } from '../api-constants.js';
import { loadTracesByTraceId, loadEvaluationsByTraceId } from '../data-loader.js';

export const traceRoutes = new Hono();

/**
 * GET /api/traces/:traceId
 * Returns spans + evaluations for a trace.
 */
traceRoutes.get('/traces/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  if (!traceId || !PARAM_ID_RE.test(traceId)) {
    return c.json({ error: 'Invalid traceId format' }, HttpStatus.BadRequest);
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
