/**
 * API route tests: /api/evaluations/trace/:traceId.
 *
 * Approach C — fixture HTTP server in place of vi.mock, so CloudBackend's
 * query path and the real data-loader run end-to-end. A test run with
 * OBTOOL_API_URL unset fails loudly (CloudBackend constructor throws).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';
import { evaluationRoutes } from '../api/routes/evaluations.js';
import type { TraceEvaluationsResponse } from './support/api-responses.js';
import { makeEvaluation } from './support/fixtures.js';

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

describe('GET /evaluations/trace/:traceId', () => {
  it('returns 200 with evaluations array for valid traceId', async () => {
    const res = await evaluationRoutes.request('/evaluations/trace/abc-123');
    expect(res.status).toBe(200);
    const body = await res.json() as TraceEvaluationsResponse;
    expect(body).toHaveProperty('evaluations');
    expect(Array.isArray(body.evaluations)).toBe(true);
  });

  it('returns evaluations from data-loader', async () => {
    fixture.setEvals([evalToWire(makeEvaluation({ traceId: 'abc-123' }))]);

    const res = await evaluationRoutes.request('/evaluations/trace/abc-123');
    const body = await res.json() as TraceEvaluationsResponse;
    expect(body.evaluations).toHaveLength(1);
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await evaluationRoutes.request('/evaluations/trace/abc-123');
    expect(res.status).toBe(500);
  });
});
