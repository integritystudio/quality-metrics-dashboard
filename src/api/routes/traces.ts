import { Hono } from 'hono';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { HttpStatus } from '../../lib/constants.js';
import { loadTracesByTraceId, loadEvaluationsByTraceId } from '../data-loader.js';

export const traceRoutes = new Hono();

/**
 * GET /api/traces/:traceId
 * Returns spans + evaluations for a trace.
 */
traceRoutes.get('/traces/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  if (!traceId) {
    return c.json({ error: 'traceId is required' }, HttpStatus.BadRequest);
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
