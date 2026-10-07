import { Hono } from 'hono';
import { computePipelineView } from '../parent/quality-visualization.js';
import { computeDashboardSummary } from '../parent/quality-metrics.js';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, ErrorMessage, computePeriodDates } from '../../lib/constants.js';
import { parseParam, handleRouteError } from '../route-errors.js';

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

  const dashboard = computeDashboardSummary(evaluationsByMetric);
  const pipeline = computePipelineView(evaluationsByMetric, dashboard);

  return c.json({ period, ...pipeline });
});
