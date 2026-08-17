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
  ExecutiveView,
  OperatorView,
  QualityDashboardSummary,
  QualityMetricResult,
} from '../../types.js';

/** Epoch nanoseconds. `EvaluationResult.timestamp` is a `bigint`, never an ISO string. */
export const EVAL_NANOS = 1737000000000000000n;

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

/**
 * `RoleView` is a discriminated union on `role`, not a dashboard summary with a
 * `role` field bolted on — the previous `{ ...makeMockDashboard(), role }` stub
 * shared almost no fields with either real variant.
 */
export function makeExecutiveView(overrides: Partial<ExecutiveView> = {}): ExecutiveView {
  return {
    role: 'executive',
    overallStatus: 'healthy',
    summary: {
      totalMetrics: 1,
      healthyMetrics: 1,
      warningMetrics: 0,
      criticalMetrics: 0,
      noDataMetrics: 0,
    },
    metricStatuses: [{ name: 'relevance', displayName: 'Relevance', status: 'healthy' }],
    alertCounts: { info: 0, warning: 0, critical: 0 },
    topIssues: [],
    cqi: makeCQI(),
    ...overrides,
  };
}

export function makeOperatorView(overrides: Partial<OperatorView> = {}): OperatorView {
  return {
    role: 'operator',
    overallStatus: 'healthy',
    prioritizedAlerts: [],
    alertingMetrics: [],
    degradingTrends: [],
    ...overrides,
  };
}
