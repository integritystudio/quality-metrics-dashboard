import { ERR_INVALID_TRACE_ID } from '../../lib/query-schemas.js';
import { jsonSafe } from '../api-constants.js';
import { loadTracesByTraceId, loadEvaluationsByTraceId } from '../data-loader.js';
import { createRouter, requireId } from '../route-errors.js';

export const traceRoutes = createRouter();

/**
 * GET /api/traces/:traceId
 * Returns spans + evaluations for a trace.
 */
traceRoutes.get('/traces/:traceId', requireId('traceId', ERR_INVALID_TRACE_ID), async (c) => {
  const traceId = c.req.param('traceId');

  const [spans, evaluations] = await Promise.all([
    loadTracesByTraceId(traceId),
    loadEvaluationsByTraceId(traceId),
  ]);

  return c.json(jsonSafe({ traceId, spans, evaluations }));
});
