import { Hono } from 'hono';
import { computeCoverageHeatmap } from '../../../../dist/lib/quality/quality-metrics.js';
import { sanitizeErrorForResponse } from '../../../../dist/lib/errors/error-sanitizer.js';
import type { EvaluationResult } from '../../../../dist/backends/index.js';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, InputKeySchema, ErrorMessage, HttpStatus, computePeriodDates } from '../../lib/constants.js';

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

/**
 * GET /api/coverage
 * Returns coverage heatmap: metrics x inputs with gap identification.
 *
 * Query params:
 *   period: '24h' | '7d' | '30d' (default: '7d')
 *   inputKey: 'traceId' | 'sessionId' (default: 'traceId')
 */
coverageRoutes.get('/coverage', async (c) => {
  const periodResult = PeriodSchema.safeParse(c.req.query('period'));
  if (!periodResult.success) {
    return c.json({ error: ErrorMessage.InvalidPeriod }, HttpStatus.BadRequest);
  }
  const inputKeyResult = InputKeySchema.safeParse(c.req.query('inputKey'));
  if (!inputKeyResult.success) {
    return c.json({ error: 'Invalid inputKey. Must be traceId or sessionId.' }, HttpStatus.BadRequest);
  }

  try {
    const period = periodResult.data;
    const { start, end } = computePeriodDates(period);

    const allEvaluations = await loadEvaluationsByMetric(start, end);
    const evaluationsByMetric = filterJudgeEvaluations(allEvaluations);

    const heatmap = computeCoverageHeatmap(evaluationsByMetric, {
      inputKey: inputKeyResult.data,
    });

    return c.json({ period, ...heatmap });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
