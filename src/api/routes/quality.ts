import { Hono } from 'hono';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import {
  computeRollingDegradationSignals,
  type DegradationState,
} from '../../../../dist/lib/quality/quality-feature-engineering.js';
import {
  DEFAULT_BIN_COUNT,
} from '../../../../dist/lib/quality/quality-constants.js';
import {
  buildEvenBucketBoundaries,
  getEvenBucketIndex,
} from '../../../../dist/lib/quality/bucket-utils.js';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { LIVE_WINDOW_MS, EVAL_LIMIT, HttpStatus, PeriodSchema, ErrorMessage, computePeriodDates } from '../../lib/constants.js';
import type { LiveMetric, QualityLiveData } from '../../types.js';

export const qualityRoutes = new Hono();

/**
 * GET /api/quality/live
 * Returns latest quality evaluation results from today's evaluations.
 * Response: { metrics, sessionCount, lastUpdated }
 */
qualityRoutes.get('/quality/live', async (c) => {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - LIVE_WINDOW_MS);

    const evaluationsByMetric = await loadEvaluationsByMetric(
      start.toISOString(),
      now.toISOString(),
    );

    const metrics: LiveMetric[] = [];
    const sessionIds = new Set<string>();
    const latestTimestamp = '';

    for (const [name, evals] of evaluationsByMetric) {
      const sorted = evals
        .slice()
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, EVAL_LIMIT);

      for (const ev of sorted) {
        if (ev.traceId) sessionIds.add(ev.traceId);
      }

      const latest = sorted[0];
      if (latest && latest.scoreValue != null) {
        metrics.push({
          name,
          score: latest.scoreValue,
          evaluatorType: latest.evaluatorType ?? 'unknown',
          timestamp: latest.timestamp,
        });
        if (latest.timestamp > latestTimestamp) {
          latestTimestamp = latest.timestamp;
        }
      }
    }

    metrics.sort((a, b) => a.name.localeCompare(b.name));

    const response: QualityLiveData = {
      metrics,
      sessionCount: sessionIds.size,
      lastUpdated: latestTimestamp || now.toISOString(),
    };

    return c.json(response);
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});

/**
 * GET /api/degradation-signals
 * Returns per-metric EWMA degradation signals computed from local evaluation data.
 * Mirrors the KV-backed worker route for use in local dev.
 *
 * Query params:
 *   period: '24h' | '7d' | '30d' (default: '7d')
 */
qualityRoutes.get('/degradation-signals', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
  }

  try {
    const period = periodResult.data;
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
        const ts = new Date(ev.timestamp).getTime();
        const idx = getEvenBucketIndex(ts, startMs, bucketMs, DEFAULT_BIN_COUNT);
        if (idx !== null) buckets[idx].scores.push(ev.scoreValue);
      }
      timeBuckets[name] = buckets;
    }

    const noBreachState: DegradationState = { lastRun: '', breaches: {} };
    const window = { startDate, endDate };
    const reports = computeRollingDegradationSignals(timeBuckets, metricNames, noBreachState, window);

    return c.json({ period, reports, computedAt: new Date().toISOString() });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
