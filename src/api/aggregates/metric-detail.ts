/**
 * Metric detail (`GET /api/metrics/:name`), built once for both the API route
 * (`routes/metrics.ts`) and the KV sync (`scripts/sync-to-kv.ts`). The sync once
 * wrote a single `metric:<name>` for the last week, without `dynamics`, and the
 * Worker served it whatever `period` the page asked for; the route computed
 * every period live with dynamics (DASHBOARD-AGGREGATE-DUAL-IMPL).
 *
 * Callers load the current window and the one before it; this module projects
 * them, so one fixture through both paths yields the same value.
 */

import { computeAggregations, type getQualityMetric } from '../parent/quality-metrics.js';
import { computeMetricDetail } from '../parent/quality-views.js';
import { computeMetricDynamics } from '../parent/qfe-dynamics.js';
import { extractFiniteScores } from '../api-constants.js';
import { PERIOD_MS, TIME_MS } from '../../lib/constants.js';
import type { EvaluationResult, MetricDetailResult, MetricDynamics, Period } from '../../types.js';

/** One KV key per metric and period; the Worker restates the prefix because it cannot import this module. */
export const METRIC_DETAIL_KEY_PREFIX = 'metric:';

export function metricDetailKey(name: string, period: Period): string {
  return `${METRIC_DETAIL_KEY_PREFIX}${name}:${period}`;
}

const DYNAMICS_BUCKET_HOURS_HOURLY = 1;
const DYNAMICS_BUCKET_HOURS_DAILY = 24;

/** The bucket width `computeMetricDynamics` reads velocity in: hourly for a day, daily otherwise. */
export function dynamicsBucketHours(period: Period): number {
  return period === '24h' ? DYNAMICS_BUCKET_HOURS_HOURLY : DYNAMICS_BUCKET_HOURS_DAILY;
}

export type QualityMetricConfig = NonNullable<ReturnType<typeof getQualityMetric>>;

/**
 * The baseline read: one period before the current window, ending on the last
 * ms of the UTC day before the day the current window starts in. The server
 * rounds a read's end up to the next UTC midnight, so an end at the current
 * window's start would count that whole day twice (METRIC-WEEK-OVERLAP).
 */
export function previousWindow(period: Period, now: Date): { start: Date; end: Date } {
  const periodMs = PERIOD_MS[period];
  const currentStartMs = now.getTime() - periodMs;
  const currentStartDayMs = Math.floor(currentStartMs / TIME_MS.DAY) * TIME_MS.DAY;
  return { start: new Date(currentStartMs - periodMs), end: new Date(currentStartDayMs - 1) };
}

export type MetricDetailView = MetricDetailResult & { dynamics: MetricDynamics | undefined };

/**
 * Detail for one metric over one period, baselined against the period before it.
 * A previous window without a finite score yields no `trend` and no `dynamics`.
 */
export function computeMetricDetailView(
  evaluations: EvaluationResult[],
  previousEvaluations: EvaluationResult[],
  config: QualityMetricConfig,
  options: { period: Period; topN: number; bucketCount: number },
): MetricDetailView {
  const previousScores = extractFiniteScores(previousEvaluations);
  const previousValues = previousScores.length > 0
    ? computeAggregations(previousScores, config.aggregations)
    : undefined;
  const detail = computeMetricDetail(evaluations, config, {
    topN: options.topN,
    bucketCount: options.bucketCount,
    previousValues,
  });
  const dynamics = detail.trend
    ? computeMetricDynamics(detail.trend, dynamicsBucketHours(options.period))
    : undefined;
  return { ...detail, dynamics };
}
