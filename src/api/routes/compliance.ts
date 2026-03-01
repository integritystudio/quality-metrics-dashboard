import { Hono } from 'hono';
import { computeDashboardSummary } from '../../../../dist/lib/quality-metrics.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsByMetric, loadVerifications } from '../data-loader.js';
import { PeriodSchema, PERIOD_MS, ErrorMessage, HttpStatus } from '../../lib/constants.js';

export const complianceRoutes = new Hono();

/**
 * GET /api/compliance/sla
 * Returns SLA compliance from the dashboard summary.
 */
complianceRoutes.get('/compliance/sla', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
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
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});

/**
 * GET /api/compliance/verifications
 * Returns human verification events for the given period.
 */
complianceRoutes.get('/compliance/verifications', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
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
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
