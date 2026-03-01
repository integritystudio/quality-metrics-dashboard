/**
 * API route tests: /api/pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../dist/lib/quality-metrics.js', () => ({
  computePipelineView: vi.fn(),
  computeDashboardSummary: vi.fn(),
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

import { pipelineRoutes } from '../api/routes/pipeline.js';
import { computePipelineView, computeDashboardSummary } from '../../../dist/lib/quality-metrics.js';
import { loadEvaluationsByMetric } from '../api/data-loader.js';

beforeEach(vi.clearAllMocks);

describe('GET /pipeline', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(computeDashboardSummary).mockReturnValue({ metrics: [], overallStatus: 'healthy' } as any);
    vi.mocked(computePipelineView).mockReturnValue({
      stages: [],
      totalInput: 0,
      totalOutput: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  it('rejects invalid period with 400', async () => {
    const res = await pipelineRoutes.request('/pipeline?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 200 with period and pipeline data', async () => {
    const res = await pipelineRoutes.request('/pipeline?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('period');
    expect(body).toHaveProperty('stages');
  });

  it('calls computeDashboardSummary then computePipelineView', async () => {
    await pipelineRoutes.request('/pipeline?period=7d');
    expect(vi.mocked(computeDashboardSummary)).toHaveBeenCalled();
    expect(vi.mocked(computePipelineView)).toHaveBeenCalled();
  });

  it('accepts all valid periods', async () => {
    for (const period of ['24h', '7d', '30d']) {
      vi.clearAllMocks();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map() as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(computeDashboardSummary).mockReturnValue({ metrics: [] } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(computePipelineView).mockReturnValue({ stages: [] } as any);
      const res = await pipelineRoutes.request(`/pipeline?period=${period}`);
      expect(res.status).toBe(200);
    }
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByMetric).mockRejectedValue(new Error('fail'));
    const res = await pipelineRoutes.request('/pipeline?period=7d');
    expect(res.status).toBe(500);
  });
});
