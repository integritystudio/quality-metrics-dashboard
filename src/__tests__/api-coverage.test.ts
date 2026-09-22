/**
 * API route tests: /api/coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/parent/quality-visualization.js', () => ({
  computeCoverageMatrix: vi.fn(),
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

import { coverageRoutes } from '../api/routes/coverage.js';
import { computeCoverageMatrix } from '../api/parent/quality-visualization.js';
import { loadEvaluationsByMetric } from '../api/data-loader.js';
import type { CoverageResponse, ErrorResponse } from './support/api-responses.js';

beforeEach(vi.clearAllMocks);

describe('GET /coverage', () => {
  beforeEach(() => {
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map());
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

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByMetric).mockRejectedValue(new Error('fail'));
    const res = await coverageRoutes.request('/coverage?period=7d');
    expect(res.status).toBe(500);
  });
});
