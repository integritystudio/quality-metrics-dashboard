/**
 * API route tests: /api/coverage.
 *
 * Approach C — fixture HTTP server. The real data-loader and CloudBackend run;
 * computeCoverageMatrix receives an honest Map from loadEvaluationsByMetric.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

vi.mock('../api/parent/quality-visualization.js', () => ({
  computeCoverageMatrix: vi.fn(),
}));

import { coverageRoutes } from '../api/routes/coverage.js';
import { computeCoverageMatrix } from '../api/parent/quality-visualization.js';
import type { CoverageResponse, ErrorResponse } from './support/api-responses.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
});

describe('GET /coverage', () => {
  beforeEach(() => {
    vi.mocked(computeCoverageMatrix).mockReturnValue({
      metrics: [],
      inputs: [],
      counts: [],
      coveredThreshold: 1,
      partialThreshold: 0,
      overallCoveragePercent: 0,
    });
  });

  it('rejects invalid period with 400', async () => {
    const res = await coverageRoutes.request('/coverage?period=99d');
    expect(res.status).toBe(400);
  });

  it('rejects invalid inputKey with 400', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=invalid');
    expect(res.status).toBe(400);
    const body = await res.json() as ErrorResponse;
    expect(body.error).toContain('inputKey');
  });

  it('returns the columnar matrix the Worker also serves', async () => {
    vi.mocked(computeCoverageMatrix).mockReturnValue({
      metrics: ['relevance'],
      inputs: ['trace-1', 'trace-2'],
      counts: [[2, 0]],
      coveredThreshold: 1,
      partialThreshold: 0,
      overallCoveragePercent: 50,
    });

    const res = await coverageRoutes.request('/coverage?period=7d');

    expect(res.status).toBe(200);
    expect(await res.json() as CoverageResponse).toEqual({
      period: '7d',
      metrics: ['relevance'],
      inputs: ['trace-1', 'trace-2'],
      counts: [[2, 0]],
      coveredThreshold: 1,
      partialThreshold: 0,
      overallCoveragePercent: 50,
    });
  });

  it('does not ship the dense cell list that breached the KV value limit', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d');

    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('cells');
    expect(body).not.toHaveProperty('gaps');
  });

  it('accepts inputKey=traceId', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=traceId');
    expect(res.status).toBe(200);
  });

  it('accepts inputKey=sessionId', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=sessionId');
    expect(res.status).toBe(200);
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await coverageRoutes.request('/coverage?period=7d');
    expect(res.status).toBe(500);
  });
});
