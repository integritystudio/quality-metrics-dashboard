/**
 * Metric trend series (`GET /api/trends/:name`), built once for both the API
 * route (`routes/trends.ts`) and the KV sync (`scripts/sync-to-kv.ts`), one key
 * per period (DASHBOARD-AGGREGATE-DUAL-IMPL).
 *
 * Callers load the period's evaluations; this module buckets and projects them,
 * and hands back the scored buckets the sync's degradation signals read, so
 * those narrow with the chart.
 */

import { extent, mean } from 'd3-array';
import { computeAggregations } from '../parent/quality-metrics.js';
import { computeMetricDetail } from '../parent/quality-views.js';
import { computeMetricDynamics } from '../parent/qfe-dynamics.js';
import { computePercentileDistribution } from '../parent/qfe-percentiles.js';
import { buildEvenBucketBoundaries, getEvenBucketIndex } from '../parent/bucket-utils.js';
import { CONCENTRATION_THRESHOLD, SCORE_ROUND_FACTOR, extractFiniteScores, timestampToMs } from '../api-constants.js';
import { PERIOD_MS, TIME_MS } from '../../lib/constants.js';
import type { EvaluationResult, MetricDynamics, MetricTrend, Period } from '../../types.js';
import type { QualityMetricConfig } from './metric-detail.js';

/** One KV key per metric and period; the Worker restates the prefix because it cannot import this module. */
export const TREND_KEY_PREFIX = 'trend:';

export function trendKey(name: string, period: Period): string {
  return `${TREND_KEY_PREFIX}${name}:${period}`;
}

/** Fraction of the data span added as padding on each side when auto-narrowing the time axis. */
const TREND_PADDING_RATIO = 0.1;
/** Minimum padding in ms when auto-narrowing, so at least a minute of context shows. */
const TREND_PADDING_MIN_MS = 60_000;

type Percentiles = ReturnType<typeof computePercentileDistribution>;

export interface TrendBucket {
  startTime: string;
  endTime: string;
  count: number;
  avg: number | null;
  percentiles: Percentiles;
  trend: MetricTrend | null;
  dynamics: MetricDynamics | null;
}

export interface TrendView {
  metric: string;
  period: Period;
  bucketCount: number;
  totalEvaluations: number;
  overallPercentiles: Percentiles;
  trendData: TrendBucket[];
  narrowed: boolean;
}

/** A bucket's window and scores, the input the degradation signals consume. */
export interface ScoredBucket {
  startTime: string;
  endTime: string;
  scores: number[];
}

type ScoredEvaluation = { ev: EvaluationResult; ts: number; score: number };

function isScored(row: { ev: EvaluationResult; ts: number; score: number | null | undefined }): row is ScoredEvaluation {
  return Number.isFinite(row.ts) && row.score != null && Number.isFinite(row.score);
}

/**
 * Even time buckets over the period ending at `now`, narrowed to the data's own
 * span (plus padding) when it occupies less than CONCENTRATION_THRESHOLD of it.
 * Only finitely scored evaluations enter a bucket, so `count`, `avg` and `trend`
 * describe the same rows.
 */
export function computeTrend(
  metric: string,
  evaluations: EvaluationResult[],
  config: QualityMetricConfig,
  options: { period: Period; bucketCount: number; now: Date },
): { view: TrendView; buckets: ScoredBucket[] } {
  const { period, bucketCount, now } = options;
  const periodMs = PERIOD_MS[period];
  const periodStartMs = now.getTime() - periodMs;

  const scored = evaluations
    .map(ev => ({ ev, ts: timestampToMs(ev.timestamp), score: ev.scoreValue }))
    .filter(isScored);

  const [dataMin, dataMax] = scored.length > 0
    ? (extent(scored, row => row.ts) as [number, number])
    : [periodStartMs, now.getTime()];
  const dataSpan = dataMax - dataMin;
  const narrowed = scored.length > 1 && dataSpan < periodMs * CONCENTRATION_THRESHOLD;
  const pad = narrowed ? Math.max(dataSpan * TREND_PADDING_RATIO, TREND_PADDING_MIN_MS) : 0;
  const startMs = narrowed ? dataMin - pad : periodStartMs;
  const endMs = narrowed ? dataMax + pad : now.getTime();
  const rangeMs = endMs - startMs;
  const bucketMs = rangeMs / bucketCount;

  type BucketEntry = ScoredBucket & { evals: EvaluationResult[] };
  const buckets: BucketEntry[] = buildEvenBucketBoundaries(startMs, endMs, bucketCount).map(b => ({
    startTime: new Date(b.start).toISOString(),
    endTime: new Date(b.end).toISOString(),
    scores: [],
    evals: [],
  }));

  for (const { ev, ts, score } of scored) {
    const idx = getEvenBucketIndex(ts, startMs, bucketMs, bucketCount);
    const bucket = idx === null ? undefined : buckets[idx];
    if (bucket) {
      bucket.scores.push(score);
      bucket.evals.push(ev);
    }
  }

  const bucketHours = rangeMs / (bucketCount * TIME_MS.HOUR);
  let previousTrend: MetricTrend | undefined;

  const trendData: TrendBucket[] = buckets.map((bucket, idx) => {
    const { scores } = bucket;
    const prevBucket = idx > 0 ? buckets[idx - 1] : undefined;
    const previousValues = prevBucket && prevBucket.scores.length > 0
      ? computeAggregations(prevBucket.scores, config.aggregations)
      : undefined;
    const detail = scores.length > 0
      ? computeMetricDetail(bucket.evals, config, { topN: 0, bucketCount: 0, previousValues })
      : undefined;
    let dynamics: MetricDynamics | undefined;
    if (detail?.trend) {
      dynamics = computeMetricDynamics(detail.trend, bucketHours, { previousTrend });
      previousTrend = detail.trend;
    }
    const avg = mean(scores);
    return {
      startTime: bucket.startTime,
      endTime: bucket.endTime,
      count: scores.length,
      avg: avg != null ? Math.round(avg * SCORE_ROUND_FACTOR) / SCORE_ROUND_FACTOR : null,
      percentiles: computePercentileDistribution(scores),
      trend: detail?.trend ?? null,
      dynamics: dynamics ?? null,
    };
  });

  const allScores = extractFiniteScores(evaluations);
  const view: TrendView = {
    metric,
    period,
    bucketCount,
    totalEvaluations: allScores.length,
    overallPercentiles: computePercentileDistribution(allScores),
    trendData,
    narrowed,
  };
  return { view, buckets: buckets.map(({ startTime, endTime, scores }) => ({ startTime, endTime, scores })) };
}
