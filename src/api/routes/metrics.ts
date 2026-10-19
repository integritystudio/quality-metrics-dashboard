import { Hono } from 'hono';
import { z } from 'zod';
import { subMilliseconds } from 'date-fns';
import { resolveScoreLabel } from '../parent/qfe-label-ordinals.js';
import { loadEvaluationsForMetric } from '../data-loader.js';
import { jsonSafe } from '../api-constants.js';
import { PeriodSchema, PERIOD_MS, SortBySchema, DEFAULT_TOP_N, MAX_TOP_N, DEFAULT_BUCKET_COUNT, MAX_BUCKET_COUNT, computePeriodDates } from '../../lib/constants.js';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../lib/worker-contract.js';
import { blankAsAbsent, validQuery, handleRouteError, resolveMetric } from '../route-errors.js';
import { projectEvaluationRow } from '../aggregates/evaluation-rows.js';
import { computeMetricDetailView, previousWindow } from '../aggregates/metric-detail.js';

const SCORE_LABEL_MAX_CHARS = 100;

const TopNSchema = z.coerce.number().int().min(1).max(MAX_TOP_N).default(DEFAULT_TOP_N);
const BucketCountSchema = z.coerce.number().int().min(2).max(MAX_BUCKET_COUNT).default(DEFAULT_BUCKET_COUNT);
const LimitSchema = z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT);
const OffsetSchema = z.coerce.number().int().min(0).default(0);
const ScoreLabelSchema = z.string().max(SCORE_LABEL_MAX_CHARS).optional();

const MetricDetailQuery = z.object({ period: PeriodSchema, topN: TopNSchema, bucketCount: BucketCountSchema });
const MetricEvaluationsQuery = z.object({
  period: PeriodSchema,
  limit: LimitSchema,
  offset: OffsetSchema,
  sortBy: SortBySchema,
  scoreLabel: blankAsAbsent(ScoreLabelSchema),
});

export const metricsRoutes = new Hono();
metricsRoutes.onError(handleRouteError);

metricsRoutes.get('/metrics/:name', validQuery(MetricDetailQuery), async (c) => {
  const metric = resolveMetric(c, c.req.param('name'));
  if (metric instanceof Response) return metric;
  const { name, config } = metric;

  const { period, topN, bucketCount } = c.req.valid('query');

  const now = new Date();
  const start = subMilliseconds(now, PERIOD_MS[period]);
  const previous = previousWindow(period, now);

  const [evaluations, prevEvaluations] = await Promise.all([
    loadEvaluationsForMetric(name, start.toISOString(), now.toISOString()),
    loadEvaluationsForMetric(name, previous.start.toISOString(), previous.end.toISOString()),
  ]);

  return c.json(jsonSafe(computeMetricDetailView(evaluations, prevEvaluations, config, { period, topN, bucketCount })));
});

metricsRoutes.get('/metrics/:name/evaluations', validQuery(MetricEvaluationsQuery), async (c) => {
  const metric = resolveMetric(c, c.req.param('name'));
  if (metric instanceof Response) return metric;
  const { name } = metric;

  const { period, limit, offset, sortBy, scoreLabel } = c.req.valid('query');

  const { start, end } = computePeriodDates(period);
  const allEvaluations = await loadEvaluationsForMetric(name, start, end);
  const evaluations = (scoreLabel ? allEvaluations.filter(e => resolveScoreLabel(e) === scoreLabel) : allEvaluations)
    .toSorted((a, b) => {
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

  const rows = page.map(e => projectEvaluationRow(e));

  return c.json(jsonSafe({ rows, total, limit, offset, hasMore: offset + limit < total }));
});
