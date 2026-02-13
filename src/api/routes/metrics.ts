import { Hono } from 'hono';
import { z } from 'zod';
import {
  computeMetricDetail,
  getQualityMetric,
} from '../../../../dist/lib/quality-metrics.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsForMetric } from '../data-loader.js';

const TopNSchema = z.coerce.number().int().min(1).max(50).default(5);
const BucketCountSchema = z.coerce.number().int().min(2).max(20).default(10);

export const metricsRoutes = new Hono();

metricsRoutes.get('/metrics/:name', async (c) => {
  const name = c.req.param('name');
  const config = getQualityMetric(name);
  if (!config) {
    return c.json({ error: `Unknown metric: ${name}` }, 404);
  }

  const topNResult = TopNSchema.safeParse(c.req.query('topN'));
  if (!topNResult.success) {
    return c.json({ error: 'Invalid topN parameter.' }, 400);
  }
  const bucketResult = BucketCountSchema.safeParse(c.req.query('bucketCount'));
  if (!bucketResult.success) {
    return c.json({ error: 'Invalid bucketCount parameter (2-20).' }, 400);
  }

  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const evaluations = await loadEvaluationsForMetric(
      name,
      weekAgo.toISOString(),
      now.toISOString()
    );

    const detail = computeMetricDetail(evaluations, config, {
      topN: topNResult.data,
      bucketCount: bucketResult.data,
    });

    return c.json(detail);
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
