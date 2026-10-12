import { Hono } from 'hono';
import { z } from 'zod';
import { getQualityMetric } from '../parent/quality-metrics.js';
import { loadEvaluationsForMetric } from '../data-loader.js';
import { PeriodSchema, PERIOD_MS, ErrorMessage, HttpStatus, DEFAULT_TREND_BUCKETS } from '../../lib/constants.js';
import { PARAM_METRIC_NAME_RE, isValidParam } from '../api-constants.js';
import { validQuery, handleRouteError } from '../route-errors.js';
import { computeTrend } from '../aggregates/trend.js';

const BucketsSchema = z.coerce.number().int().min(3).max(30).default(DEFAULT_TREND_BUCKETS);

export const trendRoutes = new Hono();
trendRoutes.onError(handleRouteError);

const TrendQuery = z.object({ period: PeriodSchema, buckets: BucketsSchema });

trendRoutes.get('/trends/:name', validQuery(TrendQuery), async (c) => {
  const name = c.req.param('name');
  if (!isValidParam(name, PARAM_METRIC_NAME_RE)) {
    return c.json({ error: ErrorMessage.InvalidMetricNameFormat }, HttpStatus.BadRequest);
  }
  const config = getQualityMetric(name);
  if (!config) {
    return c.json({ error: `Unknown metric: ${name}` }, HttpStatus.NotFound);
  }

  const { period, buckets: bucketCount } = c.req.valid('query');

  const now = new Date();
  const periodStart = new Date(now.getTime() - PERIOD_MS[period]);

  const evaluations = await loadEvaluationsForMetric(name, periodStart.toISOString(), now.toISOString());

  return c.json(computeTrend(name, evaluations, config, { period, bucketCount, now }).view);
});
