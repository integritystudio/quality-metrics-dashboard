/**
 * API route tests: /api/compliance/sla and /api/compliance/verifications.
 *
 * Approach C — fixture HTTP server for the evaluations path (SLA). The
 * verification-events module stays mocked because loadVerifications reads
 * local JSONL files (not HTTP), which cannot be replaced by a stub server.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

vi.mock('../api/parent/quality-metrics.js', () => ({
  computeDashboardSummary: vi.fn(),
}));

// Mocked because loadVerifications reads local JSONL files (not HTTP).
vi.mock('../api/parent/verification-events.js', () => ({
  queryVerifications: vi.fn().mockResolvedValue([]),
}));

import { complianceRoutes } from '../api/routes/compliance.js';
import { computeDashboardSummary } from '../api/parent/quality-metrics.js';
import { queryVerifications } from '../api/parent/verification-events.js';
import type { SlaComplianceResponse, VerificationsResponse } from './support/api-responses.js';
import type { HumanVerificationEvent } from '../types.js';
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

function makeVerification(sessionId: string): HumanVerificationEvent {
  return {
    timestamp: '2026-01-15T12:00:00.000Z',
    sessionId,
    verificationType: 'approval',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
  vi.mocked(queryVerifications).mockResolvedValue([]);
});

// /compliance/sla

describe('GET /compliance/sla', () => {
  beforeEach(() => {
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
    fixture.failPath('/v1/evaluations');
    const res = await complianceRoutes.request('/compliance/sla?period=7d');
    expect(res.status).toBe(500);
  });
});

// /compliance/verifications

describe('GET /compliance/verifications', () => {
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
    vi.mocked(queryVerifications).mockResolvedValue([makeVerification('sess-1'), makeVerification('sess-2')]);
    const res = await complianceRoutes.request('/compliance/verifications?period=7d');
    const body = await res.json() as VerificationsResponse;
    expect(body.count).toBe(2);
  });

  it('returns 500 when loadVerifications throws', async () => {
    vi.mocked(queryVerifications).mockRejectedValue(new Error('fail'));
    const res = await complianceRoutes.request('/compliance/verifications?period=7d');
    expect(res.status).toBe(500);
  });
});
