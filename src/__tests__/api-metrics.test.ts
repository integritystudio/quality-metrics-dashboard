/**
 * API route tests: /api/metrics/:name and /api/metrics/:name/evaluations.
 * Approach A — Node routes with mocked data-loader and dist dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../dist/lib/quality-metrics.js', () => ({
  getQualityMetric: vi.fn(),
  computeMetricDetail: vi.fn(),
  computeAggregations: vi.fn(),
}));

vi.mock('../../../dist/lib/quality-feature-engineering.js', () => ({
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

import { metricsRoutes } from '../api/routes/metrics.js';
import { getQualityMetric, computeMetricDetail, computeAggregations } from '../../../dist/lib/quality-metrics.js';
import { computeMetricDynamics } from '../../../dist/lib/quality-feature-engineering.js';
import { loadEvaluationsForMetric } from '../api/data-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockConfig() {
  return {
    name: 'relevance',
    displayName: 'Relevance',
    description: 'How relevant the response is',
    direction: 'above' as const,
    aggregations: ['avg', 'min', 'p10'] as const,
    threshold: 0.7,
  };
}

function makeMockEval(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    evaluationName: 'relevance',
    scoreValue: 0.85,
    timestamp: '2026-01-15T12:00:00.000Z',
    traceId: 'trace-001',
    evaluatorType: 'seed',
    scoreLabel: 'relevant',
    explanation: 'Response is relevant.',
    evaluator: 'seed-evaluator',
    spanId: 'span-001',
    sessionId: 'sess-001',
    agentName: 'general-purpose',
    trajectoryLength: 3,
    stepScores: null,
    toolVerifications: null,
    ...overrides,
  };
}

function makeMockDetail() {
  return {
    config: makeMockConfig(),
    evaluations: [makeMockEval()],
    aggregations: { avg: 0.85, min: 0.7, p10: 0.72 },
    distribution: [],
    trend: [{ bucket: 0, avg: 0.85, count: 1 }],
    worstEvaluations: [],
  };
}

// ---------------------------------------------------------------------------
// /metrics/:name route
// ---------------------------------------------------------------------------

describe('GET /metrics/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    vi.mocked(getQualityMetric).mockReturnValue(makeMockConfig() as any);
    vi.mocked(loadEvaluationsForMetric).mockResolvedValue([makeMockEval()] as any);
    vi.mocked(computeAggregations).mockReturnValue({ avg: 0.85 } as any);
    vi.mocked(computeMetricDetail).mockReturnValue(makeMockDetail() as any);
    vi.mocked(computeMetricDynamics).mockReturnValue({ velocity: 0, acceleration: 0, variance: 0.01 } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it('returns 404 for unknown metric', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getQualityMetric).mockReturnValue(undefined as any);
    const res = await metricsRoutes.request('/metrics/nonexistent?period=7d');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('error');
  });

  it('returns 400 for invalid period', async () => {
    const res = await metricsRoutes.request('/metrics/relevance?period=99d');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
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
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('config');
    expect(body).toHaveProperty('aggregations');
    expect(body).toHaveProperty('trend');
  });

  it('calls loadEvaluationsForMetric twice (current + previous period)', async () => {
    await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(vi.mocked(loadEvaluationsForMetric)).toHaveBeenCalledTimes(2);
  });

  it('includes dynamics when trend is present', async () => {
    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('dynamics');
  });

  it('omits dynamics when trend is absent', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(computeMetricDetail).mockReturnValue({ ...makeMockDetail(), trend: undefined } as any);

    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.dynamics).toBeUndefined();
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsForMetric).mockRejectedValue(new Error('disk error'));
    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// /metrics/:name/evaluations route
// ---------------------------------------------------------------------------

describe('GET /metrics/:name/evaluations', () => {
  const evals = [
    makeMockEval({ scoreValue: 0.9, timestamp: '2026-01-15T23:00:00.000Z', scoreLabel: 'relevant' }),
    makeMockEval({ scoreValue: 0.6, timestamp: '2026-01-15T22:00:00.000Z', scoreLabel: 'partial' }),
    makeMockEval({ scoreValue: 0.3, timestamp: '2026-01-15T21:00:00.000Z', scoreLabel: 'irrelevant' }),
  ];

  beforeEach(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    vi.mocked(getQualityMetric).mockReturnValue(makeMockConfig() as any);
    // Spread to prevent route's in-place sort from mutating the shared array
    vi.mocked(loadEvaluationsForMetric).mockResolvedValue([...evals] as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it('returns 404 for unknown metric', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getQualityMetric).mockReturnValue(undefined as any);
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
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('rows');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('hasMore');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
  });

  it('total matches evaluation count', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d');
    const body = await res.json() as { total: number; rows: unknown[] };
    expect(body.total).toBe(3);
  });

  it('filters by scoreLabel', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&scoreLabel=relevant');
    const body = await res.json() as { rows: Array<{ label: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.rows[0].label).toBe('relevant');
  });

  it('sorts score_asc correctly', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&sortBy=score_asc');
    const body = await res.json() as { rows: Array<{ score: number }> };
    const scores = body.rows.map(r => r.score);
    expect(scores[0]).toBeLessThanOrEqual(scores[scores.length - 1]);
  });

  it('sorts score_desc correctly', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&sortBy=score_desc');
    const body = await res.json() as { rows: Array<{ score: number }> };
    const scores = body.rows.map(r => r.score);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[scores.length - 1]);
  });

  it('pagination with limit and offset', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&limit=2&offset=1');
    const body = await res.json() as { rows: unknown[]; total: number; hasMore: boolean };
    expect(body.rows).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it('hasMore is true when offset+limit < total', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&limit=1&offset=0');
    const body = await res.json() as { hasMore: boolean };
    expect(body.hasMore).toBe(true);
  });

  it('row shape has required fields', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&limit=1');
    const body = await res.json() as { rows: Array<Record<string, unknown>> };
    const row = body.rows[0];
    expect(row).toHaveProperty('score');
    expect(row).toHaveProperty('timestamp');
    expect(row).toHaveProperty('traceId');
    expect(row).toHaveProperty('evaluator');
    expect(row).toHaveProperty('label');
  });
});
