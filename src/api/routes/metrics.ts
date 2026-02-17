import { Hono } from 'hono';
import { z } from 'zod';
import {
  computeMetricDetail,
  computeAggregations,
  getQualityMetric,
} from '../../../../dist/lib/quality-metrics.js';
import { computeMetricDynamics } from '../../../../dist/lib/quality-feature-engineering.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsForMetric } from '../data-loader.js';

const PeriodSchema = z.enum(['24h', '7d', '30d']).default('7d');
const TopNSchema = z.coerce.number().int().min(1).max(50).default(5);
const BucketCountSchema = z.coerce.number().int().min(2).max(20).default(10);

const PERIOD_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const metricsRoutes = new Hono();

metricsRoutes.get('/metrics/:name', async (c) => {
  const name = c.req.param('name');
  const config = getQualityMetric(name);
  if (!config) {
    return c.json({ error: `Unknown metric: ${name}` }, 404);
  }

  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const topNResult = TopNSchema.safeParse(c.req.query('topN'));
  if (!topNResult.success) {
    return c.json({ error: 'Invalid topN parameter. Must be integer 1-50.' }, 400);
  }
  const bucketResult = BucketCountSchema.safeParse(c.req.query('bucketCount'));
  if (!bucketResult.success) {
    return c.json({ error: 'Invalid bucketCount parameter. Must be integer 2-20.' }, 400);
  }

  try {
    const now = new Date();
    const periodMs = PERIOD_MS[periodResult.data] ?? PERIOD_MS['7d'];
    const start = new Date(now.getTime() - periodMs);
    const prevStart = new Date(start.getTime() - periodMs);

    const [evaluations, prevEvaluations] = await Promise.all([
      loadEvaluationsForMetric(name, start.toISOString(), now.toISOString()),
      loadEvaluationsForMetric(name, prevStart.toISOString(), start.toISOString()),
    ]);

    // Compute previous-period aggregations for trend calculation
    const previousValues = prevEvaluations.length > 0
      ? computeAggregations(
          prevEvaluations
            .map(e => e.scoreValue)
            .filter((v): v is number => v != null && Number.isFinite(v)),
          config.aggregations,
        )
      : undefined;

    const detail = computeMetricDetail(evaluations, config, {
      topN: topNResult.data,
      bucketCount: bucketResult.data,
      previousValues,
    });

    let dynamics = undefined;
    if (detail.trend) {
      dynamics = computeMetricDynamics(
        detail.trend,
        undefined,
        periodResult.data === '24h' ? 1 : 24,
      );
    }

    return c.json({ ...detail, dynamics });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
