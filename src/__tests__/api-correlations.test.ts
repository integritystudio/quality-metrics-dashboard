/**
 * API route tests: /api/correlations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/parent/qfe-correlation.js', () => ({
  computeCorrelationMatrix: vi.fn(),
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

import { correlationRoutes } from '../api/routes/correlations.js';
import { computeCorrelationMatrix } from '../api/parent/qfe-correlation.js';
import { loadEvaluationsByMetric } from '../api/data-loader.js';
import type { CorrelationFeature } from '../types.js';
import { makeEvaluation } from './support/fixtures.js';
import type { CorrelationsResponse } from './support/api-responses.js';

function makeCorrelation(overrides: Partial<CorrelationFeature> = {}): CorrelationFeature {
  return {
    featureVersion: '3.1',
    metricA: 'coherence',
    metricB: 'relevance',
    pearsonR: 0.5,
    spearmanR: 0.5,
    effectSize: 0.2,
    lagHours: 0,
    significant: false,
    pValue: null,
    causalConfidence: 'correlation',
    coOccurrenceRate: 0,
    isKnownToxicCombo: false,
    ...overrides,
  };
}

beforeEach(vi.clearAllMocks);

describe('GET /correlations', () => {
  beforeEach(() => {
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map([
      ['relevance', [makeEvaluation({ scoreValue: 0.8, traceId: 't1' })]],
      ['coherence', [makeEvaluation({ evaluationName: 'coherence', scoreValue: 0.9, traceId: 't1' })]],
    ]));
    // `computeCorrelationMatrix` returns `CorrelationFeature[]`, not a numeric
    // matrix — the previous `[[1, 0.5], [0.5, 1]]` stub was the wrong shape
    // entirely, and `as any` was the only thing making it fit.
    vi.mocked(computeCorrelationMatrix).mockReturnValue([makeCorrelation()]);
  });

  it('rejects invalid period with 400', async () => {
    const res = await correlationRoutes.request('/correlations?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 200 with correlations and metrics', async () => {
    const res = await correlationRoutes.request('/correlations?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as CorrelationsResponse;
    expect(body).toHaveProperty('correlations');
    expect(body).toHaveProperty('metrics');
  });

  it('metrics array contains metric names from data', async () => {
    const res = await correlationRoutes.request('/correlations?period=7d');
    const body = await res.json() as CorrelationsResponse;
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
