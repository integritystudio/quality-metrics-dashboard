import { Hono } from 'hono';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, ErrorMessage, computePeriodDates } from '../../lib/constants.js';
import { parseParam, handleRouteError } from '../route-errors.js';
import { computeCorrelations } from '../aggregates/correlations.js';

export const correlationRoutes = new Hono();
correlationRoutes.onError(handleRouteError);

correlationRoutes.get('/correlations', async (c) => {
  const period = parseParam(PeriodSchema, c.req.query('period'), ErrorMessage.InvalidPeriod);

  const { start, end } = computePeriodDates(period);
  const evaluationsByMetric = await loadEvaluationsByMetric(start, end);

  return c.json(computeCorrelations(evaluationsByMetric));
});
