/**
 * Coverage matrix (`GET /api/coverage`), built once for both the API route
 * (`routes/coverage.ts`) and the KV sync (`scripts/sync-to-kv.ts`).
 *
 * Callers load the evaluations; this module filters and projects them.
 */

import { computeCoverageMatrix, type CoverageInput } from '../parent/quality-visualization.js';
import { RULE_EVALUATOR_TYPE } from '../api-constants.js';
import type { EvaluationResult } from '../../types.js';

/** What the coverage matrix reads from a row; a full `EvaluationResult` qualifies. */
export type CoverageRow = CoverageInput & Pick<EvaluationResult, 'evaluatorType'>;

/**
 * Remove rule-based evaluations before computing the coverage matrix.
 * Rule evals have per-span traceId granularity that inflates the input universe
 * (CVG-RULE-FILTER). Keeps LLM judge evals and seed evals (evaluatorType
 * undefined or any non-rule value).
 */
export function filterJudgeEvals<Row extends Pick<EvaluationResult, 'evaluatorType'>>(
  byMetric: Map<string, Row[]>,
): Map<string, Row[]> {
  const filtered = new Map<string, Row[]>();
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
  evaluationsByMetric: Map<string, CoverageRow[]>,
  options: {
    inputKey: 'traceId' | 'sessionId';
    maxInputs?: number;
  },
): ReturnType<typeof computeCoverageMatrix> {
  const judgeOnly = filterJudgeEvals(evaluationsByMetric);
  return computeCoverageMatrix(judgeOnly, options);
}
