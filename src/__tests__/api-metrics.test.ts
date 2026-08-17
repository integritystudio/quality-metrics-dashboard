/**
 * API route tests: /api/metrics/:name and /api/metrics/:name/evaluations.
 * Approach A — Node routes with mocked data-loader and dist dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/parent/quality-metrics.js', () => ({
  getQualityMetric: vi.fn(),
  computeAggregations: vi.fn(),
}));

vi.mock('../api/parent/quality-views.js', () => ({
  computeMetricDetail: vi.fn(),
}));

vi.mock('../api/parent/qfe-dynamics.js', () => ({
  computeMetricDynamics: vi.fn(),
}));

vi.mock('../api/parent/error-sanitizer.js', () => ({
  sanitizeErrorForResponse: (err: unknown) => String(err),
}));

vi.mock('../api/data-loader.js', () => ({
  loadEvaluationsByMetric: vi.fn(),
  loadEvaluationsForMetric: vi.fn(),
  loadEvaluationsByTraceId: vi.fn(),
  loadEvaluationsByTraceIds: vi.fn(),
  loadTracesByTraceId: vi.fn(),
  loadTracesBySessionId: vi.fn(),
  loadLogsByTraceId: vi.fn(),
  loadLogsBySessionId: vi.fn(),
  loadVerifications: vi.fn(),
  loadEvaluationsBySessionId: vi.fn(),
  checkHealth: vi.fn(),
}));

import { metricsRoutes } from '../api/routes/metrics.js';
import { getQualityMetric, computeAggregations } from '../api/parent/quality-metrics.js';
import { computeMetricDetail } from '../api/parent/quality-views.js';
import { computeMetricDynamics } from '../api/parent/qfe-dynamics.js';
import { loadEvaluationsForMetric } from '../api/data-loader.js';
import type { ErrorResponse, MetricDetailResponse, MetricEvaluationsResponse } from './support/api-responses.js';
import type {
  EvaluationResult,
  MetricDetailResult,
  MetricDynamics,
  MetricTrend,
  QualityMetricConfig,
} from '../types.js';


/**
 * Fixtures are typed against the real parent types (via `../types.js`, which is
 * type-only and therefore safe under `parentDistStub` in standalone CI). That
 * makes them drift-detecting: a parent shape change fails `npm run typecheck`
 * here instead of silently producing a fixture that models nothing.
 *
 * These previously carried `as any` and had drifted badly — `makeMockConfig`
 * declared `direction`/`threshold` (not fields on `QualityMetricConfig`) and a
 * `p10` aggregation (not in the enum), and `makeMockDetail` returned
 * `config`/`evaluations`/`aggregations`/`distribution`, none of which exist on
 * `MetricDetailResult`.
 */
const EVAL_NANOS = 1737000000000000000n;

function makeMockConfig(): QualityMetricConfig {
  return {
    name: 'relevance',
    displayName: 'Relevance',
    description: 'How relevant the response is',
    aggregations: ['avg', 'min', 'p50'],
    alerts: [{
      aggregation: 'p50',
      value: 0.7,
      direction: 'below',
      severity: 'warning',
      message: 'Relevance below threshold',
    }],
    range: { min: 0, max: 1 },
    unit: 'score',
  };
}

function makeMockEval(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    evaluationName: 'relevance',
    scoreValue: 0.85,
    timestamp: EVAL_NANOS,
    traceId: 'trace-001',
    evaluatorType: 'seed',
    scoreLabel: 'relevant',
    explanation: 'Response is relevant.',
    evaluator: 'seed-hash',
    spanId: 'span-001',
    sessionId: 'sess-001',
    agentName: 'general-purpose',
    trajectoryLength: 3,
    ...overrides,
  };
}

const MOCK_TREND: MetricTrend = {
  direction: 'stable',
  delta: 0,
  percentChange: 0,
  previousValue: 0.85,
  currentValue: 0.85,
  aggregation: 'avg',
};

function makeMockDetail(): MetricDetailResult {
  return {
    name: 'relevance',
    displayName: 'Relevance',
    values: { avg: 0.85, min: 0.7, p50: 0.85, max: null, count: 1, p95: null, p99: null },
    sampleCount: 1,
    alerts: [],
    status: 'healthy',
    trend: MOCK_TREND,
    scoreDistribution: [{ bucket: '0.8-0.9', count: 1 }],
    worstEvaluations: [],
    bestEvaluations: [],
  };
}

const MOCK_DYNAMICS: MetricDynamics = {
  featureVersion: 'test',
  velocity: 0,
  acceleration: 0,
  inflectionDetected: false,
  projectedStatus: 'healthy',
  confidence: 0.5,
};

// /metrics/:name route

