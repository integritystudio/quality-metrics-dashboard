import { Hono } from 'hono';
import { z } from 'zod';
import { subMilliseconds } from 'date-fns';
import { getQualityMetric } from '../parent/quality-metrics.js';
import { resolveScoreLabel } from '../parent/qfe-label-ordinals.js';
import { loadEvaluationsForMetric } from '../data-loader.js';
import { PARAM_METRIC_NAME_RE, isValidParam, jsonSafe } from '../api-constants.js';
import { PeriodSchema, PERIOD_MS, SortBySchema, ErrorMessage, HttpStatus, type Period } from '../../lib/constants.js';
import { parseParam, handleRouteError } from '../route-errors.js';
import { projectEvaluationRow } from '../aggregates/evaluation-rows.js';
import { computeMetricDetailView, previousWindow } from '../aggregates/metric-detail.js';

const TopNSchema = z.coerce.number().int().min(1).max(50).default(5);
const BucketCountSchema = z.coerce.number().int().min(2).max(20).default(10);
const LimitSchema = z.coerce.number().int().min(1).max(200).default(50);
const OffsetSchema = z.coerce.number().int().min(0).default(0);
const ScoreLabelSchema = z.string().max(100).optional();

export const metricsRoutes = new Hono();
metricsRoutes.onError(handleRouteError);

metricsRoutes.get('/metrics/:name', async (c) => {
  const name = c.req.param('name');
  if (!isValidParam(name, PARAM_METRIC_NAME_RE)) {
    return c.json({ error: ErrorMessage.InvalidMetricNameFormat }, HttpStatus.BadRequest);
  }
  const config = getQualityMetric(name);
  if (!config) {
    return c.json({ error: `Unknown metric: ${name}` }, HttpStatus.NotFound);
  }

  const period = parseParam(PeriodSchema, c.req.query('period'), ErrorMessage.InvalidPeriod) as Period;
  const topN = parseParam(TopNSchema, c.req.query('topN'), ErrorMessage.InvalidTopN);
  const bucketCount = parseParam(BucketCountSchema, c.req.query('bucketCount'), ErrorMessage.InvalidBucketCount);

  const now = new Date();
  const start = subMilliseconds(now, PERIOD_MS[period]);
  const previous = previousWindow(period, now);

  const [evaluations, prevEvaluations] = await Promise.all([
    loadEvaluationsForMetric(name, start.toISOString(), now.toISOString()),
    loadEvaluationsForMetric(name, previous.start.toISOString(), previous.end.toISOString()),
  ]);

  return c.json(jsonSafe(computeMetricDetailView(evaluations, prevEvaluations, config, { period, topN, bucketCount })));
});

metricsRoutes.get('/metrics/:name/evaluations', async (c) => {
  const name = c.req.param('name');
  if (!isValidParam(name, PARAM_METRIC_NAME_RE)) {
    return c.json({ error: ErrorMessage.InvalidMetricNameFormat }, HttpStatus.BadRequest);
  }
  const config = getQualityMetric(name);
  if (!config) {
    return c.json({ error: `Unknown metric: ${name}` }, HttpStatus.NotFound);
  }

  const period = parseParam(PeriodSchema, c.req.query('period'), ErrorMessage.InvalidPeriod);
  const limit = parseParam(LimitSchema, c.req.query('limit'), ErrorMessage.InvalidLimit);
  const offset = parseParam(OffsetSchema, c.req.query('offset'), ErrorMessage.InvalidOffset);
  const sortBy = parseParam(SortBySchema, c.req.query('sortBy'), ErrorMessage.InvalidSortBy);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must map to undefined for optional schema
  const scoreLabel = parseParam(ScoreLabelSchema, c.req.query('scoreLabel') || undefined, ErrorMessage.InvalidScoreLabel);

  const now = new Date();
  const periodMs = PERIOD_MS[period as Period];
  const start = subMilliseconds(now, periodMs);

  const allEvaluations = await loadEvaluationsForMetric(name, start.toISOString(), now.toISOString());
  const evaluations = (scoreLabel ? allEvaluations.filter(e => resolveScoreLabel(e) === scoreLabel) : allEvaluations)
    .slice().sort((a, b) => {
    if (sortBy === 'score_asc' || sortBy === 'score_desc') {
      const aVal = a.scoreValue ?? null;
      const bVal = b.scoreValue ?? null;
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;
      return sortBy === 'score_asc' ? aVal - bVal : bVal - aVal;
    }
    return a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0;
  });

  const total = evaluations.length;
  const page = evaluations.slice(offset, offset + limit);

  const rows = page.map(projectEvaluationRow);

  return c.json(jsonSafe({ rows, total, limit, offset, hasMore: offset + limit < total }));
});
