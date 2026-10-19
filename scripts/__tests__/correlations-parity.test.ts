/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `/api/correlations` is the dev route in development
 * and the `correlations:<period>` KV key in production. The sync once computed
 * `computeCorrelationMatrix` inline in `computePeriodEntries`; the route did the same
 * independently. One fixture through both paths must now give the same value.
 */
import { describe, it, expect } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { correlationRoutes } from '../../src/api/routes/correlations.js';
import { evaluation } from './support/evaluations.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { kvValue, serveParityFixture, syncEachTest } from './support/parity-fixture.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

const evaluations: EvaluationResult[] = [
  evaluation('r1', '2026-10-08T10:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.8 }),
  evaluation('r2', '2026-10-07T10:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.6 }),
  evaluation('c1', '2026-10-08T11:00:00.000Z', { evaluationName: 'coherence', scoreValue: 0.9 }),
  evaluation('c2', '2026-10-07T11:00:00.000Z', { evaluationName: 'coherence', scoreValue: 0.7 }),
];

const fixture = serveParityFixture({ evaluations });

describe('correlations parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  const synced = syncEachTest(fixture, NOW);

  it.each(['24h', '7d', '30d'] as const)('writes for %s the value the dev route answers', async (period) => {
    const fromKv = kvValue(synced(), `correlations:${period}`);

    const res = await correlationRoutes.request(`/correlations?period=${period}`);
    expect(res.status).toBe(HttpStatus.Ok);
    const fromRoute = await res.json();

    expect(fromKv).toEqual(fromRoute);
  });
});
