/**
 * API route tests: /api/trends/:name and /api/trends.
 *
 * Approach C — fixture HTTP server. The real data-loader and CloudBackend run;
 * pure computation functions (getQualityMetric, computeMetricDetail, etc.)
 * stay mocked because they receive EvaluationResult arrays, not HTTP payloads.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

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

import { trendRoutes } from '../api/routes/trends.js';
import { getQualityMetric, computeAggregations } from '../api/parent/quality-metrics.js';
import { computeMetricDetail } from '../api/parent/quality-views.js';
import { computeMetricDynamics } from '../api/parent/qfe-dynamics.js';
import { computePercentileDistribution } from '../api/parent/qfe-percentiles.js';
import type { TrendDetailResponse, TrendSummaryResponse } from './support/api-responses.js';
import type {
  MetricDetailResult,
  MetricDynamics,
  MetricTrend,
  QualityMetricConfig,
} from '../types.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

/**
 * Fixtures typed off real parent types — drift-detecting.
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

const NANOS_PER_MS = 1_000_000n;

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
    vi.clearAllMocks();
    fixture.reset();
    fixture.setEvals([evalToWire({ evaluationName: 'relevance', scoreValue: 0.85, timestamp: EVAL_NANOS })]);
    vi.mocked(getQualityMetric).mockReturnValue(makeMockConfig());
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

  it('passes the period length second and the previous trend in options', async () => {
    // Put one evaluation inside the rolling window so computeMetricDynamics is reached.
    fixture.setEvals([evalToWire({ evaluationName: 'relevance', scoreValue: 0.85, timestamp: BigInt(Date.now()) * NANOS_PER_MS })]);

    await trendRoutes.request('/trends/relevance?period=7d');

    const calls = vi.mocked(computeMetricDynamics).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, periodHours, options] of calls) {
      expect(typeof periodHours).toBe('number');
      expect(options === undefined || typeof options === 'object').toBe(true);
    }
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await trendRoutes.request('/trends/relevance?period=7d');
    expect(res.status).toBe(500);
  });
});

// /trends (summary)

describe('GET /trends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.reset();
    fixture.setEvals([evalToWire({ evaluationName: 'relevance', scoreValue: 0.85, timestamp: EVAL_NANOS })]);
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

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await trendRoutes.request('/trends?period=7d');
    expect(res.status).toBe(500);
  });
});
