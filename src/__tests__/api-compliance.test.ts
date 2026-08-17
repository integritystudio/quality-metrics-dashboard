/**
 * API route tests: /api/compliance/sla and /api/compliance/verifications.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { complianceRoutes } from '../api/routes/compliance.js';
import { computeDashboardSummary } from '../api/parent/quality-metrics.js';
import { loadEvaluationsByMetric, loadVerifications } from '../api/data-loader.js';
import type { SlaComplianceResponse, VerificationsResponse } from './support/api-responses.js';
import type { HumanVerificationEvent } from '../types.js';
import { makeDashboardSummary } from './support/fixtures.js';

// `HumanVerificationEvent` has no `id` field — the previous `[{ id: 'v1' }]`
// stub was pure invention held up by `as any`.
function makeVerification(sessionId: string): HumanVerificationEvent {
  return {
    timestamp: '2026-01-15T12:00:00.000Z',
    sessionId,
    verificationType: 'approval',
  };
}

beforeEach(vi.clearAllMocks);

// /compliance/sla

describe('GET /compliance/sla', () => {
  beforeEach(() => {
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map());
    vi.mocked(computeDashboardSummary).mockReturnValue(makeDashboardSummary({ metrics: [] }));
  });

  it('rejects invalid period with 400', async () => {
    const res = await complianceRoutes.request('/compliance/sla?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 200 with period, results, noSLAsConfigured', async () => {
    const res = await complianceRoutes.request('/compliance/sla?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as SlaComplianceResponse;
    expect(body).toHaveProperty('period');
    expect(body).toHaveProperty('results');
    expect(body).toHaveProperty('noSLAsConfigured');
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByMetric).mockRejectedValue(new Error('disk'));
    const res = await complianceRoutes.request('/compliance/sla?period=7d');
    expect(res.status).toBe(500);
  });
});

// /compliance/verifications

describe('GET /compliance/verifications', () => {
  beforeEach(() => {
    vi.mocked(loadVerifications).mockResolvedValue([]);
  });

  it('rejects invalid period with 400', async () => {
    const res = await complianceRoutes.request('/compliance/verifications?period=bad');
    expect(res.status).toBe(400);
  });

  it('returns 200 with period, count, verifications', async () => {
    const res = await complianceRoutes.request('/compliance/verifications?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as VerificationsResponse;
    expect(body).toHaveProperty('period');
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('verifications');
  });

  it('returns correct count for non-empty verifications', async () => {
    vi.mocked(loadVerifications).mockResolvedValue([makeVerification('sess-1'), makeVerification('sess-2')]);
    const res = await complianceRoutes.request('/compliance/verifications?period=7d');
    const body = await res.json() as VerificationsResponse;
    expect(body.count).toBe(2);
  });

  it('returns 500 when loadVerifications throws', async () => {
    vi.mocked(loadVerifications).mockRejectedValue(new Error('fail'));
    const res = await complianceRoutes.request('/compliance/verifications?period=7d');
    expect(res.status).toBe(500);
  });
});
