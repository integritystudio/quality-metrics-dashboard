import { Hono } from 'hono';
import { z } from 'zod';
import {
  computeMetricDetail,
  computeAggregations,
  getQualityMetric,
  QUALITY_METRICS,
} from '../../../../dist/lib/quality-metrics.js';
import {
  computePercentileDistribution,
  computeMetricDynamics,
} from '../../../../dist/lib/quality-feature-engineering.js';
import type { MetricTrend } from '../../../../dist/lib/quality-metrics.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsForMetric } from '../data-loader.js';

const PeriodSchema = z.enum(['24h', '7d', '30d']).default('7d');
const BucketsSchema = z.coerce.number().int().min(3).max(30).default(7);

const PERIOD_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

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
    return c.json({ error: `Unknown metric: ${name}` }, 404);
  }

  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const bucketsResult = BucketsSchema.safeParse(c.req.query('buckets'));
  if (!bucketsResult.success) {
    return c.json({ error: 'Invalid buckets. Must be integer 3-30.' }, 400);
  }

  try {
    const now = new Date();
    const period = periodResult.data;
    const bucketCount = bucketsResult.data;
    const periodMs = PERIOD_MS[period] ?? PERIOD_MS['7d'];
    const periodStart = new Date(now.getTime() - periodMs);

    const evaluations = await loadEvaluationsForMetric(name, periodStart.toISOString(), now.toISOString());

    // Determine actual data range — auto-narrow if data is concentrated
    const timestamps = evaluations
      .map(e => new Date(e.timestamp).getTime())
      .filter(Number.isFinite);
    const dataMin = timestamps.length > 0 ? Math.min(...timestamps) : periodStart.getTime();
    const dataMax = timestamps.length > 0 ? Math.max(...timestamps) : now.getTime();
    const dataSpan = dataMax - dataMin;
    const CONCENTRATION_THRESHOLD = 0.2;
    const narrowed = timestamps.length > 1 && dataSpan < periodMs * CONCENTRATION_THRESHOLD;
    const pad = narrowed ? Math.max(dataSpan * 0.1, 60_000) : 0;
    const start = narrowed ? new Date(dataMin - pad) : periodStart;
    const end = narrowed ? new Date(dataMax + pad) : now;
    const rangeMs = end.getTime() - start.getTime();
    const bucketMs = rangeMs / bucketCount;

    // Group evaluations into time buckets
    const buckets: Array<{
      startTime: string;
      endTime: string;
      scores: number[];
    }> = [];

    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = new Date(start.getTime() + i * bucketMs);
      const bucketEnd = new Date(start.getTime() + (i + 1) * bucketMs);
      buckets.push({
        startTime: bucketStart.toISOString(),
        endTime: bucketEnd.toISOString(),
        scores: [],
      });
    }

    for (const ev of evaluations) {
      const ts = new Date(ev.timestamp).getTime();
      const bucketIdx = Math.min(
        Math.floor((ts - start.getTime()) / bucketMs),
        bucketCount - 1,
      );
      if (bucketIdx >= 0 && ev.scoreValue != null && Number.isFinite(ev.scoreValue)) {
        buckets[bucketIdx].scores.push(ev.scoreValue);
      }
    }

    // Compute per-bucket aggregations and trends
    const periodHours = rangeMs / (bucketCount * 3600000);
    let previousTrend: MetricTrend | undefined;

    const trendData = buckets.map((bucket, idx) => {
      const scores = bucket.scores;
      const percentiles = computePercentileDistribution(scores);
      const avg = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
      const count = scores.length;

      // Compute previous bucket aggregations for trend
      const previousValues = (idx > 0 && buckets[idx - 1].scores.length > 0)
        ? computeAggregations(buckets[idx - 1].scores, config.aggregations)
        : undefined;

      // Compute metric detail for trend
      const detail = scores.length > 0
        ? computeMetricDetail(
            evaluations.filter(e => {
              const ts = new Date(e.timestamp).getTime();
              const bStart = new Date(bucket.startTime).getTime();
              const bEnd = new Date(bucket.endTime).getTime();
              return ts >= bStart && ts < bEnd;
            }),
            config,
            { topN: 0, bucketCount: 0, previousValues },
          )
        : undefined;

      // Compute dynamics from current and previous trend
      let dynamics = undefined;
      if (detail?.trend) {
        dynamics = computeMetricDynamics(
          detail.trend,
          previousTrend,
          periodHours,
        );
        previousTrend = detail.trend;
      }

      return {
        startTime: bucket.startTime,
        endTime: bucket.endTime,
        count,
        avg: avg != null ? Math.round(avg * 10000) / 10000 : null,
        percentiles,
        trend: detail?.trend ?? null,
        dynamics: dynamics ?? null,
      };
    });

    // Overall percentile distribution across the full period
    const allScores = evaluations
      .map(e => e.scoreValue)
      .filter((v): v is number => v != null && Number.isFinite(v));
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
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});

/**
 * GET /api/trends
 * Returns trend summary for all metrics (latest percentiles + count).
 */
trendRoutes.get('/trends', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }

  try {
    const now = new Date();
    const period = periodResult.data;
    const periodMs = PERIOD_MS[period] ?? PERIOD_MS['7d'];
    const start = new Date(now.getTime() - periodMs);

    const metricNames = Object.keys(QUALITY_METRICS);
    const summaries = await Promise.all(
      metricNames.map(async (name: string) => {
        const evals = await loadEvaluationsForMetric(name, start.toISOString(), now.toISOString());
        const scores = evals
          .map(e => e.scoreValue)
          .filter((v): v is number => v != null && Number.isFinite(v));
        return {
          metric: name,
          count: scores.length,
          percentiles: computePercentileDistribution(scores) ?? null,
        };
      }),
    );

    return c.json({ period, metrics: summaries });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
