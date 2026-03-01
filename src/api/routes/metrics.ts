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
import { PeriodSchema, PERIOD_MS, SortBySchema, ErrorMessage, HttpStatus } from '../../lib/constants.js';

const TopNSchema = z.coerce.number().int().min(1).max(50).default(5);
const BucketCountSchema = z.coerce.number().int().min(2).max(20).default(10);
const LimitSchema = z.coerce.number().int().min(1).max(200).default(50);
const OffsetSchema = z.coerce.number().int().min(0).default(0);
const ScoreLabelSchema = z.string().max(100).optional();

export const metricsRoutes = new Hono();

metricsRoutes.get('/metrics/:name', async (c) => {
  const name = c.req.param('name');
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
    return c.json({ error: 'Invalid topN parameter. Must be integer 1-50.' }, HttpStatus.BadRequest);
  }
  const bucketResult = BucketCountSchema.safeParse(c.req.query('bucketCount'));
  if (!bucketResult.success) {
    return c.json({ error: 'Invalid bucketCount parameter. Must be integer 2-20.' }, HttpStatus.BadRequest);
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
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});

metricsRoutes.get('/metrics/:name/evaluations', async (c) => {
  const name = c.req.param('name');
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
    return c.json({ error: 'Invalid limit. Must be integer 1-200.' }, HttpStatus.BadRequest);
  }
  const offsetResult = OffsetSchema.safeParse(c.req.query('offset'));
  if (!offsetResult.success) {
    return c.json({ error: 'Invalid offset. Must be non-negative integer.' }, HttpStatus.BadRequest);
  }
  const sortByResult = SortBySchema.safeParse(c.req.query('sortBy'));
  if (!sortByResult.success) {
    return c.json({ error: 'Invalid sortBy. Must be score_asc, score_desc, or timestamp_desc.' }, HttpStatus.BadRequest);
  }
  const scoreLabelResult = ScoreLabelSchema.safeParse(c.req.query('scoreLabel') || undefined);
  if (!scoreLabelResult.success) {
    return c.json({ error: 'Invalid scoreLabel. Max 100 characters.' }, HttpStatus.BadRequest);
  }
  const scoreLabel = scoreLabelResult.data;

  try {
    const now = new Date();
    const periodMs = PERIOD_MS[periodResult.data] ?? PERIOD_MS['7d'];
    const start = new Date(now.getTime() - periodMs);

    let evaluations = await loadEvaluationsForMetric(name, start.toISOString(), now.toISOString());

    if (scoreLabel) {
      evaluations = evaluations.filter(e => e.scoreLabel === scoreLabel);
    }

    const sortBy = sortByResult.data;
    evaluations.sort((a, b) => {
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
