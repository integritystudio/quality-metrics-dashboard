import { Hono } from 'hono';
import { z } from 'zod';
import {
  computeDashboardSummary,
  computeRoleView,
  QUALITY_METRICS,
} from '../../../../dist/lib/quality-metrics.js';
import type { RoleViewType } from '../../../../dist/lib/quality-metrics.js';
import type { EvaluationResult } from '../../../../dist/backends/index.js';
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

/** Bucket evaluations into N time bins and return avg scores per bucket */
function computeSparklineData(
  evaluations: EvaluationResult[],
  startMs: number,
  endMs: number,
  buckets: number,
): (number | null)[] {
  const range = endMs - startMs;
  if (range <= 0 || evaluations.length === 0) return [];

  const bucketWidth = range / buckets;
  const sums = new Array(buckets).fill(0);
  const counts = new Array(buckets).fill(0);

  for (const ev of evaluations) {
    if (ev.scoreValue == null || !Number.isFinite(ev.scoreValue)) continue;
    const ts = new Date(ev.timestamp).getTime();
    const idx = Math.min(Math.floor((ts - startMs) / bucketWidth), buckets - 1);
    if (idx >= 0) {
      sums[idx] += ev.scoreValue;
      counts[idx]++;
    }
  }

  return sums.map((s, i) => counts[i] > 0 ? s / counts[i] : null);
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

    // Compute sparkline data (24 time buckets per metric)
    const startMs = new Date(dates.start).getTime();
    const endMs = new Date(dates.end).getTime();
    const sparklines: Record<string, (number | null)[]> = {};
    for (const [metricName, evals] of evaluationsByMetric) {
      sparklines[metricName] = computeSparklineData(evals, startMs, endMs, 24);
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
