import { Hono } from 'hono';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { computePeriodDates } from '../../lib/constants.js';
import { PeriodQuery, validQuery, handleRouteError } from '../route-errors.js';
import { computeCorrelations } from '../aggregates/correlations.js';

export const correlationRoutes = new Hono();
correlationRoutes.onError(handleRouteError);

correlationRoutes.get('/correlations', validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');

  const { start, end } = computePeriodDates(period);
  const evaluationsByMetric = await loadEvaluationsByMetric(start, end);

  return c.json(computeCorrelations(evaluationsByMetric));
});
