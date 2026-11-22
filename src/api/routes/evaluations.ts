import { ERR_INVALID_TRACE_ID } from '../../lib/query-schemas.js';
import { jsonSafe } from '../api-constants.js';
import { loadEvaluationsByTraceId } from '../data-loader.js';
import { createRouter, requireId } from '../route-errors.js';

export const evaluationRoutes = createRouter();

evaluationRoutes.get('/evaluations/trace/:traceId', requireId('traceId', ERR_INVALID_TRACE_ID), async (c) => {
  const traceId = c.req.param('traceId');

  const evaluations = await loadEvaluationsByTraceId(traceId);
  return c.json(jsonSafe({ evaluations }));
});
