import { Hono } from 'hono';
import {
  computeRollingDegradationSignals,
  type DegradationState,
} from '../parent/qfe-backtest.js';
import {
  DEFAULT_BIN_COUNT,
} from '../parent/quality-constants.js';
import {
  buildEvenBucketBoundaries,
  getEvenBucketIndex,
} from '../parent/bucket-utils.js';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { LIVE_WINDOW_MS, computePeriodDates } from '../../lib/constants.js';
import { timestampToMs } from '../../lib/timestamps.js';
import { summarizeQualityLive } from '../../lib/quality-live.js';
import { PeriodQuery, validQuery, handleRouteError } from '../route-errors.js';

export const qualityRoutes = new Hono();
qualityRoutes.onError(handleRouteError);

/**
 * GET /api/quality/live
 * Returns latest quality evaluation results from today's evaluations.
 * Response: { metrics, sessionCount, lastUpdated }
 */
qualityRoutes.get('/quality/live', async (c) => {
  const now = new Date();
  const start = new Date(now.getTime() - LIVE_WINDOW_MS);

  const evaluationsByMetric = await loadEvaluationsByMetric(
    start.toISOString(),
    now.toISOString(),
  );

  const sortedByMetric = [...evaluationsByMetric].map(([name, evals]) => [
    name,
    evals
      .toSorted((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
      .map((ev) => ({ score: ev.scoreValue, evaluatorType: ev.evaluatorType, timestamp: ev.timestamp, traceId: ev.traceId })),
  ] as const);

  return c.json(summarizeQualityLive(sortedByMetric, now));
});

/**
 * GET /api/degradation-signals
 * Returns per-metric EWMA degradation signals computed from local evaluation data.
 * Mirrors the KV-backed worker route for use in local dev.
 *
 * Query params:
 *   period: '24h' | '7d' | '30d' | '90d' (default: '7d')
 */
qualityRoutes.get('/degradation-signals', validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');

  const { start: startDate, end: endDate } = computePeriodDates(period);
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const bucketMs = (endMs - startMs) / DEFAULT_BIN_COUNT;
  const boundaries = buildEvenBucketBoundaries(startMs, endMs, DEFAULT_BIN_COUNT);

  const evaluationsByMetric = await loadEvaluationsByMetric(startDate, endDate);
  const metricNames = [...evaluationsByMetric.keys()];
  const bucketLabels = boundaries.map(b => ({
    startTime: new Date(b.start).toISOString(),
    endTime: new Date(b.end).toISOString(),
  }));
  const timeBuckets: Record<string, Array<{ scores: number[]; startTime: string; endTime: string }>> = {};

  for (const [name, evals] of evaluationsByMetric) {
    const buckets = bucketLabels.map(b => ({ ...b, scores: [] as number[] }));
    for (const ev of evals) {
      if (ev.scoreValue == null) continue;
      const ts = timestampToMs(ev.timestamp);
      const idx = getEvenBucketIndex(ts, startMs, bucketMs, DEFAULT_BIN_COUNT);
      if (idx !== null) buckets[idx]?.scores.push(ev.scoreValue);
    }
    timeBuckets[name] = buckets;
  }

  const noBreachState: DegradationState = { lastRun: '', breaches: {} };
  const window = { startDate, endDate };
  const reports = computeRollingDegradationSignals(timeBuckets, metricNames, noBreachState, window);

  return c.json({ period, reports, computedAt: new Date().toISOString() });
});
