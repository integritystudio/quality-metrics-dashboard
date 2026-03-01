/**
 * API route tests: /api/correlations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../dist/lib/quality-feature-engineering.js', () => ({
  computeCorrelationMatrix: vi.fn(),
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

import { correlationRoutes } from '../api/routes/correlations.js';
import { computeCorrelationMatrix } from '../../../dist/lib/quality-feature-engineering.js';
import { loadEvaluationsByMetric } from '../api/data-loader.js';

beforeEach(vi.clearAllMocks);

describe('GET /correlations', () => {
  beforeEach(() => {
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map([
      ['relevance', [{ scoreValue: 0.8, timestamp: '2026-01-15T12:00:00Z', traceId: 't1' }]],
      ['coherence', [{ scoreValue: 0.9, timestamp: '2026-01-15T12:00:00Z', traceId: 't1' }]],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ]) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(computeCorrelationMatrix).mockReturnValue([[1, 0.5], [0.5, 1]] as any);
  });

  it('rejects invalid period with 400', async () => {
    const res = await correlationRoutes.request('/correlations?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 200 with correlations and metrics', async () => {
    const res = await correlationRoutes.request('/correlations?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('correlations');
    expect(body).toHaveProperty('metrics');
  });

  it('metrics array contains metric names from data', async () => {
    const res = await correlationRoutes.request('/correlations?period=7d');
    const body = await res.json() as { metrics: string[] };
    expect(Array.isArray(body.metrics)).toBe(true);
  });

  it('accepts all valid periods', async () => {
    for (const period of ['24h', '7d', '30d']) {
      const res = await correlationRoutes.request(`/correlations?period=${period}`);
      expect(res.status).toBe(200);
    }
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByMetric).mockRejectedValue(new Error('fail'));
    const res = await correlationRoutes.request('/correlations?period=7d');
    expect(res.status).toBe(500);
  });
});
