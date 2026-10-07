import { Hono } from 'hono';
import { computeCorrelationMatrix } from '../parent/qfe-correlation.js';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, ErrorMessage, computePeriodDates } from '../../lib/constants.js';
import { extractFiniteScores } from '../api-constants.js';
import { parseParam, handleRouteError } from '../route-errors.js';

export const correlationRoutes = new Hono();
correlationRoutes.onError(handleRouteError);

correlationRoutes.get('/correlations', async (c) => {
  const period = parseParam(PeriodSchema, c.req.query('period'), ErrorMessage.InvalidPeriod);

  const { start, end } = computePeriodDates(period);
  const evaluationsByMetric = await loadEvaluationsByMetric(start, end);

  const metricTimeSeries = new Map<string, number[]>();
  for (const [name, evals] of evaluationsByMetric) {
    metricTimeSeries.set(name, extractFiniteScores(evals));
  }

  const correlations = computeCorrelationMatrix(metricTimeSeries);
  return c.json({ correlations, metrics: [...metricTimeSeries.keys()] });
});
