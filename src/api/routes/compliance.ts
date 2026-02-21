import { Hono } from 'hono';
import { z } from 'zod';
import { computeDashboardSummary } from '../../../../dist/lib/quality-metrics.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsByMetric, loadVerifications } from '../data-loader.js';

const PeriodSchema = z.enum(['24h', '7d', '30d']).default('7d');

const PERIOD_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const complianceRoutes = new Hono();

/**
 * GET /api/compliance/sla
 * Returns SLA compliance from the dashboard summary.
 */
complianceRoutes.get('/compliance/sla', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }

  try {
    const now = new Date();
    const period = periodResult.data;
    const periodMs = PERIOD_MS[period] ?? PERIOD_MS['7d'];
    const start = new Date(now.getTime() - periodMs);
    const dates = { start: start.toISOString(), end: now.toISOString() };

    const evaluationsByMetric = await loadEvaluationsByMetric(dates.start, dates.end);
    const summary = computeDashboardSummary(evaluationsByMetric, undefined, dates);

    return c.json({
      period,
      results: summary.slaCompliance ?? [],
      noSLAsConfigured: !summary.slaCompliance || summary.slaCompliance.length === 0,
    });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});

/**
 * GET /api/compliance/verifications
 * Returns human verification events for the given period.
 */
complianceRoutes.get('/compliance/verifications', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }

  try {
    const now = new Date();
    const period = periodResult.data;
    const periodMs = PERIOD_MS[period] ?? PERIOD_MS['7d'];
    const start = new Date(now.getTime() - periodMs);

    const verifications = await loadVerifications({
      startDate: start.toISOString(),
      endDate: now.toISOString(),
    });

    return c.json({ period, count: verifications.length, verifications });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
