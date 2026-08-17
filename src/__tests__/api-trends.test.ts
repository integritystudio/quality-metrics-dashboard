/**
 * API route tests: /api/trends/:name and /api/trends.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/parent/quality-metrics.js', () => ({
  getQualityMetric: vi.fn(),
  computeAggregations: vi.fn(),
  QUALITY_METRICS: { relevance: { name: 'relevance' }, coherence: { name: 'coherence' } },
}));

vi.mock('../api/parent/quality-views.js', () => ({
  computeMetricDetail: vi.fn(),
}));

vi.mock('../api/parent/qfe-dynamics.js', () => ({
  computeMetricDynamics: vi.fn(),
}));
vi.mock('../api/parent/qfe-percentiles.js', () => ({
  computePercentileDistribution: vi.fn(),
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

import { trendRoutes } from '../api/routes/trends.js';
import { getQualityMetric, computeAggregations } from '../api/parent/quality-metrics.js';
import { computeMetricDetail } from '../api/parent/quality-views.js';
import { computeMetricDynamics } from '../api/parent/qfe-dynamics.js';
import { computePercentileDistribution } from '../api/parent/qfe-percentiles.js';
import { loadEvaluationsForMetric } from '../api/data-loader.js';
import type { TrendDetailResponse, TrendSummaryResponse } from './support/api-responses.js';
import type {
  EvaluationResult,
  MetricDetailResult,
  MetricDynamics,
  MetricTrend,
  QualityMetricConfig,
} from '../types.js';

beforeEach(vi.clearAllMocks);


/**
 * Fixtures are typed off the real signatures — `NonNullable<ReturnType<...>>`
 * for mock return values, so each one is exactly what the route consumes and a
 * parent shape change fails `npm run typecheck` here. Previously `as any`, and
 * drifted: `makeMockConfig` had `direction`/`threshold` (not on
 * `QualityMetricConfig`) and the `computeMetricDetail` stub returned
 * `{ trend: [...], aggregations }`, a shape `MetricDetailResult` never had.
 */
type Percentiles = NonNullable<ReturnType<typeof computePercentileDistribution>>;

const EVAL_NANOS = 1737000000000000000n;

function makeMockConfig(): QualityMetricConfig {
  return {
    name: 'relevance',
    displayName: 'Relevance',
    description: 'How relevant the response is',
    aggregations: ['avg'],
    alerts: [],
    range: { min: 0, max: 1 },
    unit: 'score',
  };
}

function makeMockEval(timestamp = EVAL_NANOS, score = 0.85): EvaluationResult {
  return {
    evaluationName: 'relevance',
    scoreValue: score,
    timestamp,
    traceId: 'trace-001',
    evaluatorType: 'seed',
  };
}

const MOCK_PERCENTILES: Percentiles = { p10: 0.7, p25: 0.8, p50: 0.85, p75: 0.9, p90: 0.95 };

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
    values: { avg: 0.85, min: null, max: null, count: 1, p50: null, p95: null, p99: null },
    sampleCount: 1,
    alerts: [],
    status: 'healthy',
    trend: MOCK_TREND,
    scoreDistribution: [],
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

// /trends/:name

describe('GET /trends/:name', () => {
  beforeEach(() => {
    vi.mocked(getQualityMetric).mockReturnValue(makeMockConfig());
    vi.mocked(loadEvaluationsForMetric).mockResolvedValue([makeMockEval()]);
    vi.mocked(computePercentileDistribution).mockReturnValue(MOCK_PERCENTILES);
    vi.mocked(computeMetricDetail).mockReturnValue(makeMockDetail());
    vi.mocked(computeAggregations).mockReturnValue(makeMockDetail().values);
    vi.mocked(computeMetricDynamics).mockReturnValue(MOCK_DYNAMICS);
  });

  it('returns 404 for unknown metric', async () => {
    vi.mocked(getQualityMetric).mockReturnValue(undefined);
    const res = await trendRoutes.request('/trends/nonexistent?period=7d');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid period', async () => {
    const res = await trendRoutes.request('/trends/relevance?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid buckets', async () => {
    const res = await trendRoutes.request('/trends/relevance?period=7d&buckets=2');
    expect(res.status).toBe(400);
  });

  it('returns 400 for buckets > 30', async () => {
    const res = await trendRoutes.request('/trends/relevance?period=7d&buckets=31');
    expect(res.status).toBe(400);
  });

  it('returns 200 with expected response shape', async () => {
    const res = await trendRoutes.request('/trends/relevance?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as TrendDetailResponse;
    expect(body).toHaveProperty('metric', 'relevance');
    expect(body).toHaveProperty('period', '7d');
    expect(body).toHaveProperty('bucketCount');
    expect(body).toHaveProperty('totalEvaluations');
    expect(body).toHaveProperty('trendData');
    expect(body).toHaveProperty('overallPercentiles');
  });

  it('accepts valid bucket counts', async () => {
    for (const buckets of [3, 7, 15, 30]) {
      const res = await trendRoutes.request(`/trends/relevance?period=7d&buckets=${buckets}`);
      expect(res.status).toBe(200);
    }
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsForMetric).mockRejectedValue(new Error('fail'));
    const res = await trendRoutes.request('/trends/relevance?period=7d');
    expect(res.status).toBe(500);
  });
});

// /trends (summary)

describe('GET /trends', () => {
  beforeEach(() => {
    vi.mocked(loadEvaluationsForMetric).mockResolvedValue([makeMockEval()]);
    vi.mocked(computePercentileDistribution).mockReturnValue(MOCK_PERCENTILES);
  });

  it('returns 400 for invalid period', async () => {
    const res = await trendRoutes.request('/trends?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 200 with period and metrics array', async () => {
    const res = await trendRoutes.request('/trends?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as TrendSummaryResponse;
    expect(body).toHaveProperty('period', '7d');
    expect(body).toHaveProperty('metrics');
    expect(Array.isArray(body.metrics)).toBe(true);
  });

  it('each metric entry has name, count, percentiles', async () => {
    const res = await trendRoutes.request('/trends?period=7d');
    const body = await res.json() as TrendSummaryResponse;
    for (const m of body.metrics) {
      expect(m).toHaveProperty('metric');
      expect(m).toHaveProperty('count');
      expect(m).toHaveProperty('percentiles');
    }
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsForMetric).mockRejectedValue(new Error('fail'));
    const res = await trendRoutes.request('/trends?period=7d');
    expect(res.status).toBe(500);
  });
});
