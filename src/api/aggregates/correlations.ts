/**
 * Metric correlation matrix (`GET /api/correlations`), built once for both the API
 * route (`routes/correlations.ts`) and the KV sync (`scripts/sync-to-kv.ts`).
 * The sync once computed the matrix inline in `computePeriodEntries`; the route
 * did the same independently (DASHBOARD-AGGREGATE-DUAL-IMPL).
 *
 * Callers load the evaluations; this module only projects them.
 */

import { computeCorrelationMatrix } from '../parent/qfe-correlation.js';
import { extractFiniteScores } from '../api-constants.js';
import type { EvaluationResult, CorrelationFeature } from '../../types.js';

export interface CorrelationsResult {
  correlations: CorrelationFeature[];
  metrics: string[];
}

/**
 * Pearson correlation matrix over finite scores, keyed by metric name.
 * One fixture through both the route and the sync yields the same value.
 */
export function computeCorrelations(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
): CorrelationsResult {
  const metricTimeSeries = new Map<string, number[]>();
  for (const [name, evals] of evaluationsByMetric) {
    metricTimeSeries.set(name, extractFiniteScores(evals));
  }
  return {
    correlations: computeCorrelationMatrix(metricTimeSeries),
    metrics: [...evaluationsByMetric.keys()],
  };
}
