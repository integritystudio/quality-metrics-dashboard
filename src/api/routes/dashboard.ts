import { Hono } from 'hono';
import { z } from 'zod';
import {
  computeDashboardSummary,
  computeRoleView,
  QUALITY_METRICS,
} from '../../../../dist/lib/quality-metrics.js';
import type { RoleViewType } from '../../../../dist/lib/quality-metrics.js';
import { computeCQI } from '../../../../dist/lib/quality-feature-engineering.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsByMetric, checkHealth } from '../data-loader.js';

const PeriodSchema = z.enum(['24h', '7d', '30d']).default('7d');
const RoleSchema = z.enum(['executive', 'operator', 'auditor']).optional();

function computePeriodDates(period: string): { start: string; end: string } {
  const now = new Date();
  const ms: Record<string, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  const start = new Date(now.getTime() - (ms[period] ?? ms['7d']));
  return { start: start.toISOString(), end: now.toISOString() };
}

export const dashboardRoutes = new Hono();

dashboardRoutes.get('/dashboard', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const roleResult = RoleSchema.safeParse(c.req.query('role') || undefined);
  if (!roleResult.success) {
    return c.json({ error: 'Invalid role. Must be executive, operator, or auditor.' }, 400);
  }

  try {
    const period = periodResult.data;
    const role = roleResult.data;
    const dates = computePeriodDates(period);
    const evaluationsByMetric = await loadEvaluationsByMetric(dates.start, dates.end);
    const dashboard = computeDashboardSummary(evaluationsByMetric, undefined, dates);
    const cqi = computeCQI(dashboard.metrics);

    if (role) {
      const view = computeRoleView(dashboard, role as RoleViewType);
      if (role === 'executive') {
        return c.json({ ...view, cqi });
      }
      return c.json(view);
    }

    return c.json({ ...dashboard, cqi });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});

dashboardRoutes.get('/health', async (c) => {
  try {
    const result = await checkHealth();
    return c.json(result);
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
