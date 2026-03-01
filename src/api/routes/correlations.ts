import { Hono } from 'hono';
import { computeCorrelationMatrix } from '../../../../dist/lib/quality-feature-engineering.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, PERIOD_MS } from '../../lib/constants.js';

export const correlationRoutes = new Hono();

correlationRoutes.get('/correlations', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }

  try {
    const now = new Date();
    const periodMs = PERIOD_MS[periodResult.data] ?? PERIOD_MS['30d'];
    const start = new Date(now.getTime() - periodMs);
    const evaluationsByMetric = await loadEvaluationsByMetric(start.toISOString(), now.toISOString());

    const metricTimeSeries = new Map<string, number[]>();
    const metricNames: string[] = [];
    for (const [name, evals] of evaluationsByMetric) {
      metricTimeSeries.set(name, evals.filter(e => e.scoreValue != null).map(e => e.scoreValue!));
      metricNames.push(name);
    }

    const correlations = computeCorrelationMatrix(metricTimeSeries);
    return c.json({ correlations, metrics: metricNames });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
