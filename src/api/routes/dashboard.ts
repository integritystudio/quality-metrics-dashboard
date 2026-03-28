import { rollup, mean } from 'd3-array';
import { Hono } from 'hono';
import {
  computeDashboardSummary,
  computeRoleView,
  type RoleViewType,
} from '../../../../dist/lib/quality/quality-metrics.js';
import type { EvaluationResult } from '../../../../dist/backends/index.js';
import { computeCQI } from '../../../../dist/lib/quality/quality-feature-engineering.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { loadEvaluationsByMetric, checkHealth } from '../data-loader.js';
import { PeriodSchema, RoleSchema, ErrorMessage, HttpStatus, computePeriodDates } from '../../lib/constants.js';

const SPARKLINE_BUCKET_COUNT = 24;

function computeSparklineData(
  evaluations: EvaluationResult[],
  startMs: number,
  endMs: number,
  buckets: number,
): (number | null)[] {
  const range = endMs - startMs;
  if (range <= 0 || evaluations.length === 0) return [];

  const bucketWidth = range / buckets;
  const valid = evaluations.filter(ev => ev.scoreValue !== null && Number.isFinite(ev.scoreValue));
  const bucketMap = rollup(
    valid,
    evals => mean(evals, ev => ev.scoreValue as number) ?? null,
    ev => Math.min(Math.floor((new Date(ev.timestamp).getTime() - startMs) / bucketWidth), buckets - 1),
  );
  return Array.from({ length: buckets }, (_, i) => bucketMap.get(i) ?? null);
}

export const dashboardRoutes = new Hono();

dashboardRoutes.get('/dashboard', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
  }
  const roleResult = RoleSchema.optional().safeParse(c.req.query('role') || undefined);
  if (!roleResult.success) {
    return c.json({ error: ErrorMessage.InvalidRole }, HttpStatus.BadRequest);
  }

  try {
    const period = periodResult.data;
    const role = roleResult.data;
    const dates = computePeriodDates(period);
    const evaluationsByMetric = await loadEvaluationsByMetric(dates.start, dates.end);
    const dashboard = computeDashboardSummary(evaluationsByMetric, undefined, dates);
    const cqi = computeCQI(dashboard.metrics);

    const startMs = new Date(dates.start).getTime();
    const endMs = new Date(dates.end).getTime();
    const sparklines: Record<string, (number | null)[]> = {};
    for (const [metricName, evals] of evaluationsByMetric) {
      sparklines[metricName] = computeSparklineData(evals, startMs, endMs, SPARKLINE_BUCKET_COUNT);
    }

    if (role) {
      const view = computeRoleView(dashboard, role as RoleViewType);
      if (role === 'executive') {
        return c.json({ ...view, cqi, sparklines });
      }
      return c.json({ ...view, sparklines });
    }

    return c.json({ ...dashboard, cqi, sparklines });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});

dashboardRoutes.get('/health', async (c) => {
  try {
    const result = await checkHealth();
    return c.json(result);
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
