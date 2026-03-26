import { Hono } from 'hono';
import { z } from 'zod';
import { subMilliseconds } from 'date-fns';
import {
  computeMetricDetail,
  computeAggregations,
  getQualityMetric,
} from '../../../../dist/lib/quality/quality-metrics.js';
import { computeMetricDynamics } from '../../../../dist/lib/quality/quality-feature-engineering.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { loadEvaluationsForMetric } from '../data-loader.js';
import { PARAM_METRIC_NAME_RE, extractFiniteScores, isValidParam } from '../api-constants.js';
import { PeriodSchema, PERIOD_MS, SortBySchema, ErrorMessage, HttpStatus } from '../../lib/constants.js';

const DYNAMICS_PERIOD_HOURS_24H = 1;
const DYNAMICS_PERIOD_HOURS_MULTI_DAY = 24;

const TopNSchema = z.coerce.number().int().min(1).max(50).default(5);
const BucketCountSchema = z.coerce.number().int().min(2).max(20).default(10);
const LimitSchema = z.coerce.number().int().min(1).max(200).default(50);
const OffsetSchema = z.coerce.number().int().min(0).default(0);
const ScoreLabelSchema = z.string().max(100).optional();

export const metricsRoutes = new Hono();

metricsRoutes.get('/metrics/:name', async (c) => {
  const name = c.req.param('name');
  if (!isValidParam(name, PARAM_METRIC_NAME_RE)) {
    return c.json({ error: ErrorMessage.InvalidMetricNameFormat }, HttpStatus.BadRequest);
  }
  const config = getQualityMetric(name);
  if (!config) {
    return c.json({ error: `Unknown metric: ${name}` }, HttpStatus.NotFound);
  }

  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
  }
  const topNResult = TopNSchema.safeParse(c.req.query('topN'));
  if (!topNResult.success) {
    return c.json({ error: ErrorMessage.InvalidTopN }, HttpStatus.BadRequest);
  }
  const bucketResult = BucketCountSchema.safeParse(c.req.query('bucketCount'));
  if (!bucketResult.success) {
    return c.json({ error: ErrorMessage.InvalidBucketCount }, HttpStatus.BadRequest);
  }

  try {
    const now = new Date();
    const periodMs = PERIOD_MS[periodResult.data] ?? PERIOD_MS['7d'];
    const start = subMilliseconds(now, periodMs);
    const prevStart = subMilliseconds(start, periodMs);

    const [evaluations, prevEvaluations] = await Promise.all([
      loadEvaluationsForMetric(name, start.toISOString(), now.toISOString()),
      loadEvaluationsForMetric(name, prevStart.toISOString(), start.toISOString()),
    ]);

    const previousValues = prevEvaluations.length > 0
      ? computeAggregations(extractFiniteScores(prevEvaluations), config.aggregations)
      : undefined;

    const detail = computeMetricDetail(evaluations, config, {
      topN: topNResult.data,
      bucketCount: bucketResult.data,
      previousValues,
    });

    const dynamics = detail.trend
      ? computeMetricDynamics(detail.trend, undefined, periodResult.data === '24h' ? DYNAMICS_PERIOD_HOURS_24H : DYNAMICS_PERIOD_HOURS_MULTI_DAY)
      : undefined;

    return c.json({ ...detail, dynamics });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
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

  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
  }
  const limitResult = LimitSchema.safeParse(c.req.query('limit'));
  if (!limitResult.success) {
    return c.json({ error: ErrorMessage.InvalidLimit }, HttpStatus.BadRequest);
  }
  const offsetResult = OffsetSchema.safeParse(c.req.query('offset'));
  if (!offsetResult.success) {
    return c.json({ error: ErrorMessage.InvalidOffset }, HttpStatus.BadRequest);
  }
  const sortByResult = SortBySchema.safeParse(c.req.query('sortBy'));
  if (!sortByResult.success) {
    return c.json({ error: ErrorMessage.InvalidSortBy }, HttpStatus.BadRequest);
  }
  const scoreLabelResult = ScoreLabelSchema.safeParse(c.req.query('scoreLabel') || undefined);
  if (!scoreLabelResult.success) {
    return c.json({ error: ErrorMessage.InvalidScoreLabel }, HttpStatus.BadRequest);
  }
  const scoreLabel = scoreLabelResult.data;

  try {
    const now = new Date();
    const periodMs = PERIOD_MS[periodResult.data] ?? PERIOD_MS['7d'];
    const start = subMilliseconds(now, periodMs);

    const allEvaluations = await loadEvaluationsForMetric(name, start.toISOString(), now.toISOString());
    const sortBy = sortByResult.data;
    const evaluations = (scoreLabel ? allEvaluations.filter(e => e.scoreLabel === scoreLabel) : allEvaluations)
      .slice().sort((a, b) => {
      if (sortBy === 'score_asc' || sortBy === 'score_desc') {
        const aVal = a.scoreValue ?? null;
        const bVal = b.scoreValue ?? null;
        if (aVal === null && bVal === null) return 0;
        if (aVal === null) return 1;
        if (bVal === null) return -1;
        return sortBy === 'score_asc' ? aVal - bVal : bVal - aVal;
      }
      return b.timestamp.localeCompare(a.timestamp);
    });

    const total = evaluations.length;
    const limit = limitResult.data;
    const offset = offsetResult.data;
    const page = evaluations.slice(offset, offset + limit);

    const rows = page.map(e => ({
      score: e.scoreValue ?? 0,
      explanation: e.explanation,
      traceId: e.traceId,
      timestamp: e.timestamp,
      evaluator: e.evaluator,
      label: e.scoreLabel,
      evaluatorType: e.evaluatorType,
      spanId: e.spanId,
      sessionId: e.sessionId,
      agentName: e.agentName,
      trajectoryLength: e.trajectoryLength,
      stepScores: e.stepScores,
      toolVerifications: e.toolVerifications,
    }));

    return c.json({ rows, total, limit, offset, hasMore: offset + limit < total });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
