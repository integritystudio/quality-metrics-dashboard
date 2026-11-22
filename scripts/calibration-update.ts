/**
 * What a derive run does to the calibration state, as a pure decision: the CLI
 * keeps the state in `.calibration-state.json`, the parent's derive Workflow in
 * KV, and both decide a rewrite here.
 */

import { ascending, rollup } from 'd3-array';
import {
  computeCalibrationDistributions,
  isCalibrationStale,
  shouldRecalibrate,
  type CalibrationState,
} from '../../src/lib/quality/qfe-percentiles.js';
import type { EvaluationResult } from '../../src/backends/index.js';

/** Maximum raw scores to persist per metric in calibration state (bounds file size) */
export const MAX_RAW_SCORES_PER_METRIC = 500;

/**
 * Keep a metric's previous calibration when this run could not recompute it. A metric under
 * `MIN_QUANTILE_SAMPLE_SIZE` samples gets no distribution, so a metric still sparse over the
 * `CALIBRATION_WINDOW_DAYS` read (handoff_correctness) would otherwise drop out of
 * `meta:calibration` at every rewrite. A carried entry keeps its own windowStart/windowEnd, so its
 * age stays visible; a freshly computed one always replaces it.
 */
export function carryForwardDistributions(
  previous: CalibrationState['distributions'] | undefined,
  fresh: CalibrationState['distributions'],
): CalibrationState['distributions'] {
  return { ...previous, ...fresh };
}

export type CalibrationRow = Pick<EvaluationResult, 'timestamp' | 'evaluationId' | 'evaluationName' | 'scoreValue'>;

/**
 * Each metric's scores from stored rows, oldest first so a tail slice keeps the
 * latest. A row two account keys both read is counted once.
 */
export function calibrationScores(rows: Iterable<CalibrationRow>): Record<string, number[]> {
  const seenIds = new Set<string>();
  const scored: Array<CalibrationRow & { scoreValue: number }> = [];
  for (const row of rows) {
    const { scoreValue, evaluationId } = row;
    if (typeof scoreValue !== 'number' || !Number.isFinite(scoreValue)) continue;
    if (evaluationId !== undefined) {
      if (seenIds.has(evaluationId)) continue;
      seenIds.add(evaluationId);
    }
    scored.push({ ...row, scoreValue });
  }
  scored.sort((a, b) => Number(a.timestamp - b.timestamp));
  return Object.fromEntries(rollup(scored, group => group.map(row => row.scoreValue), row => row.evaluationName));
}

/**
 * Each metric's latest `MAX_RAW_SCORES_PER_METRIC` scores: what the state file
 * keeps, and so what a later run's PSI must be measured on. Comparing the
 * stored tail with a whole window would read the window's age mix as drift.
 */
export function recentScores(scoresByMetric: Record<string, number[]>): Record<string, number[]> {
  return Object.fromEntries(Object.entries(scoresByMetric).map(([metric, scores]) => [metric, scores.slice(-MAX_RAW_SCORES_PER_METRIC)]));
}

/** One line per check: each metric's measured PSI, or that it had too few samples for one. */
export function formatCalibrationCheck(
  previousScores: Record<string, number[]>,
  scoresByMetric: Record<string, number[]>,
  psiValues: Record<string, number>,
  unmeasured: readonly string[],
): string {
  const measured = Object.entries(psiValues).toSorted(([a], [b]) => ascending(a, b)).map(([metric, psi]) => `${metric}=${psi}`);
  const sparse = unmeasured.toSorted(ascending).map(metric => `${metric} (${previousScores[metric]?.length ?? 0} stored, ${scoresByMetric[metric]?.length ?? 0} now)`);
  return `psi ${measured.join(' ') || 'none'}; too few samples: ${sparse.join(', ') || 'none'}`;
}

/** What a run does with the calibration state, and the line its check logs. */
export type CalibrationDecision =
  | { kind: 'no-samples' }
  | { kind: 'unchanged'; check: string; lastCalibrated: string }
  | { kind: 'rewrite'; check: string; state: CalibrationState; /** Metrics kept from the previous state. */ carried: string[] };

/**
 * The state after a run that read `scoresByMetric` over the calibration window.
 * Rewritten when a distribution drifts (PSI), a metric first reaches the sample
 * floor, or `previousState` is past its maximum age.
 */
export function decideCalibration(previousState: CalibrationState | null, scoresByMetric: Record<string, number[]>, nowMs: number): CalibrationDecision {
  const newDistributions = computeCalibrationDistributions(scoresByMetric);
  if (Object.keys(newDistributions).length === 0) return { kind: 'no-samples' };

  const rawScores = recentScores(scoresByMetric);
  const { shouldWrite, psiValues, unmeasured } = shouldRecalibrate(previousState, rawScores);
  const check = formatCalibrationCheck(previousState?.rawScores ?? {}, scoresByMetric, psiValues, unmeasured);
  // psiValues reflects PSI at the time of last write, not from every check:
  // a run that finds nothing to rewrite leaves the state alone.
  if (previousState !== null && !shouldWrite && !isCalibrationStale(previousState, nowMs)) {
    return { kind: 'unchanged', check, lastCalibrated: previousState.lastCalibrated };
  }
  const distributions = carryForwardDistributions(previousState?.distributions, newDistributions);
  return {
    kind: 'rewrite',
    check,
    state: { lastCalibrated: new Date(nowMs).toISOString(), distributions, psiValues, rawScores },
    carried: Object.keys(distributions).filter(metric => !(metric in newDistributions)),
  };
}
