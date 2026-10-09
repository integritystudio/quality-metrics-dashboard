import { Hono } from 'hono';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, ErrorMessage, computePeriodDates } from '../../lib/constants.js';
import { parseParam, handleRouteError } from '../route-errors.js';
import { computePipeline } from '../aggregates/pipeline.js';

export const pipelineRoutes = new Hono();
pipelineRoutes.onError(handleRouteError);

/**
 * GET /api/pipeline
 * Returns pipeline funnel: 4-stage evaluation flow with drop-off metrics.
 *
 * Query params:
 *   period: '24h' | '7d' | '30d' (default: '7d')
 */
pipelineRoutes.get('/pipeline', async (c) => {
  const period = parseParam(PeriodSchema, c.req.query('period'), ErrorMessage.InvalidPeriod);

  const { start, end } = computePeriodDates(period);

  const evaluationsByMetric = await loadEvaluationsByMetric(start, end);
  const pipeline = computePipeline(evaluationsByMetric);

  return c.json({ period, ...pipeline });
});
