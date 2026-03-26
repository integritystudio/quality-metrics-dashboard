import { Hono } from 'hono';
import { z } from 'zod';
import {
  computeMetricDetail,
  computeAggregations,
  getQualityMetric,
  QUALITY_METRICS,
  type MetricTrend,
} from '../../../../dist/lib/quality/quality-metrics.js';
import {
  computePercentileDistribution,
  computeMetricDynamics,
} from '../../../../dist/lib/quality/quality-feature-engineering.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import { loadEvaluationsForMetric } from '../data-loader.js';
import { PeriodSchema, PERIOD_MS, ErrorMessage, HttpStatus, computePeriodDates, TIME_MS } from '../../lib/constants.js';
import { CONCENTRATION_THRESHOLD, SCORE_ROUND_FACTOR, extractFiniteScores } from '../api-constants.js';

/** Fraction of data span added as padding on each side when auto-narrowing the time axis. */
const TREND_PADDING_RATIO = 0.1;
/** Minimum padding in ms when auto-narrowing (ensures at least 1 minute of context). */
const TREND_PADDING_MIN_MS = 60_000;

const BucketsSchema = z.coerce.number().int().min(3).max(30).default(7);

export const trendRoutes = new Hono();

/**
 * GET /api/trends/:name
 * Returns time-bucketed trend data with percentile distributions and metric dynamics.
 *
 * Query params:
 *   period: '24h' | '7d' | '30d' (default: '7d')
 *   buckets: number 3-30 (default: 7) — how many time buckets to divide the period into
 */
trendRoutes.get('/trends/:name', async (c) => {
  const name = c.req.param('name');
  const config = getQualityMetric(name);
  if (!config) {
    return c.json({ error: `Unknown metric: ${name}` }, HttpStatus.NotFound);
  }

  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
  }
  const bucketsResult = BucketsSchema.safeParse(c.req.query('buckets'));
  if (!bucketsResult.success) {
    return c.json({ error: 'Invalid buckets. Must be integer 3-30.' }, HttpStatus.BadRequest);
  }

  try {
    const now = new Date();
    const period = periodResult.data;
    const bucketCount = bucketsResult.data;
    const periodMs = PERIOD_MS[period] ?? PERIOD_MS['7d'];
    const periodStart = new Date(now.getTime() - periodMs);

    const evaluations = await loadEvaluationsForMetric(name, periodStart.toISOString(), now.toISOString());

    const validTs = evaluations
      .map(ev => ({ ev, ts: new Date(ev.timestamp).getTime() }))
      .filter(({ ts }) => Number.isFinite(ts));

    const { dataMin, dataMax } = validTs.length > 0
      ? validTs.reduce(
          (acc, { ts }) => ({ dataMin: Math.min(acc.dataMin, ts), dataMax: Math.max(acc.dataMax, ts) }),
          { dataMin: validTs[0].ts, dataMax: validTs[0].ts },
        )
      : { dataMin: periodStart.getTime(), dataMax: now.getTime() };
    const dataSpan = dataMax - dataMin;
    const narrowed = validTs.length > 1 && dataSpan < periodMs * CONCENTRATION_THRESHOLD;
    const pad = narrowed ? Math.max(dataSpan * TREND_PADDING_RATIO, TREND_PADDING_MIN_MS) : 0;
    const start = narrowed ? new Date(dataMin - pad) : periodStart;
    const end = narrowed ? new Date(dataMax + pad) : now;
    const rangeMs = end.getTime() - start.getTime();
    const bucketMs = rangeMs / bucketCount;

    // single pass — avoids O(n*buckets) re-filter later
    type BucketEntry = { startTime: string; endTime: string; scores: number[]; evals: typeof evaluations };
    const buckets: BucketEntry[] = [];

    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = new Date(start.getTime() + i * bucketMs);
      const bucketEnd = new Date(start.getTime() + (i + 1) * bucketMs);
      buckets.push({
        startTime: bucketStart.toISOString(),
        endTime: bucketEnd.toISOString(),
        scores: [],
        evals: [],
      });
    }

    for (const { ev, ts } of validTs) {
      const bucketIdx = Math.min(
        Math.floor((ts - start.getTime()) / bucketMs),
        bucketCount - 1,
      );
      if (bucketIdx >= 0) {
        buckets[bucketIdx].evals.push(ev);
        if (ev.scoreValue != null && Number.isFinite(ev.scoreValue)) {
          buckets[bucketIdx].scores.push(ev.scoreValue);
        }
      }
    }

    const periodHours = rangeMs / (bucketCount * TIME_MS.HOUR);
    let previousTrend: MetricTrend | undefined;

    const trendData = buckets.map((bucket, idx) => {
      const scores = bucket.scores;
      const percentiles = computePercentileDistribution(scores);
      const avg = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
      const count = scores.length;

      const previousValues = (idx > 0 && buckets[idx - 1].scores.length > 0)
        ? computeAggregations(buckets[idx - 1].scores, config.aggregations)
        : undefined;

      const detail = bucket.evals.length > 0
        ? computeMetricDetail(bucket.evals, config, { topN: 0, bucketCount: 0, previousValues })
        : undefined;

      const dynamics = detail?.trend
        ? computeMetricDynamics(detail.trend, previousTrend, periodHours)
        : undefined;
      if (detail?.trend) previousTrend = detail.trend;

      return {
        startTime: bucket.startTime,
        endTime: bucket.endTime,
        count,
        avg: avg != null ? Math.round(avg * SCORE_ROUND_FACTOR) / SCORE_ROUND_FACTOR : null,
        percentiles,
        trend: detail?.trend ?? null,
        dynamics: dynamics ?? null,
      };
    });

    const allScores = extractFiniteScores(evaluations);
    const overallPercentiles = computePercentileDistribution(allScores);

    return c.json({
      metric: name,
      period,
      bucketCount,
      totalEvaluations: allScores.length,
      overallPercentiles,
      trendData,
      narrowed,
    });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});

/**
 * GET /api/trends
 * Returns trend summary for all metrics (latest percentiles + count).
 */
trendRoutes.get('/trends', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
  }

  try {
    const period = periodResult.data;
    const { start, end } = computePeriodDates(period);

    const metricNames = Object.keys(QUALITY_METRICS);
    const summaries = await Promise.all(
      metricNames.map(async (name: string) => {
        const evals = await loadEvaluationsForMetric(name, start, end);
        const scores = extractFiniteScores(evals);
        return {
          metric: name,
          count: scores.length,
          percentiles: computePercentileDistribution(scores) ?? null,
        };
      }),
    );

    return c.json({ period, metrics: summaries });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
