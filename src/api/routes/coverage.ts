import { Hono } from 'hono';
import { computeCoverageMatrix } from '../parent/quality-visualization.js';
import type { EvaluationResult } from '../../types.js';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, InputKeySchema, ErrorMessage, computePeriodDates } from '../../lib/constants.js';
import { parseParam, handleRouteError } from '../route-errors.js';

/** Filter out rule-based per-span evaluations; they have incompatible
 *  traceId granularity that inflates the coverage input universe.
 *  Keeps LLM judge evals (evaluatorType 'llm', undefined for seed/canary). */
function filterJudgeEvaluations(
  byMetric: Map<string, EvaluationResult[]>,
): Map<string, EvaluationResult[]> {
  const filtered = new Map<string, EvaluationResult[]>();
  for (const [metric, evals] of byMetric) {
    const judgeEvals = evals.filter(e => e.evaluatorType !== 'rule');
    if (judgeEvals.length > 0) {
      filtered.set(metric, judgeEvals);
    }
  }
  return filtered;
}

export const coverageRoutes = new Hono();
coverageRoutes.onError(handleRouteError);

/**
 * GET /api/coverage
 * Returns the columnar coverage matrix: metrics x inputs counts, with
 * status and gaps derivable by the reader (CVG-1).
 *
 * Query params:
 *   period: '24h' | '7d' | '30d' (default: '7d')
 *   inputKey: 'traceId' | 'sessionId' (default: 'traceId')
 */
coverageRoutes.get('/coverage', async (c) => {
  const period = parseParam(PeriodSchema, c.req.query('period'), ErrorMessage.InvalidPeriod);
  const inputKey = parseParam(InputKeySchema, c.req.query('inputKey'), ErrorMessage.InvalidInputKey);

  const { start, end } = computePeriodDates(period);

  const allEvaluations = await loadEvaluationsByMetric(start, end);
  const evaluationsByMetric = filterJudgeEvaluations(allEvaluations);

  // Columnar, matching what sync-to-kv writes to KV and the Worker serves, so
  // the dev server and production hand the grid the same shape (CVG-1).
  const matrix = computeCoverageMatrix(evaluationsByMetric, {
    inputKey,
  });

  return c.json({ period, ...matrix });
});
