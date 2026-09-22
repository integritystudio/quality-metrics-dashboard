import type { CoverageMatrix, CoverageGapSummary, CoverageStatus } from '../types.js';

/**
 * Browser-side reading of the columnar coverage matrix (CVG-1).
 *
 * The SPA imports only *types* from the parent (the parent-import boundary
 * enforced since `DASH-DIST-IMPORT`), so these two derivations mirror
 * `coverageStatusForCount` and `summarizeCoverageGaps` in the parent's
 * `quality-visualization.ts` instead of importing them. They cannot drift
 * silently: the thresholds applied here travel inside the payload, written by
 * the same parent function that produced the counts.
 */

/** The status a pair's count implies, under the thresholds the writer used. */
export function coverageStatusForCount(
  count: number,
  coveredThreshold: number,
  partialThreshold: number,
): CoverageStatus {
  if (count >= coveredThreshold) return 'covered';
  if (count > partialThreshold) return 'partial';
  return 'missing';
}

/** Evaluations at a matrix position; 0 when the row or column is absent. */
export function countAt(matrix: CoverageMatrix, metricIndex: number, inputIndex: number): number {
  return matrix.counts[metricIndex]?.[inputIndex] ?? 0;
}

/**
 * Per-metric gap summary for display. Fully covered metrics are omitted, so an
 * empty result means every metric covers every input.
 */
export function summarizeCoverageGaps(matrix: CoverageMatrix): CoverageGapSummary[] {
  const { metrics, inputs, counts, coveredThreshold, partialThreshold } = matrix;
  const summaries: CoverageGapSummary[] = [];

  metrics.forEach((metric, metricIndex) => {
    const row = counts[metricIndex] ?? [];
    let missingCount = 0;
    for (const count of row) {
      if (coverageStatusForCount(count, coveredThreshold, partialThreshold) === 'missing') {
        missingCount++;
      }
    }
    if (missingCount === 0) return;
    const coveragePercent = inputs.length > 0
      ? Math.round(((inputs.length - missingCount) / inputs.length) * PERCENT_MULTIPLIER * PERCENT_ROUNDING) / PERCENT_ROUNDING
      : 0;
    summaries.push({ metric, missingCount, coveragePercent });
  });

  return summaries;
}

/** Percent conversion, matching the parent's PERCENT_MULTIPLIER. */
const PERCENT_MULTIPLIER = 100;
/** Two decimal places, matching the parent's PERCENT_PRECISION. */
const PERCENT_ROUNDING = 100;
