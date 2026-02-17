import { Hono } from 'hono';
import { computeCorrelationMatrix } from '../../../../dist/lib/quality-feature-engineering.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsByMetric } from '../data-loader.js';

export const correlationRoutes = new Hono();

correlationRoutes.get('/correlations', async (c) => {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
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
