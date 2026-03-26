import { Hono } from 'hono';
import {
  computePipelineView,
  computeDashboardSummary,
} from '../../../../dist/lib/quality/quality-metrics.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, ErrorMessage, HttpStatus, computePeriodDates } from '../../lib/constants.js';

export const pipelineRoutes = new Hono();

/**
 * GET /api/pipeline
 * Returns pipeline funnel: 4-stage evaluation flow with drop-off metrics.
 *
 * Query params:
 *   period: '24h' | '7d' | '30d' (default: '7d')
 */
pipelineRoutes.get('/pipeline', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
  }

  try {
    const period = periodResult.data;
    const { start, end } = computePeriodDates(period);

    const evaluationsByMetric = await loadEvaluationsByMetric(start, end);

    const dashboard = computeDashboardSummary(evaluationsByMetric);
    const pipeline = computePipelineView(evaluationsByMetric, dashboard);

    return c.json({ period, ...pipeline });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
