/**
 * API route tests: /api/correlations.
 *
 * Approach C — fixture HTTP server. The real data-loader (isoToNs, grouping
 * by evaluationName) runs against CloudBackend pointing at the local fixture,
 * and the real computeCorrelationMatrix correlates what it loads.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

import { correlationRoutes } from '../api/routes/correlations.js';
import { makeEvaluation } from './support/fixtures.js';
import type { CorrelationsResponse } from './support/api-responses.js';

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
  fixture.reset();
});

describe('GET /correlations', () => {
  beforeEach(() => {
    fixture.setEvals([
      evalToWire(makeEvaluation({ evaluationName: 'relevance', scoreValue: 0.8, traceId: 't1' }), 1),
      evalToWire(makeEvaluation({ evaluationName: 'coherence', scoreValue: 0.9, traceId: 't1' }), 2),
    ]);
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
    expect([...body.metrics].sort()).toEqual(['coherence', 'relevance']);
  });

  it('correlates each metric pair once, in name order', async () => {
    const res = await correlationRoutes.request('/correlations?period=7d');
    const body = await res.json() as CorrelationsResponse;
    expect(body.correlations).toHaveLength(1);
    expect(body.correlations[0]).toMatchObject({ metricA: 'coherence', metricB: 'relevance' });
  });

  it('returns no correlations when there is no data', async () => {
    fixture.reset();
    const res = await correlationRoutes.request('/correlations?period=7d');
    const body = await res.json() as CorrelationsResponse;
    expect(body).toEqual({ correlations: [], metrics: [] });
  });

  it('accepts all valid periods', async () => {
    for (const period of ['24h', '7d', '30d']) {
      fixture.reset();
      const res = await correlationRoutes.request(`/correlations?period=${period}`);
      expect(res.status).toBe(200);
    }
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await correlationRoutes.request('/correlations?period=7d');
    expect(res.status).toBe(500);
  });
});
