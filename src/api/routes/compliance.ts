import { Hono } from 'hono';
import { computeDashboardSummary } from '../parent/quality-metrics.js';
import { loadEvaluationsByMetric, loadVerifications } from '../data-loader.js';
import { computePeriodDates } from '../../lib/constants.js';
import { PeriodQuery, validQuery, handleRouteError } from '../route-errors.js';

export const complianceRoutes = new Hono();
complianceRoutes.onError(handleRouteError);

/**
 * GET /api/compliance/sla
 * Returns SLA compliance from the dashboard summary.
 */
complianceRoutes.get('/compliance/sla', validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');

  const dates = computePeriodDates(period);

  const evaluationsByMetric = await loadEvaluationsByMetric(dates.start, dates.end);
  const summary = computeDashboardSummary(evaluationsByMetric, { period: dates });

  return c.json({
    period,
    results: summary.slaCompliance ?? [],
    noSLAsConfigured: !summary.slaCompliance || summary.slaCompliance.length === 0,
  });
});

/**
 * GET /api/compliance/verifications
 * Returns human verification events for the given period.
 */
complianceRoutes.get('/compliance/verifications', validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');

  const { start, end } = computePeriodDates(period);

  const verifications = await loadVerifications({
    startDate: start,
    endDate: end,
  });

  return c.json({ period, count: verifications.length, verifications });
});