describe('GET /metrics/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQualityMetric).mockReturnValue(makeMockConfig());
    vi.mocked(loadEvaluationsForMetric).mockResolvedValue([makeMockEval()]);
    vi.mocked(computeAggregations).mockReturnValue(makeMockDetail().values);
    vi.mocked(computeMetricDetail).mockReturnValue(makeMockDetail());
    vi.mocked(computeMetricDynamics).mockReturnValue(MOCK_DYNAMICS);
  });

  it('returns 404 for unknown metric', async () => {
    vi.mocked(getQualityMetric).mockReturnValue(undefined);
    const res = await metricsRoutes.request('/metrics/nonexistent?period=7d');
    expect(res.status).toBe(404);
    const body = await res.json() as ErrorResponse;
    expect(body).toHaveProperty('error');
  });

  it('returns 400 for invalid period', async () => {
    const res = await metricsRoutes.request('/metrics/relevance?period=99d');
    expect(res.status).toBe(400);
    const body = await res.json() as ErrorResponse;
    expect(body).toHaveProperty('error');
  });

  it('returns 400 for topN out of range', async () => {
    const res = await metricsRoutes.request('/metrics/relevance?period=7d&topN=0');
    expect(res.status).toBe(400);
  });

  it('returns 400 for bucketCount out of range', async () => {
    const res = await metricsRoutes.request('/metrics/relevance?period=7d&bucketCount=1');
    expect(res.status).toBe(400);
  });

  it('returns 200 with metric detail for valid request', async () => {
    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as MetricDetailResponse;
    // `MetricDetailResult` fields — the route spreads `...detail`. This used to
    // assert `config`/`aggregations`, which the type has never had; the test
    // passed only because the fixture invented them.
    expect(body).toHaveProperty('name', 'relevance');
    expect(body).toHaveProperty('values');
    expect(body).toHaveProperty('sampleCount');
    expect(body).toHaveProperty('scoreDistribution');
    expect(body).toHaveProperty('trend');
  });

  it('calls loadEvaluationsForMetric twice (current + previous period)', async () => {
    await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(vi.mocked(loadEvaluationsForMetric)).toHaveBeenCalledTimes(2);
  });

  it('includes dynamics when trend is present', async () => {
    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as MetricDetailResponse;
    expect(body).toHaveProperty('dynamics');
  });

  it('omits dynamics when trend is absent', async () => {
    vi.mocked(computeMetricDetail).mockReturnValue({ ...makeMockDetail(), trend: undefined });

    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as MetricDetailResponse;
    expect(body.dynamics).toBeUndefined();
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsForMetric).mockRejectedValue(new Error('disk error'));
    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(500);
  });
});

// /metrics/:name/evaluations route

describe('GET /metrics/:name/evaluations', () => {
  // Descending timestamps, one hour apart. Epoch nanos, not ISO strings —
  // `EvaluationResult.timestamp` is a bigint (`isoDatetimeToEpochNanos` codec).
  const ONE_HOUR_NANOS = 3_600_000_000_000n;
  const evals = [
    makeMockEval({ scoreValue: 0.9, timestamp: EVAL_NANOS + ONE_HOUR_NANOS * 2n, scoreLabel: 'relevant' }),
    makeMockEval({ scoreValue: 0.6, timestamp: EVAL_NANOS + ONE_HOUR_NANOS, scoreLabel: 'partial' }),
    makeMockEval({ scoreValue: 0.3, timestamp: EVAL_NANOS, scoreLabel: 'irrelevant' }),
  ];

  beforeEach(() => {
    vi.mocked(getQualityMetric).mockReturnValue(makeMockConfig());
    // Spread to prevent route's in-place sort from mutating the shared array
    vi.mocked(loadEvaluationsForMetric).mockResolvedValue([...evals]);
  });

  it('returns 404 for unknown metric', async () => {
    vi.mocked(getQualityMetric).mockReturnValue(undefined);
    const res = await metricsRoutes.request('/metrics/nonexistent/evaluations?period=7d');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid period', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=bad');
    expect(res.status).toBe(400);
  });

  it('returns 200 with rows, total, hasMore', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as MetricEvaluationsResponse;
    expect(body).toHaveProperty('rows');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('hasMore');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
  });

  it('total matches evaluation count', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d');
    const body = await res.json() as MetricEvaluationsResponse;
    expect(body.total).toBe(3);
  });

  it('filters by scoreLabel', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&scoreLabel=relevant');
    const body = await res.json() as MetricEvaluationsResponse;
    expect(body.total).toBe(1);
    expect(body.rows[0]!.label).toBe('relevant');
  });

  it('sorts score_asc correctly', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&sortBy=score_asc');
    const body = await res.json() as MetricEvaluationsResponse;
    const scores = body.rows.map((r) => r.score);
    expect(scores[0]!).toBeLessThanOrEqual(scores[scores.length - 1]!);
  });

  it('sorts score_desc correctly', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&sortBy=score_desc');
    const body = await res.json() as MetricEvaluationsResponse;
    const scores = body.rows.map((r) => r.score);
    expect(scores[0]!).toBeGreaterThanOrEqual(scores[scores.length - 1]!);
  });

  it('pagination with limit and offset', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&limit=2&offset=1');
    const body = await res.json() as MetricEvaluationsResponse;
    expect(body.rows).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it('hasMore is true when offset+limit < total', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&limit=1&offset=0');
    const body = await res.json() as MetricEvaluationsResponse;
    expect(body.hasMore).toBe(true);
  });

  it('row shape has required fields', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&limit=1');
    const body = await res.json() as MetricEvaluationsResponse;
    const row = body.rows[0];
    expect(row).toHaveProperty('score');
    expect(row).toHaveProperty('timestamp');
    expect(row).toHaveProperty('traceId');
    expect(row).toHaveProperty('evaluator');
    expect(row).toHaveProperty('label');
  });
});
