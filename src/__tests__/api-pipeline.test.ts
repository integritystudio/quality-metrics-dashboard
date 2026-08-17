/**
 * API route tests: /api/pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/parent/quality-visualization.js', () => ({
  computePipelineView: vi.fn(),
}));
vi.mock('../api/parent/quality-metrics.js', () => ({
  computeDashboardSummary: vi.fn(),
}));

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

import { pipelineRoutes } from '../api/routes/pipeline.js';
import { computePipelineView } from '../api/parent/quality-visualization.js';
import { computeDashboardSummary } from '../api/parent/quality-metrics.js';
import { loadEvaluationsByMetric } from '../api/data-loader.js';
import type { PipelineResult } from '../types.js';
import { makeDashboardSummary } from './support/fixtures.js';

function makePipelineResult(): PipelineResult {
  return { stages: [], dropoffs: [], overallConversionPercent: 0 };
}

beforeEach(vi.clearAllMocks);

describe('GET /pipeline', () => {
  beforeEach(() => {
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map());
    vi.mocked(computeDashboardSummary).mockReturnValue(makeDashboardSummary({ metrics: [] }));
    vi.mocked(computePipelineView).mockReturnValue(makePipelineResult());
  });

  it('rejects invalid period with 400', async () => {
    const res = await pipelineRoutes.request('/pipeline?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 200 with period and pipeline data', async () => {
    const res = await pipelineRoutes.request('/pipeline?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json();
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
      vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map());
      vi.mocked(computeDashboardSummary).mockReturnValue(makeDashboardSummary({ metrics: [] }));
      vi.mocked(computePipelineView).mockReturnValue(makePipelineResult());
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
