import { Hono } from 'hono';
import { computeCorrelationMatrix } from '../../../../dist/lib/quality/quality-feature-engineering.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, ErrorMessage, HttpStatus, computePeriodDates } from '../../lib/constants.js';

export const correlationRoutes = new Hono();

correlationRoutes.get('/correlations', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
  }

  try {
    const { start, end } = computePeriodDates(periodResult.data);
    const evaluationsByMetric = await loadEvaluationsByMetric(start, end);

    const metricTimeSeries = new Map<string, number[]>();
    const metricNames: string[] = [];
    for (const [name, evals] of evaluationsByMetric) {
      metricTimeSeries.set(name, evals.filter(e => e.scoreValue != null).map(e => e.scoreValue!));
      metricNames.push(name);
    }

    const correlations = computeCorrelationMatrix(metricTimeSeries);
    return c.json({ correlations, metrics: metricNames });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
