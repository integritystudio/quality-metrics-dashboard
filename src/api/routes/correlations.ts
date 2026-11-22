import { loadEvaluationsByMetric } from '../data-loader.js';
import { computePeriodDates } from '../../lib/constants.js';
import { WidePeriodQuery, validQuery, createRouter } from '../route-errors.js';
import { computeCorrelations } from '../aggregates/correlations.js';

export const correlationRoutes = createRouter();

correlationRoutes.get('/correlations', validQuery(WidePeriodQuery), async (c) => {
  const { period } = c.req.valid('query');

  const { start, end } = computePeriodDates(period);
  const evaluationsByMetric = await loadEvaluationsByMetric(start, end);

  return c.json(computeCorrelations(evaluationsByMetric));
});
