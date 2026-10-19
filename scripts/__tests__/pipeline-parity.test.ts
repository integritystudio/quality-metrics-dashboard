/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `/api/pipeline` is the dev route in development
 * and the `pipeline:<period>` KV key in production. The sync once called
 * `computePipelineView` inline in `computePeriodEntries`; the route did the same.
 * One fixture through both paths must now give the same value.
 */
import { describe, it, expect } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { pipelineRoutes } from '../../src/api/routes/pipeline.js';
import { evaluation } from './support/evaluations.js';
import { kvValue, serveParityFixture, syncEachTest } from './support/parity-fixture.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

// All timestamps on 2026-10-08 so they fall inside the 24h day-aligned window
// (dayStart(NOW - 24h) = dayStart(2026-10-08T12:00) = 2026-10-08T00:00Z).
// This ensures both the route's windowed read and the KV's between() return the same set.
const evaluations: EvaluationResult[] = [
  evaluation('r1', '2026-10-08T10:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.8 }),
  evaluation('r2', '2026-10-08T14:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.4 }),
  evaluation('c1', '2026-10-08T11:00:00.000Z', { evaluationName: 'coherence', scoreValue: 0.9 }),
];

const fixture = serveParityFixture({ evaluations });

describe('pipeline parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  const synced = syncEachTest(fixture, NOW);

  it.each(['24h', '7d', '30d'] as const)('writes for %s the value the dev route answers', async (period) => {
    const fromKv = kvValue(synced(), `pipeline:${period}`);

    const res = await pipelineRoutes.request(`/pipeline?period=${period}`);
    expect(res.status).toBe(200);
    const fromRoute = await res.json();

    expect(fromKv).toEqual(fromRoute);
  });
});
