/**
 * API route tests: /api/evaluations/trace/:traceId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { evaluationRoutes } from '../api/routes/evaluations.js';
import { loadEvaluationsByTraceId } from '../api/data-loader.js';
import type { TraceEvaluationsResponse } from './support/api-responses.js';
import { makeEvaluation } from './support/fixtures.js';

beforeEach(vi.clearAllMocks);

describe('GET /evaluations/trace/:traceId', () => {
  beforeEach(() => {
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([]);
  });

  it('returns 200 with evaluations array for valid traceId', async () => {
    const res = await evaluationRoutes.request('/evaluations/trace/abc-123');
    expect(res.status).toBe(200);
    const body = await res.json() as TraceEvaluationsResponse;
    expect(body).toHaveProperty('evaluations');
    expect(Array.isArray(body.evaluations)).toBe(true);
  });

  it('returns evaluations from data-loader', async () => {
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([
      makeEvaluation({ scoreValue: 0.85, traceId: 'abc-123' }),
    ]);

    const res = await evaluationRoutes.request('/evaluations/trace/abc-123');
    const body = await res.json() as TraceEvaluationsResponse;
    expect(body.evaluations).toHaveLength(1);
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByTraceId).mockRejectedValue(new Error('fail'));
    const res = await evaluationRoutes.request('/evaluations/trace/abc-123');
    expect(res.status).toBe(500);
  });
});
