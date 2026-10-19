import { Hono } from 'hono';
import { z } from 'zod';
import { loadEvaluationsForMetric } from '../data-loader.js';
import { PeriodSchema, PERIOD_MS, DEFAULT_TREND_BUCKETS, MIN_TREND_BUCKETS, MAX_TREND_BUCKETS } from '../../lib/constants.js';
import { validQuery, handleRouteError, resolveMetric } from '../route-errors.js';
import { computeTrend } from '../aggregates/trend.js';

const BucketsSchema = z.coerce.number().int().min(MIN_TREND_BUCKETS).max(MAX_TREND_BUCKETS).default(DEFAULT_TREND_BUCKETS);

export const trendRoutes = new Hono();
trendRoutes.onError(handleRouteError);

const TrendQuery = z.object({ period: PeriodSchema, buckets: BucketsSchema });

trendRoutes.get('/trends/:name', validQuery(TrendQuery), async (c) => {
  const metric = resolveMetric(c, c.req.param('name'));
  if (metric instanceof Response) return metric;
  const { name, config } = metric;

  const { period, buckets: bucketCount } = c.req.valid('query');

  const now = new Date();
  const periodStart = new Date(now.getTime() - PERIOD_MS[period]);

  const evaluations = await loadEvaluationsForMetric(name, periodStart.toISOString(), now.toISOString());

  return c.json(computeTrend(name, evaluations, config, { period, bucketCount, now }).view);
});
