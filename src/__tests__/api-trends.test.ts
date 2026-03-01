/**
 * API route tests: /api/trends/:name and /api/trends.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../dist/lib/quality-metrics.js', () => ({
  getQualityMetric: vi.fn(),
  computeMetricDetail: vi.fn(),
  computeAggregations: vi.fn(),
  QUALITY_METRICS: { relevance: { name: 'relevance' }, coherence: { name: 'coherence' } },
}));

vi.mock('../../../dist/lib/quality-feature-engineering.js', () => ({
  computePercentileDistribution: vi.fn(),
  computeMetricDynamics: vi.fn(),
}));

vi.mock('../../../dist/lib/error-sanitizer.js', () => ({
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
import { getQualityMetric, computeMetricDetail, computeAggregations } from '../../../dist/lib/quality-metrics.js';
import { computePercentileDistribution, computeMetricDynamics } from '../../../dist/lib/quality-feature-engineering.js';
import { loadEvaluationsForMetric } from '../api/data-loader.js';

beforeEach(vi.clearAllMocks);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockConfig() {
  return {
    name: 'relevance',
    displayName: 'Relevance',
    direction: 'above' as const,
    aggregations: ['avg'] as const,
    threshold: 0.7,
  };
}

function makeMockEval(timestamp = '2026-01-15T12:00:00.000Z', score = 0.85) {
  return {
    evaluationName: 'relevance',
    scoreValue: score,
    timestamp,
    traceId: 'trace-001',
    evaluatorType: 'seed',
  };
}

// ---------------------------------------------------------------------------
// /trends/:name
// ---------------------------------------------------------------------------

describe('GET /trends/:name', () => {
  beforeEach(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    vi.mocked(getQualityMetric).mockReturnValue(makeMockConfig() as any);
    vi.mocked(loadEvaluationsForMetric).mockResolvedValue([makeMockEval()] as any);
    vi.mocked(computePercentileDistribution).mockReturnValue({ p50: 0.85, p90: 0.95 } as any);
    vi.mocked(computeMetricDetail).mockReturnValue({ trend: [{ bucket: 0 }], aggregations: { avg: 0.85 } } as any);
    vi.mocked(computeAggregations).mockReturnValue({ avg: 0.85 } as any);
    vi.mocked(computeMetricDynamics).mockReturnValue({ velocity: 0 } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it('returns 404 for unknown metric', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getQualityMetric).mockReturnValue(undefined as any);
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
    const body = await res.json() as Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// /trends (summary)
// ---------------------------------------------------------------------------

describe('GET /trends', () => {
  beforeEach(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    vi.mocked(loadEvaluationsForMetric).mockResolvedValue([makeMockEval()] as any);
    vi.mocked(computePercentileDistribution).mockReturnValue({ p50: 0.85 } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it('returns 400 for invalid period', async () => {
    const res = await trendRoutes.request('/trends?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 200 with period and metrics array', async () => {
    const res = await trendRoutes.request('/trends?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('period', '7d');
    expect(body).toHaveProperty('metrics');
    expect(Array.isArray(body.metrics)).toBe(true);
  });

  it('each metric entry has name, count, percentiles', async () => {
    const res = await trendRoutes.request('/trends?period=7d');
    const body = await res.json() as { metrics: Array<Record<string, unknown>> };
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
