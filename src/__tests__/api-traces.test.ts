/**
 * API route tests: /api/traces/:traceId.
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

import { traceRoutes } from '../api/routes/traces.js';
import { loadTracesByTraceId, loadEvaluationsByTraceId } from '../api/data-loader.js';

beforeEach(vi.clearAllMocks);

describe('GET /traces/:traceId', () => {
  beforeEach(() => {
    vi.mocked(loadTracesByTraceId).mockResolvedValue([]);
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([]);
  });

  it('returns 200 with traceId, spans, evaluations', async () => {
    const res = await traceRoutes.request('/traces/trace-abc-123');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('traceId', 'trace-abc-123');
    expect(body).toHaveProperty('spans');
    expect(body).toHaveProperty('evaluations');
  });

  it('returns spans and evaluations from data-loader', async () => {
    const mockSpan = { traceId: 'trace-abc-123', spanId: 's1', name: 'test' };
    const mockEval = { evaluationName: 'relevance', scoreValue: 0.9 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadTracesByTraceId).mockResolvedValue([mockSpan] as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([mockEval] as any);

    const res = await traceRoutes.request('/traces/trace-abc-123');
    const body = await res.json() as { spans: unknown[]; evaluations: unknown[] };
    expect(body.spans).toHaveLength(1);
    expect(body.evaluations).toHaveLength(1);
  });

  it('loads spans and evaluations in parallel', async () => {
    await traceRoutes.request('/traces/trace-abc-123');
    expect(vi.mocked(loadTracesByTraceId)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadEvaluationsByTraceId)).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when loadTracesByTraceId throws', async () => {
    vi.mocked(loadTracesByTraceId).mockRejectedValue(new Error('fail'));
    const res = await traceRoutes.request('/traces/trace-abc-123');
    expect(res.status).toBe(500);
  });

  it('returns 500 when loadEvaluationsByTraceId throws', async () => {
    vi.mocked(loadEvaluationsByTraceId).mockRejectedValue(new Error('fail'));
    const res = await traceRoutes.request('/traces/trace-abc-123');
    expect(res.status).toBe(500);
  });
});
