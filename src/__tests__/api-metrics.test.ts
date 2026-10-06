/**
 * API route tests: /api/metrics/:name and /api/metrics/:name/evaluations.
 *
 * Approach C — fixture HTTP server. The real data-loader and CloudBackend run,
 * and so do the parent's metric registry, aggregation, detail and dynamics
 * computations.
 *
 * The fixture ignores the date window, so `/metrics/:name`'s current- and
 * previous-period loads receive the same rows: with data the trend is `stable`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

import { metricsRoutes } from '../api/routes/metrics.js';
import type { ErrorResponse, MetricDetailResponse, MetricEvaluationsResponse } from './support/api-responses.js';
import type { EvaluationResult } from '../types.js';

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
const EVAL_NANOS = 1737000000000000000n;
const ONE_HOUR_NANOS = 3_600_000_000_000n;

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

// /metrics/:name route

describe('GET /metrics/:name', () => {
  beforeEach(() => {
    fixture.reset();
    fixture.setEvals([evalToWire(makeMockEval())]);
  });

  it('returns 404 for unknown metric', async () => {
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
    expect(body).toHaveProperty('name', 'relevance');
    expect(body).toHaveProperty('values');
    expect(body).toHaveProperty('sampleCount');
    expect(body.values.avg).toBeCloseTo(0.85, 3);
    expect(body.sampleCount).toBe(1);
  });

  it('includes dynamics with a numeric velocity when trend is present', async () => {
    // A velocity of null is what the route returned in production while it
    // passed the previous trend where computeMetricDynamics takes the period length.
    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as MetricDetailResponse;
    expect(body.trend?.direction).toBe('stable');
    expect(typeof body.dynamics?.velocity).toBe('number');
  });

  it('omits trend and dynamics when there is no data', async () => {
    fixture.reset();
    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as MetricDetailResponse;
    expect(body.sampleCount).toBe(0);
    expect(body.trend).toBeUndefined();
    expect(body.dynamics).toBeUndefined();
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await metricsRoutes.request('/metrics/relevance?period=7d');
    expect(res.status).toBe(500);
  });
});

// /metrics/:name/evaluations route

describe('GET /metrics/:name/evaluations', () => {
  // Descending timestamps, one hour apart.
  const evals = [
    makeMockEval({ scoreValue: 0.9, timestamp: EVAL_NANOS + ONE_HOUR_NANOS * 2n, scoreLabel: 'relevant' }),
    makeMockEval({ scoreValue: 0.6, timestamp: EVAL_NANOS + ONE_HOUR_NANOS, scoreLabel: 'partial' }),
    makeMockEval({ scoreValue: 0.3, timestamp: EVAL_NANOS, scoreLabel: 'irrelevant' }),
  ];

  beforeEach(() => {
    fixture.reset();
    fixture.setEvals(evals.map((e, i) => evalToWire(e, i + 1)));
  });

  it('returns 404 for unknown metric', async () => {
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
    expect(body.rows.map((r) => r.score)).toEqual([0.3, 0.6, 0.9]);
  });

  it('sorts score_desc correctly', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&sortBy=score_desc');
    const body = await res.json() as MetricEvaluationsResponse;
    expect(body.rows.map((r) => r.score)).toEqual([0.9, 0.6, 0.3]);
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
