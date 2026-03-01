/**
 * API route tests: /api/coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../dist/lib/quality-metrics.js', () => ({
  computeCoverageHeatmap: vi.fn(),
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

import { coverageRoutes } from '../api/routes/coverage.js';
import { computeCoverageHeatmap } from '../../../dist/lib/quality-metrics.js';
import { loadEvaluationsByMetric } from '../api/data-loader.js';

beforeEach(vi.clearAllMocks);

describe('GET /coverage', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map() as any);
    vi.mocked(computeCoverageHeatmap).mockReturnValue({
      metrics: [],
      overallCoveragePercent: 0,
      totalInputs: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  it('rejects invalid period with 400', async () => {
    const res = await coverageRoutes.request('/coverage?period=99d');
    expect(res.status).toBe(400);
  });

  it('rejects invalid inputKey with 400', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=invalid');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('inputKey');
  });

  it('returns 200 with period and heatmap data', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('period');
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('overallCoveragePercent');
  });

  it('accepts inputKey=traceId', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=traceId');
    expect(res.status).toBe(200);
  });

  it('accepts inputKey=sessionId', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=sessionId');
    expect(res.status).toBe(200);
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByMetric).mockRejectedValue(new Error('fail'));
    const res = await coverageRoutes.request('/coverage?period=7d');
    expect(res.status).toBe(500);
  });
});
