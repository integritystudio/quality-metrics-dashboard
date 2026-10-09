import { Hono } from 'hono';
import { loadEvaluationsByMetric, checkHealth } from '../data-loader.js';
import { PeriodSchema, RoleSchema, ErrorMessage, computePeriodDates } from '../../lib/constants.js';
import { parseParam, handleRouteError } from '../route-errors.js';
import { computeDashboardFull, computeDashboardRoleView } from '../aggregates/dashboard-summary.js';

export const dashboardRoutes = new Hono();
dashboardRoutes.onError(handleRouteError);

dashboardRoutes.get('/dashboard', async (c) => {
  const period = parseParam(PeriodSchema, c.req.query('period'), ErrorMessage.InvalidPeriod);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must map to undefined for optional schema
  const role = parseParam(RoleSchema.optional(), c.req.query('role') || undefined, ErrorMessage.InvalidRole);

  const dates = computePeriodDates(period);
  const evaluationsByMetric = await loadEvaluationsByMetric(dates.start, dates.end);

  if (role) {
    return c.json(computeDashboardRoleView(evaluationsByMetric, dates, role));
  }

  return c.json(computeDashboardFull(evaluationsByMetric, dates));
});

dashboardRoutes.get('/health', async (c) => {
  const result = await checkHealth();
  return c.json(result);
});
