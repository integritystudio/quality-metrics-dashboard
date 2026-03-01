/**
 * API route tests: /api/evaluations/trace/:traceId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { evaluationRoutes } from '../api/routes/evaluations.js';
import { loadEvaluationsByTraceId } from '../api/data-loader.js';

beforeEach(vi.clearAllMocks);

describe('GET /evaluations/trace/:traceId', () => {
  beforeEach(() => {
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([]);
  });

  it('returns 200 with evaluations array for valid traceId', async () => {
    const res = await evaluationRoutes.request('/evaluations/trace/abc-123');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('evaluations');
    expect(Array.isArray(body.evaluations)).toBe(true);
  });

  it('returns evaluations from data-loader', async () => {
    const mockEvals = [
      { evaluationName: 'relevance', scoreValue: 0.85, traceId: 'abc-123' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue(mockEvals as any);

    const res = await evaluationRoutes.request('/evaluations/trace/abc-123');
    const body = await res.json() as { evaluations: unknown[] };
    expect(body.evaluations).toHaveLength(1);
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByTraceId).mockRejectedValue(new Error('fail'));
    const res = await evaluationRoutes.request('/evaluations/trace/abc-123');
    expect(res.status).toBe(500);
  });
});
