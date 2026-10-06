/**
 * Typed fixtures for the API route suites.
 *
 * Every factory is annotated with the real parent type (via `../../types.js`,
 * which is type-only and therefore erased — safe under `parentDistStub` when
 * standalone CI runs without a parent build). That makes the fixtures
 * drift-detecting: a parent shape change fails `npm run typecheck` here rather
 * than silently leaving a mock that models nothing.
 *
 * These replaced `as any` stubs that had drifted from the real shapes — the
 * dashboard summary's `metrics[]` carried `currentValue`/`threshold`/`direction`
 * (none of which exist on `QualityMetricResult`) and `computeCQI` was stubbed
 * with a bare number where the signature returns an object.
 */
import type {
  CompositeQualityIndex,
  EvaluationResult,
  QualityDashboardSummary,
  QualityMetricResult,
} from '../../types.js';

/** Epoch nanoseconds. `EvaluationResult.timestamp` is a `bigint`, never an ISO string. */
export const EVAL_NANOS = 1737000000000000000n;

const NANOS_PER_MS = 1_000_000n;
const ONE_HOUR_MS = 3_600_000;

/**
 * Epoch nanoseconds `agoMs` before now. Routes window evaluations to the
 * requested period, so real computation over `EVAL_NANOS` (January 2025)
 * sees an empty period.
 */
export function recentEvalNanos(agoMs = ONE_HOUR_MS): bigint {
  return BigInt(Date.now() - agoMs) * NANOS_PER_MS;
}

export function makeEvaluation(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    evaluationName: 'relevance',
    scoreValue: 0.85,
    timestamp: EVAL_NANOS,
    traceId: 'trace-001',
    evaluatorType: 'seed',
    scoreLabel: 'relevant',
    explanation: 'Response is relevant.',
    evaluator: 'seed-hash',
    ...overrides,
  };
}

export function makeMetricResult(overrides: Partial<QualityMetricResult> = {}): QualityMetricResult {
  return {
    name: 'relevance',
    displayName: 'Relevance',
    values: { avg: 0.85, min: null, max: null, count: 1, p50: null, p95: null, p99: null },
    sampleCount: 1,
    alerts: [],
    status: 'healthy',
    ...overrides,
  };
}

export function makeDashboardSummary(
  overrides: Partial<QualityDashboardSummary> = {},
): QualityDashboardSummary {
  return {
    overallStatus: 'healthy',
    metrics: [makeMetricResult()],
    alerts: [],
    summary: {
      totalMetrics: 1,
      healthyMetrics: 1,
      warningMetrics: 0,
      criticalMetrics: 0,
      noDataMetrics: 0,
    },
    timestamp: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

export function makeCQI(overrides: Partial<CompositeQualityIndex> = {}): CompositeQualityIndex {
  return {
    featureVersion: 'test',
    value: 0.82,
    weights: { relevance: 1 },
    contributions: [],
    ...overrides,
  };
}

