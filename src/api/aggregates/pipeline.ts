/**
 * Pipeline funnel (`GET /api/pipeline`), built once for both the API route
 * (`routes/pipeline.ts`) and the KV sync (`scripts/sync-to-kv.ts`).
 * The sync once recomputed `computeDashboardSummary` and `computePipelineView`
 * inline in `computePeriodEntries`; the route did the same independently
 * (DASHBOARD-AGGREGATE-DUAL-IMPL).
 *
 * Callers load the evaluations; this module only projects them.
 */

import { computeDashboardSummary } from '../parent/quality-metrics.js';
import { computePipelineView } from '../parent/quality-visualization.js';
import type { EvaluationResult } from '../../types.js';

export interface PipelineResult {
  stages: unknown[];
  dropoffs: unknown[];
  overallConversionPercent: number;
}

/**
 * 4-stage evaluation pipeline funnel from `evaluationsByMetric`.
 * `computeDashboardSummary` is called internally and not returned; only the
 * pipeline shape is exposed, so both the route and the sync use the same output.
 */
export function computePipeline(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
): ReturnType<typeof computePipelineView> {
  const dashboard = computeDashboardSummary(evaluationsByMetric);
  return computePipelineView(evaluationsByMetric, dashboard);
}
