import { Hono } from 'hono';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { loadEvaluationsByMetric } from '../data-loader.js';

export const qualityRoutes = new Hono();

interface LiveMetric {
  name: string;
  score: number;
  evaluatorType: string;
  timestamp: string;
}

interface QualityLiveResponse {
  metrics: LiveMetric[];
  sessionCount: number;
  lastUpdated: string;
}

const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EVAL_LIMIT = 100;

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
    let latestTimestamp = '';

    for (const [name, evals] of evaluationsByMetric) {
      // Take last EVAL_LIMIT records, sorted by timestamp desc
      const sorted = evals
        .slice()
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, EVAL_LIMIT);

      // Track sessions
      for (const ev of sorted) {
        if (ev.traceId) sessionIds.add(ev.traceId);
      }

      // Latest eval for this metric
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

    // Sort by metric name for stable ordering
    metrics.sort((a, b) => a.name.localeCompare(b.name));

    const response: QualityLiveResponse = {
      metrics,
      sessionCount: sessionIds.size,
      lastUpdated: latestTimestamp || now.toISOString(),
    };

    return c.json(response);
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, 500);
  }
});
