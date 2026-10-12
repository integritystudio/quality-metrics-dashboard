import { Hono } from 'hono';
import { loadEvaluationsByMetric, checkHealth } from '../data-loader.js';
import { z } from 'zod';
import { PeriodSchema, RoleSchema, computePeriodDates } from '../../lib/constants.js';
import { blankAsAbsent, validQuery, handleRouteError } from '../route-errors.js';
import { computeDashboardFull, computeDashboardRoleView } from '../aggregates/dashboard-summary.js';

export const dashboardRoutes = new Hono();
dashboardRoutes.onError(handleRouteError);

const DashboardQuery = z.object({ period: PeriodSchema, role: blankAsAbsent(RoleSchema.optional()) });

dashboardRoutes.get('/dashboard', validQuery(DashboardQuery), async (c) => {
  const { period, role } = c.req.valid('query');

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
