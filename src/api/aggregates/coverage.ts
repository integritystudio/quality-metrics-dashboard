/**
 * Coverage matrix (`GET /api/coverage`), built once for both the API route
 * (`routes/coverage.ts`) and the KV sync (`scripts/sync-to-kv.ts`).
 *
 * The route once kept `filterJudgeEvaluations` inline; the sync kept
 * `filterRuleEvals` inline — two copies of the same filter (DASHBOARD-AGGREGATE-DUAL-IMPL).
 *
 * Callers load the evaluations; this module filters and projects them.
 */

import { computeCoverageMatrix } from '../parent/quality-visualization.js';
import { RULE_EVALUATOR_TYPE } from '../api-constants.js';
import type { EvaluationResult } from '../../types.js';

export { RULE_EVALUATOR_TYPE };

/**
 * Remove rule-based evaluations before computing the coverage matrix.
 * Rule evals have per-span traceId granularity that inflates the input universe
 * (CVG-RULE-FILTER). Keeps LLM judge evals and seed/canary evals (evaluatorType
 * undefined or any non-rule value).
 */
export function filterJudgeEvals(
  byMetric: Map<string, EvaluationResult[]>,
): Map<string, EvaluationResult[]> {
  const filtered = new Map<string, EvaluationResult[]>();
  for (const [metric, evals] of byMetric) {
    const judgeEvals = evals.filter(e => e.evaluatorType !== RULE_EVALUATOR_TYPE);
    if (judgeEvals.length > 0) filtered.set(metric, judgeEvals);
  }
  return filtered;
}

/**
 * Coverage matrix: metrics × inputs (traceId or sessionId) counts.
 * The route and the sync both call `filterJudgeEvals` then `computeCoverageMatrix`,
 * so one fixture through both yields the same value.
 */
export function computeCoverage(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
  options: {
    inputKey: 'traceId' | 'sessionId';
    maxInputs?: number;
  },
): ReturnType<typeof computeCoverageMatrix> {
  const judgeOnly = filterJudgeEvals(evaluationsByMetric);
  return computeCoverageMatrix(judgeOnly, options);
}
