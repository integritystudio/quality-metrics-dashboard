/**
 * API route tests: /api/pipeline.
 *
 * Approach C — fixture HTTP server. The real data-loader and CloudBackend run;
 * computePipelineView receives an honest Map from loadEvaluationsByMetric.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

vi.mock('../api/parent/quality-visualization.js', () => ({
  computePipelineView: vi.fn(),
}));
vi.mock('../api/parent/quality-metrics.js', () => ({
  computeDashboardSummary: vi.fn(),
}));

import { pipelineRoutes } from '../api/routes/pipeline.js';
import { computePipelineView } from '../api/parent/quality-visualization.js';
import { computeDashboardSummary } from '../api/parent/quality-metrics.js';
import type { PipelineResult } from '../types.js';
import { makeDashboardSummary } from './support/fixtures.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

function makePipelineResult(): PipelineResult {
  return { stages: [], dropoffs: [], overallConversionPercent: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
});

describe('GET /pipeline', () => {
  beforeEach(() => {
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
      fixture.reset();
      vi.mocked(computeDashboardSummary).mockReturnValue(makeDashboardSummary({ metrics: [] }));
      vi.mocked(computePipelineView).mockReturnValue(makePipelineResult());
      const res = await pipelineRoutes.request(`/pipeline?period=${period}`);
      expect(res.status).toBe(200);
    }
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await pipelineRoutes.request('/pipeline?period=7d');
    expect(res.status).toBe(500);
  });
});
